// Wires transport, model, view and input together.

import './style.css';
import { DEFAULTS, FALLBACK_MONO_FONT, FALLBACK_MONO_SIZE, mergeConfig, type Config } from './config';
import { cssFamily, parseGuifont } from './model/guifont';
import { UiState } from './model/state';
import { attachKeyboard } from './input/keyboard';
import { attachMouse } from './input/mouse';
import { createTransport, type ExitInfo, type StartError, type Transport } from './transport';
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

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function showPage(title: string, body: string, pre?: string): void {
  document.body.className = 'page';
  document.body.innerHTML = '';
  const main = document.createElement('main');
  const h = document.createElement('h1');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = body;
  main.append(h, p);
  if (pre) {
    const el = document.createElement('pre');
    el.textContent = pre;
    main.append(el);
  }
  document.body.append(main);
}

async function main(): Promise<void> {
  const screen = $<HTMLDivElement>('screen');
  const ta = $<HTMLTextAreaElement>('input');
  const ime = $<HTMLDivElement>('ime');

  const transport: Transport = await createTransport();
  const state = new UiState();
  state.log = (m) => console.debug(m);
  let config: Config = mergeConfig(undefined).config;
  let sizeDelta = 0;
  let started = false;
  let lastTitle = '';

  const fonts = (): Fonts => {
    const gf = parseGuifont(state.options.guifont);
    return {
      monoFamily: (config.mono_font ? cssFamily(config.mono_font) : (gf.family ?? cssFamily(FALLBACK_MONO_FONT))) + ', monospace',
      monoSize: Math.max(4, (config.mono_size ?? gf.size ?? FALLBACK_MONO_SIZE) + sizeDelta),
      proseFamily: cssFamily(config.prose_font) + ', serif',
      proseSize: Math.max(4, config.prose_size + sizeDelta),
      linespace: state.options.linespace,
    };
  };
  let metrics: Metrics = measure(fonts());
  const renderer = new Renderer(screen, metrics, config);

  const gridSize = () => ({
    cols: Math.max(1, Math.floor(window.innerWidth / metrics.cw)),
    rows: Math.max(1, Math.floor(window.innerHeight / metrics.ch)),
  });

  let sentSize = '';
  const resizeNow = () => {
    if (!started) return;
    const { cols, rows } = gridSize();
    const key = `${cols}x${rows}`;
    if (key === sentSize) return;
    sentSize = key;
    transport.call('nvim_ui_try_resize', [cols, rows]).catch((e) => console.error(e));
  };
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resizeNow, 50);
  });

  const placeInput = () => {
    const c = renderer.cursorBox(state);
    ta.style.transform = `translate(${c.x}px, ${c.y}px)`;
    ta.style.height = `${c.h}px`;
    ime.style.transform = ta.style.transform;
    ime.style.height = `${c.h}px`;
    ime.classList.toggle('cp', c.prose);
  };

  const paint = () => {
    renderer.paint(state);
    if (state.title !== lastTitle) {
      lastTitle = state.title;
      transport.setTitle(state.title || 'propvim');
    }
    placeInput();
  };

  /** Re-measures fonts; on a change, repaints everything and resizes the grid. */
  const refreshFonts = (force = false) => {
    const m = measure(fonts());
    const same = JSON.stringify(m) === JSON.stringify(metrics);
    if (same && !force) return;
    metrics = m;
    renderer.reset(state, metrics, config);
    resizeNow();
  };

  const runWinQueries = () => {
    const wins = state.takeWinQueries();
    if (!wins.length) return;
    transport
      .call('nvim_exec_lua', [WININFO_LUA, [wins]])
      .then((result) => {
        let changed = false;
        for (const item of (result as unknown[]) ?? []) {
          if (!Array.isArray(item)) continue;
          const [w, filetype, buftype, textoff] = item;
          changed = state.setWinInfo(Number(w), { filetype: String(filetype), buftype: String(buftype), textoff: Number(textoff) || 0 }) || changed;
        }
        if (changed) paint();
      })
      .catch((e) => console.error('propvim: window info query failed', e));
  };

  const applyConfig = (raw: unknown) => {
    const merged = mergeConfig(raw);
    config = merged.config;
    for (const w of merged.warnings) {
      transport.call('nvim_echo', [[[`propvim: ${w}`, 'WarningMsg']], true, {}]).catch(() => {});
    }
    refreshFonts(true);
    paint();
  };

  let loggedResize = false;
  transport.onRedraw((batch) => {
    if (!loggedResize && batch.some((ev) => Array.isArray(ev) && ev[0] === 'grid_resize' && ev.slice(1).some((a) => Array.isArray(a) && a[0] === 1))) {
      loggedResize = true;
      console.info('propvim: grid_resize for grid 1');
    }
    if (!state.apply(batch)) return;
    if (state.fontsDirty) {
      state.fontsDirty = false;
      refreshFonts();
    }
    runWinQueries();
    paint();
  });

  transport.onNotify((method, args) => {
    if (method !== 'propvim' || !Array.isArray(args)) return;
    if (args[0] === 'config') applyConfig(args[1]);
    else if (args[0] === 'wininfo') {
      state.queueAllWinQueries();
      runWinQueries();
    }
  });

  transport.onExit((info: ExitInfo) => {
    showPage(
      'Neovim stopped',
      info.code === null ? 'Neovim was killed by a signal.' : `Neovim exited with code ${info.code}.`,
      info.stderr.filter((l) => l.trim()).join('\n') || '(no output on stderr)',
    );
  });

  // :drop takes a file list, so each path is escaped as one list item (spaces, %, #).
  const DROP_LUA = "vim.api.nvim_cmd({ cmd = 'drop', args = { vim.fn.fnameescape(...) } }, {})";
  transport.onOpenFiles((paths) => {
    for (const p of paths) transport.call('nvim_exec_lua', [DROP_LUA, [p]]).catch((e) => console.error(e));
  });

  attachKeyboard(ta, {
    send: (keys) => transport.input(keys),
    optionIsMeta: () => config.option_is_meta,
    appKey: (e) => {
      if (!e.metaKey || e.ctrlKey || e.altKey) return false;
      if (e.key === '=' || e.key === '+') sizeDelta++;
      else if (e.key === '-') sizeDelta--;
      else if (e.key === '0') sizeDelta = 0;
      else return ['q', 'h', 'm'].includes(e.key.toLowerCase()); // handled by the menu
      refreshFonts();
      paint();
      return true;
    },
    compose: (text) => {
      ime.textContent = text ?? '';
      ime.style.display = text ? '' : 'none';
      placeInput();
    },
  });

  attachMouse(screen, {
    enabled: () => state.mouseOn,
    hitTest: (x, y) => renderer.hitTest(x, y, state),
    send: (button, action, modifier, hit) => transport.inputMouse(button, action, modifier, hit.grid, hit.row, hit.col),
    cell: () => metrics,
    focus: () => ta.focus(),
  });

  window.addEventListener('focus', () => {
    document.body.classList.remove('unfocused');
    ta.focus();
    if (started) transport.call('nvim_ui_set_focus', [true]).catch(() => {});
  });
  window.addEventListener('blur', () => {
    document.body.classList.add('unfocused');
    if (started) transport.call('nvim_ui_set_focus', [false]).catch(() => {});
  });

  // Exposed for tests and debugging.
  Object.assign(window, {
    __propvim: {
      state,
      renderer,
      transport,
      get config() {
        return config;
      },
      get metrics() {
        return metrics;
      },
      defaults: DEFAULTS,
    },
  });

  ta.focus();
  const { cols, rows } = gridSize();
  try {
    await transport.start(cols, rows);
    started = true;
    sentSize = `${cols}x${rows}`;
    resizeNow();
  } catch (e) {
    const err = e as StartError;
    console.error(`propvim: start failed: ${err?.message ?? String(e)}`);
    showPage('propvim could not start Neovim', err?.message ?? String(e));
  }
}

main().catch((e) => showPage('propvim failed to start', String(e)));
