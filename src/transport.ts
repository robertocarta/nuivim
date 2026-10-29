// The frontend's only link to the backend. In the app it uses Tauri commands and
// events; in tests it uses a WebSocket to tests/e2e/harness.ts. Every Neovim call
// and event carries the id of the tab whose Neovim it belongs to.

export interface StartError {
  kind: string;
  message: string;
}

export interface ExitInfo {
  code: number | null;
  stderr: string[];
}

export interface StartOptions {
  cols: number;
  rows: number;
  /** Working directory; missing or not a directory: the home folder. */
  cwd?: string;
  files?: string[];
}

/** Open files in a new tab (shell command, Finder, launch arguments). */
export interface OpenRequest {
  cwd?: string | null;
  files: string[];
}

export interface Transport {
  /** Spawns and attaches the tab's Neovim. Rejects with a StartError. */
  start(tab: number, opts: StartOptions): Promise<void>;
  input(tab: number, keys: string): void;
  inputMouse(tab: number, button: string, action: string, modifier: string, grid: number, row: number, col: number): void;
  /** Any other API request, e.g. call(tab, 'nvim_ui_try_resize', [80, 24]). */
  call(tab: number, method: string, params: unknown[]): Promise<unknown>;
  setTitle(title: string): void;
  /** Open requests from launch; later ones arrive through onOpenRequest. */
  launchRequests(): Promise<OpenRequest[]>;
  loadSettings(): Promise<unknown>;
  saveSettings(settings: unknown): Promise<void>;
  /** Installs the `nuivim` shell command; resolves with a message for the user. */
  installShellCommand(): Promise<string>;
  /** Every tab has closed. */
  quitApp(): void;
  onRedraw(cb: (tab: number, events: unknown[]) => void): void;
  onNotify(cb: (tab: number, method: string, args: unknown[]) => void): void;
  onExit(cb: (tab: number, info: ExitInfo) => void): void;
  /** Files dropped on the window: opened in the active tab. */
  onOpenFiles(cb: (paths: string[]) => void): void;
  onOpenRequest(cb: (req: OpenRequest) => void): void;
  /** Menu items: settings, install-shell-command, new-tab, close-tab, next-tab, previous-tab, quit. */
  onMenu(cb: (id: string) => void): void;
}

class Listeners {
  redraw: ((tab: number, events: unknown[]) => void)[] = [];
  notify: ((tab: number, method: string, args: unknown[]) => void)[] = [];
  exit: ((tab: number, info: ExitInfo) => void)[] = [];
  openFiles: ((paths: string[]) => void)[] = [];
  openRequest: ((req: OpenRequest) => void)[] = [];
  menu: ((id: string) => void)[] = [];
}

const logError = (what: string) => (e: unknown) => console.error(`nuivim: ${what} failed`, e);

abstract class BaseTransport {
  protected l = new Listeners();
  onRedraw(cb: (tab: number, events: unknown[]) => void) { this.l.redraw.push(cb); }
  onNotify(cb: (tab: number, method: string, args: unknown[]) => void) { this.l.notify.push(cb); }
  onExit(cb: (tab: number, info: ExitInfo) => void) { this.l.exit.push(cb); }
  onOpenFiles(cb: (paths: string[]) => void) { this.l.openFiles.push(cb); }
  onOpenRequest(cb: (req: OpenRequest) => void) { this.l.openRequest.push(cb); }
  onMenu(cb: (id: string) => void) { this.l.menu.push(cb); }
}

class TauriTransport extends BaseTransport implements Transport {
  private invoke!: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  private win!: { setTitle(t: string): Promise<void> };

  async init(): Promise<void> {
    const [{ invoke }, { listen }, { getCurrentWindow }] = await Promise.all([
      import('@tauri-apps/api/core'),
      import('@tauri-apps/api/event'),
      import('@tauri-apps/api/window'),
    ]);
    this.invoke = invoke;
    this.win = getCurrentWindow();
    if (import.meta.env.DEV) {
      // Mirror console output to the terminal running `tauri dev`.
      for (const level of ['info', 'warn', 'error'] as const) {
        const orig = console[level].bind(console);
        console[level] = (...args: unknown[]) => {
          orig(...args);
          invoke('frontend_log', { message: `${level}: ${args.map(String).join(' ')}` }).catch(() => {});
        };
      }
    }
    // Register every listener before any tab starts so no event is missed.
    await Promise.all([
      listen<{ tab: number; events: unknown[] }>('nvim-redraw', (e) => this.l.redraw.forEach((cb) => cb(e.payload.tab, e.payload.events))),
      listen<{ tab: number; method: string; args: unknown[] }>('nvim-notify', (e) =>
        this.l.notify.forEach((cb) => cb(e.payload.tab, e.payload.method, e.payload.args)),
      ),
      listen<ExitInfo & { tab: number }>('nvim-exit', (e) => this.l.exit.forEach((cb) => cb(e.payload.tab, e.payload))),
      listen<string[]>('open-files', (e) => this.l.openFiles.forEach((cb) => cb(e.payload))),
      listen<OpenRequest>('open-request', (e) => this.l.openRequest.forEach((cb) => cb(e.payload))),
      listen<string>('menu', (e) => this.l.menu.forEach((cb) => cb(e.payload))),
    ]);
  }

  async start(tab: number, opts: StartOptions): Promise<void> {
    await this.invoke('nvim_start', { tab, ...opts });
  }
  input(tab: number, keys: string): void {
    this.invoke('nvim_input', { tab, keys }).catch(logError('nvim_input'));
  }
  inputMouse(tab: number, button: string, action: string, modifier: string, grid: number, row: number, col: number): void {
    this.invoke('nvim_input_mouse', { tab, button, action, modifier, grid, row, col }).catch(logError('nvim_input_mouse'));
  }
  call(tab: number, method: string, params: unknown[]): Promise<unknown> {
    return this.invoke('nvim_call', { tab, method, params });
  }
  setTitle(title: string): void {
    this.win.setTitle(title).catch(logError('setTitle'));
  }
  launchRequests(): Promise<OpenRequest[]> {
    return this.invoke('launch_requests') as Promise<OpenRequest[]>;
  }
  loadSettings(): Promise<unknown> {
    return this.invoke('settings_load');
  }
  async saveSettings(settings: unknown): Promise<void> {
    await this.invoke('settings_save', { settings });
  }
  installShellCommand(): Promise<string> {
    return this.invoke('install_shell_command') as Promise<string>;
  }
  quitApp(): void {
    this.invoke('quit_app').catch(logError('quit_app'));
  }
}

/**
 * WebSocket transport for tests. The page URL carries the harness port, a file to
 * open at launch, commands for every Neovim and the stored settings:
 * ?ws=5198&file=tests/fixtures/a.md&cmd=set+number&settings={"autohide_tabs":false}
 */
export class WsTransport extends BaseTransport implements Transport {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private launch: OpenRequest[];
  private settings: unknown;
  /** Test only: how often quitApp was called. */
  quitCalls = 0;

  constructor(
    private readonly url: string,
    private readonly cmds: string[],
    file: string | null,
    settings: string | null,
  ) {
    super();
    this.launch = file ? [{ cwd: null, files: [file] }] : [];
    this.settings = settings ? JSON.parse(settings) : {};
  }

  init(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(e);
      this.ws.onmessage = (m) => this.receive(JSON.parse(String(m.data)));
    });
  }

  private receive(msg: Record<string, unknown>): void {
    const tab = msg.tab as number;
    switch (msg.type) {
      case 'redraw':
        this.l.redraw.forEach((cb) => cb(tab, msg.events as unknown[]));
        break;
      case 'notify':
        this.l.notify.forEach((cb) => cb(tab, msg.method as string, msg.args as unknown[]));
        break;
      case 'exit':
        this.l.exit.forEach((cb) => cb(tab, msg.info as ExitInfo));
        break;
      case 'open-files':
        this.l.openFiles.forEach((cb) => cb(msg.paths as string[]));
        break;
      case 'open-request':
        this.l.openRequest.forEach((cb) => cb(msg.req as OpenRequest));
        break;
      case 'result': {
        const p = this.pending.get(msg.id as number);
        this.pending.delete(msg.id as number);
        if (msg.ok) p?.resolve(msg.value);
        else p?.reject(msg.error);
        break;
      }
    }
  }

  private request(msg: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...msg, id }));
    });
  }

  async start(tab: number, opts: StartOptions): Promise<void> {
    await this.request({ type: 'start', tab, ...opts, cmds: this.cmds });
  }
  input(tab: number, keys: string): void {
    this.request({ type: 'input', tab, keys }).catch(logError('nvim_input'));
  }
  inputMouse(tab: number, button: string, action: string, modifier: string, grid: number, row: number, col: number): void {
    this.request({ type: 'mouse', tab, args: [button, action, modifier, grid, row, col] }).catch(logError('nvim_input_mouse'));
  }
  call(tab: number, method: string, params: unknown[]): Promise<unknown> {
    return this.request({ type: 'call', tab, method, params });
  }
  setTitle(title: string): void {
    document.title = title;
  }
  async launchRequests(): Promise<OpenRequest[]> {
    const reqs = this.launch;
    this.launch = [];
    return reqs;
  }
  async loadSettings(): Promise<unknown> {
    return this.settings;
  }
  async saveSettings(settings: unknown): Promise<void> {
    this.settings = settings;
  }
  async installShellCommand(): Promise<string> {
    return 'not available in tests';
  }
  quitApp(): void {
    this.quitCalls++;
  }
  /** Test only: makes the harness send an open-files event, as a file drop would. */
  simulateOpenFiles(paths: string[]): Promise<unknown> {
    return this.request({ type: 'echo', event: { type: 'open-files', paths } });
  }
  /** Test only: an open request, as the `nuivim` shell command sends. */
  simulateOpenRequest(req: OpenRequest): Promise<unknown> {
    return this.request({ type: 'echo', event: { type: 'open-request', req } });
  }
  /** Test only: a menu item. */
  simulateMenu(id: string): void {
    this.l.menu.forEach((cb) => cb(id));
  }
}

export async function createTransport(): Promise<Transport> {
  if ('__TAURI_INTERNALS__' in window) {
    const t = new TauriTransport();
    await t.init();
    return t;
  }
  const q = new URLSearchParams(location.search);
  const t = new WsTransport(`ws://127.0.0.1:${q.get('ws') ?? '5198'}`, q.getAll('cmd'), q.get('file'), q.get('settings'));
  await t.init();
  return t;
}
