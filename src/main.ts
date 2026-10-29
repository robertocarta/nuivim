// The app: tabs (one Neovim each), the tab bar, settings, keyboard and IME input.

import './style.css';
import { DEFAULTS, type Config } from './config';
import { attachKeyboard } from './input/keyboard';
import { Tabs } from './model/tabs';
import { Session } from './session';
import { appearanceDefaults, parseSettings, tabStart, type AppSettings } from './settings';
import { createTransport, type OpenRequest, type Transport } from './transport';
import { openSettingsPanel } from './view/settings-panel';
import { cssVars } from './view/styles';
import { TabBar } from './view/tabbar';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

class App {
  readonly tabs = new Tabs();
  readonly sessions = new Map<number, Session>();
  settings: AppSettings;
  sizeDelta = 0;
  private readonly screens = $<HTMLDivElement>('screens');
  private readonly ta = $<HTMLTextAreaElement>('input');
  private readonly ime = $<HTMLDivElement>('ime');
  private readonly notice = $<HTMLDivElement>('notice');
  private readonly tabBar: TabBar;
  private settingsOpen = false;
  private quitting = false;
  private lastTitle = '';
  private lastVars = '';
  /** The session whose screen is shown (activate() may be called after tabs.active changed). */
  private shown: Session | undefined;

  constructor(
    readonly transport: Transport,
    rawSettings: unknown,
  ) {
    this.settings = parseSettings(rawSettings);
    this.tabBar = new TabBar($('tabbar'), {
      select: (id) => this.activate(id),
      close: (id) => this.sessions.get(id)?.close(),
      add: () => void this.newTab(null),
    });
    this.wireTransport();
    this.wireInput();
  }

  get active(): Session | undefined {
    return this.sessions.get(this.tabs.active);
  }

  /** Opens a tab: for a request (shell command, Finder, launch) or a plain new tab. */
  async newTab(req: OpenRequest | null, withHomepage = false): Promise<Session> {
    const { cwd, files } = tabStart(req, this.settings, withHomepage);
    const tab = this.tabs.add();
    const session = new Session(tab.id, this.transport, {
      appearance: () => this.settings.appearance,
      sizeDelta: () => this.sizeDelta,
      area: () => ({ width: this.screens.clientWidth, height: this.screens.clientHeight }),
      focusInput: () => this.ta.focus(),
      changed: (s) => this.sessionChanged(s),
      exited: (s) => this.sessionExited(s),
    });
    this.sessions.set(tab.id, session);
    this.screens.append(session.screen);
    this.activate(tab.id);
    await session.start(cwd, files);
    return session;
  }

  activate(id: number): void {
    const previous = this.shown;
    this.tabs.select(id);
    const next = this.active;
    this.shown = next;
    if (previous && previous !== next) {
      previous.show(false);
      previous.setFocus(false);
    }
    this.layout();
    if (next) {
      next.show(true);
      next.setFocus(document.hasFocus());
      this.sessionChanged(next);
    }
    this.ta.focus();
  }

  /** Shows or hides the tab bar, then fits the active tab to the space left. */
  layout(): void {
    const hidden = this.settings.autohide_tabs && this.tabs.list.length <= 1;
    this.tabBar.render(this.tabs, hidden);
    document.body.classList.toggle('with-tabs', !hidden);
    this.active?.resize();
  }

  private sessionChanged(s: Session): void {
    this.tabs.setTitle(s.id, s.title);
    this.tabBar.render(this.tabs, this.settings.autohide_tabs && this.tabs.list.length <= 1);
    if (s !== this.active) return;
    // The tab bar, IME overlay and window background follow the active tab's colours and fonts.
    const vars = cssVars(s.state, s.metrics);
    if (vars !== this.lastVars) {
      this.lastVars = vars;
      document.documentElement.setAttribute('style', vars);
    }
    const title = s.title ? `${s.title} — NuiVim` : 'NuiVim';
    if (title !== this.lastTitle) {
      this.lastTitle = title;
      this.transport.setTitle(title);
    }
    this.placeInput();
  }

  private sessionExited(s: Session): void {
    this.tabs.remove(s.id);
    this.sessions.delete(s.id);
    s.screen.remove();
    s.renderer.dispose();
    if (this.shown === s) this.shown = undefined;
    if (!this.tabs.list.length) {
      this.transport.quitApp();
      return;
    }
    this.activate(this.tabs.active);
  }

  /** Quit and the close button: every tab's Neovim is asked to quit (and may ask to save). */
  quit(): void {
    this.quitting = true;
    if (!this.sessions.size) this.transport.quitApp();
    for (const s of [...this.sessions.values()]) s.close();
  }

  private placeInput(): void {
    const s = this.active;
    if (!s || s.dead) return;
    const c = s.renderer.cursorBox(s.state);
    this.ta.style.transform = `translate(${c.x}px, ${c.y}px)`;
    this.ta.style.height = `${c.h}px`;
    this.ime.style.transform = this.ta.style.transform;
    this.ime.style.height = `${c.h}px`;
    this.ime.classList.toggle('cp', c.prose);
  }

  private showNotice(text: string): void {
    this.notice.textContent = text;
    this.notice.hidden = false;
    setTimeout(() => (this.notice.hidden = true), 8000);
  }

  openSettings(): void {
    if (this.settingsOpen) return;
    this.settingsOpen = true;
    const s = this.active;
    const defaults = appearanceDefaults(s?.state.options.guifont ?? '', s?.state.options.linespace ?? 0);
    openSettingsPanel(document.body, {
      settings: this.settings,
      defaults,
      effective: s?.config ?? defaults,
      overridden: s?.overridden ?? [],
      save: async (next) => {
        try {
          await this.transport.saveSettings(next);
        } catch (e) {
          return `Could not save: ${String(e)}`;
        }
        this.settings = next;
        for (const s of this.sessions.values()) s.applyConfig();
        this.layout();
        return null;
      },
      close: () => {
        this.settingsOpen = false;
        this.ta.focus();
      },
    });
  }

  private menu(id: string): void {
    switch (id) {
      case 'settings':
        return this.openSettings();
      case 'install-shell-command':
        this.transport.installShellCommand().then(
          (msg) => this.showNotice(msg),
          (e) => this.showNotice(`Could not install the shell command: ${String(e)}`),
        );
        return;
      case 'new-tab':
        void this.newTab(null);
        return;
      case 'close-tab':
        this.active?.close();
        return;
      case 'next-tab':
        this.tabs.cycle(1);
        return this.activate(this.tabs.active);
      case 'previous-tab':
        this.tabs.cycle(-1);
        return this.activate(this.tabs.active);
      case 'quit':
        return this.quit();
    }
  }

  private wireTransport(): void {
    const t = this.transport;
    t.onRedraw((tab, events) => this.sessions.get(tab)?.onRedraw(events));
    t.onNotify((tab, method, args) => this.sessions.get(tab)?.onNotify(method, args));
    t.onExit((tab, info) => this.sessions.get(tab)?.onExit(info));
    t.onOpenFiles((paths) => this.active?.openFiles(paths));
    t.onOpenRequest((req) => void this.newTab(req));
    t.onMenu((id) => this.menu(id));
  }

  private wireInput(): void {
    attachKeyboard(this.ta, {
      send: (keys) => this.active?.input(keys),
      optionIsMeta: () => this.active?.config.option_is_meta ?? 'none',
      appKey: (e) => this.appKey(e),
      compose: (text) => {
        this.ime.textContent = text ?? '';
        this.ime.style.display = text ? '' : 'none';
        this.placeInput();
      },
    });
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => this.active?.resize(), 50);
    });
    window.addEventListener('focus', () => {
      document.body.classList.remove('unfocused');
      if (!this.settingsOpen) this.ta.focus();
      this.active?.setFocus(true);
    });
    window.addEventListener('blur', () => {
      document.body.classList.add('unfocused');
      this.active?.setFocus(false);
    });
  }

  /** Cmd keys the app keeps: font size and tabs (menu shortcuts never get here). */
  private appKey(e: KeyboardEvent): boolean {
    if (!e.metaKey || e.ctrlKey || e.altKey) return false;
    if (/^[1-9]$/.test(e.key) && !e.shiftKey) {
      this.tabs.selectNumber(Number(e.key));
      this.activate(this.tabs.active);
      return true;
    }
    // Cmd-] / Cmd-[: next / previous tab (Cmd-Shift-] / [ go through the menu).
    const bracket = e.key === ']' || e.code === 'BracketRight' ? 1 : e.key === '[' || e.code === 'BracketLeft' ? -1 : 0;
    if (bracket && !e.shiftKey) {
      this.tabs.cycle(bracket);
      this.activate(this.tabs.active);
      return true;
    }
    if (e.key === '=' || e.key === '+') this.sizeDelta++;
    else if (e.key === '-') this.sizeDelta--;
    else if (e.key === '0') this.sizeDelta = 0;
    else return false;
    for (const s of this.sessions.values()) s.refreshFonts();
    this.active?.paint();
    return true;
  }

  get isQuitting(): boolean {
    return this.quitting;
  }
}

async function main(): Promise<void> {
  const transport = await createTransport();
  const app = new App(transport, await transport.loadSettings().catch(() => ({})));

  // Exposed for tests and debugging; state, renderer, config and metrics are the active tab's.
  const activeCall = (m: string, p: unknown[]) => transport.call(app.tabs.active, m, p);
  Object.assign(window, {
    __nuivim: {
      app,
      get state() {
        return app.active?.state;
      },
      get renderer() {
        return app.active?.renderer;
      },
      get config(): Config | undefined {
        return app.active?.config;
      },
      get metrics() {
        return app.active?.metrics;
      },
      transport: new Proxy(transport, {
        get: (target, prop) => (prop === 'call' ? activeCall : Reflect.get(target, prop)),
      }),
      defaults: DEFAULTS,
    },
  });

  const requests = await transport.launchRequests();
  if (!requests.length) await app.newTab(null, true);
  for (const req of requests) await app.newTab(req);
}

main().catch((e) => {
  document.body.className = 'page';
  document.body.textContent = `NuiVim failed to start: ${String(e)}`;
});
