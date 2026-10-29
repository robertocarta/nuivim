// One tab: its Neovim's UI state, its renderer and its screen element.

import { FALLBACK_MONO_FONT, FALLBACK_MONO_SIZE, mergeConfig, type Config } from './config';
import { attachMouse } from './input/mouse';
import { cssFamily, parseGuifont } from './model/guifont';
import { UiState } from './model/state';
import { tabTitle } from './model/tabs';
import { layerConfig } from './settings';
import type { ExitInfo, StartError, Transport } from './transport';
import { measure, type Fonts, type Metrics } from './view/metrics';
import { Renderer } from './view/renderer';

/** Filetype, buftype and gutter width for each window, in one round trip. */
const WININFO_LUA = `
local out = {}
for _, w in ipairs(...) do
  if vim.api.nvim_win_is_valid(w) then
    local b = vim.api.nvim_win_get_buf(w)
    local info = vim.fn.getwininfo(w)[1]
    out[#out + 1] = {
      w,
      vim.api.nvim_get_option_value('filetype', { buf = b }),
      vim.api.nvim_get_option_value('buftype', { buf = b }),
      info and info.textoff or 0,
    }
  end
end
return out`;

// :drop takes a file list, so each path is escaped as one list item (spaces, %, #).
const DROP_LUA = "vim.api.nvim_cmd({ cmd = 'drop', args = { vim.fn.fnameescape(...) } }, {})";

const QUIET = new Set(['nvim_command', 'nvim_ui_set_focus', 'nvim_ui_try_resize']);

/** What a session needs from the app around it. */
export interface SessionHost {
  appearance(): Partial<Config>;
  /** Font size change from Cmd-= / Cmd-- (points, for every tab). */
  sizeDelta(): number;
  /** Size of the area the screen fills, in CSS pixels. */
  area(): { width: number; height: number };
  focusInput(): void;
  /** The tab's title or the active tab's cursor moved. */
  changed(session: Session): void;
  /** Neovim quit normally: close the tab. */
  exited(session: Session): void;
}

export class Session {
  readonly state = new UiState();
  readonly screen = document.createElement('div');
  readonly renderer: Renderer;
  config: Config = mergeConfig(undefined).config;
  metrics: Metrics;
  /** The tab's vim.g.nuivim, as last sent by the bridge. */
  nvimConfig: unknown = undefined;
  overridden: (keyof Config)[] = [];
  title = '';
  started = false;
  dead = false;
  private bufname = '';
  private cwd = '';
  private sentSize = '';

  constructor(
    readonly id: number,
    private readonly transport: Transport,
    private readonly host: SessionHost,
  ) {
    this.state.log = (m) => console.debug(m);
    this.screen.className = 'screen';
    this.screen.dataset.tab = String(id);
    this.config = layerConfig(host.appearance(), undefined).config;
    this.metrics = measure(this.fonts());
    this.renderer = new Renderer(this.screen, this.metrics, this.config);
    attachMouse(this.screen, {
      enabled: () => this.state.mouseOn && !this.dead,
      hitTest: (x, y) => this.renderer.hitTest(x, y, this.state),
      send: (button, action, modifier, hit) => this.transport.inputMouse(this.id, button, action, modifier, hit.grid, hit.row, hit.col),
      cell: () => this.metrics,
      focus: () => this.host.focusInput(),
    });
  }

  private fonts(): Fonts {
    const gf = parseGuifont(this.state.options.guifont);
    const c = this.config;
    const delta = this.host.sizeDelta();
    return {
      monoFamily: (c.mono_font ? cssFamily(c.mono_font) : (gf.family ?? cssFamily(FALLBACK_MONO_FONT))) + ', monospace',
      monoSize: Math.max(4, (c.mono_size ?? gf.size ?? FALLBACK_MONO_SIZE) + delta),
      proseFamily: cssFamily(c.prose_font) + ', serif',
      proseSize: Math.max(4, c.prose_size + delta),
      linespace: c.linespace ?? this.state.options.linespace,
    };
  }

  private gridSize() {
    const { width, height } = this.host.area();
    return {
      cols: Math.max(1, Math.floor(width / this.metrics.cw)),
      rows: Math.max(1, Math.floor(height / this.metrics.ch)),
    };
  }

  async start(cwd: string | undefined, files: string[]): Promise<void> {
    const { cols, rows } = this.gridSize();
    this.cwd = cwd ?? '';
    this.title = tabTitle(files[0] ?? '', this.cwd);
    try {
      await this.transport.start(this.id, { cols, rows, cwd, files });
      this.started = true;
      this.sentSize = `${cols}x${rows}`;
      this.resize();
    } catch (e) {
      const err = e as StartError;
      console.error(`nuivim: start failed: ${err?.message ?? String(e)}`);
      this.dead = true;
      this.showPage('NuiVim could not start Neovim', err?.message ?? String(e));
    }
  }

  /** Resizes Neovim's grid to the area (after a window resize, tab bar change or font change). */
  resize(): void {
    if (!this.started || this.dead) return;
    const { cols, rows } = this.gridSize();
    const key = `${cols}x${rows}`;
    if (key === this.sentSize) return;
    this.sentSize = key;
    this.call('nvim_ui_try_resize', [cols, rows]);
  }

  call(method: string, params: unknown[]): Promise<unknown> {
    const p = this.transport.call(this.id, method, params);
    // These race with Neovim quitting (`confirm qa`, closing tabs); their failures are expected.
    p.catch((e) => {
      if (!QUIET.has(method)) console.error(`nuivim: ${method} failed`, e);
    });
    return p;
  }

  input(keys: string): void {
    if (!this.dead) this.transport.input(this.id, keys);
  }

  paint(): void {
    if (this.dead) return;
    this.renderer.paint(this.state);
    this.host.changed(this);
  }

  /** Re-measures fonts; on a change, repaints everything and resizes the grid. */
  refreshFonts(force = false): void {
    const m = measure(this.fonts());
    if (!force && JSON.stringify(m) === JSON.stringify(this.metrics)) return;
    this.metrics = m;
    this.renderer.reset(this.state, this.metrics, this.config);
    this.resize();
  }

  /** Recomputes the config from the app's settings and this tab's vim.g.nuivim. */
  applyConfig(echoWarnings = false): void {
    const { config, warnings, overridden } = layerConfig(this.host.appearance(), this.nvimConfig);
    this.config = config;
    this.overridden = overridden;
    if (echoWarnings) for (const w of warnings) this.call('nvim_echo', [[[`nuivim: ${w}`, 'WarningMsg']], true, {}]).catch(() => {});
    this.refreshFonts(true);
    this.paint();
  }

  private runWinQueries(): void {
    const wins = this.state.takeWinQueries();
    if (!wins.length) return;
    this.call('nvim_exec_lua', [WININFO_LUA, [wins]])
      .then((result) => {
        let changed = false;
        for (const item of (result as unknown[]) ?? []) {
          if (!Array.isArray(item)) continue;
          const [w, filetype, buftype, textoff] = item;
          changed = this.state.setWinInfo(Number(w), { filetype: String(filetype), buftype: String(buftype), textoff: Number(textoff) || 0 }) || changed;
        }
        if (changed) this.paint();
      })
      .catch(() => {});
  }

  onRedraw(batch: unknown[]): void {
    if (!this.state.apply(batch)) return;
    if (this.state.fontsDirty) {
      this.state.fontsDirty = false;
      this.refreshFonts();
    }
    this.runWinQueries();
    this.paint();
  }

  onNotify(method: string, args: unknown[]): void {
    if (method !== 'nuivim' || !Array.isArray(args)) return;
    if (args[0] === 'config') {
      this.nvimConfig = args[1];
      this.applyConfig(true);
    } else if (args[0] === 'wininfo') {
      this.state.queueAllWinQueries();
      this.runWinQueries();
    } else if (args[0] === 'buf' && args[1] && typeof args[1] === 'object') {
      const b = args[1] as { name?: unknown; cwd?: unknown };
      this.bufname = typeof b.name === 'string' ? b.name : '';
      this.cwd = typeof b.cwd === 'string' ? b.cwd : this.cwd;
      this.title = tabTitle(this.bufname, this.cwd);
      this.host.changed(this);
    }
  }

  onExit(info: ExitInfo): void {
    this.dead = true;
    this.started = false;
    if (info.code === 0) {
      this.host.exited(this);
      return;
    }
    this.showPage(
      'Neovim stopped',
      info.code === null ? 'Neovim was killed by a signal.' : `Neovim exited with code ${info.code}.`,
      info.stderr.filter((l) => l.trim()).join('\n') || '(no output on stderr)',
    );
    this.title = 'Neovim stopped';
    this.host.changed(this);
  }

  openFiles(paths: string[]): void {
    for (const p of paths) this.call('nvim_exec_lua', [DROP_LUA, [p]]).catch(() => {});
  }

  setFocus(focused: boolean): void {
    if (this.started && !this.dead) this.call('nvim_ui_set_focus', [focused]).catch(() => {});
  }

  /** Asks Neovim to quit (it may ask to save); the tab closes when it exits. A dead tab closes at once. */
  close(): void {
    if (this.dead || !this.started) {
      this.dead = true;
      this.host.exited(this);
      return;
    }
    // Not awaited: the request only returns once any confirmation prompt is answered.
    this.call('nvim_command', ['confirm qa']).catch(() => {});
  }

  show(visible: boolean): void {
    this.screen.classList.toggle('active', visible);
    if (visible) {
      this.resize();
      this.paint();
    }
  }

  private showPage(title: string, body: string, pre?: string): void {
    this.screen.innerHTML = '';
    this.screen.style.width = this.screen.style.height = '100%';
    const page = document.createElement('div');
    page.className = 'page';
    const h = document.createElement('h1');
    h.textContent = title;
    const p = document.createElement('p');
    p.textContent = body;
    page.append(h, p);
    if (pre) {
      const el = document.createElement('pre');
      el.textContent = pre;
      page.append(el);
    }
    this.screen.append(page);
  }
}
