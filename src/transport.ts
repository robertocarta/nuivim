// The frontend's only link to Neovim. In the app it uses Tauri commands and
// events; in tests it uses a WebSocket to tests/e2e/harness.ts.

export interface StartError {
  kind: string;
  message: string;
}

export interface ExitInfo {
  code: number | null;
  stderr: string[];
}

export interface Transport {
  /** Spawns and attaches Neovim with a cols × rows grid. Rejects with a StartError. */
  start(cols: number, rows: number): Promise<void>;
  input(keys: string): void;
  inputMouse(button: string, action: string, modifier: string, grid: number, row: number, col: number): void;
  /** Any other API request, e.g. call('nvim_ui_try_resize', [80, 24]). */
  call(method: string, params: unknown[]): Promise<unknown>;
  setTitle(title: string): void;
  onRedraw(cb: (events: unknown[]) => void): void;
  onNotify(cb: (method: string, args: unknown[]) => void): void;
  onExit(cb: (info: ExitInfo) => void): void;
  onOpenFiles(cb: (paths: string[]) => void): void;
}

type Listeners = {
  redraw: ((events: unknown[]) => void)[];
  notify: ((method: string, args: unknown[]) => void)[];
  exit: ((info: ExitInfo) => void)[];
  openFiles: ((paths: string[]) => void)[];
};

const newListeners = (): Listeners => ({ redraw: [], notify: [], exit: [], openFiles: [] });

const logError = (what: string) => (e: unknown) => console.error(`propvim: ${what} failed`, e);

class TauriTransport implements Transport {
  private l = newListeners();
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
    // Register every listener before start() so no event is missed.
    await Promise.all([
      listen<unknown[]>('nvim-redraw', (e) => this.l.redraw.forEach((cb) => cb(e.payload))),
      listen<{ method: string; args: unknown[] }>('nvim-notify', (e) =>
        this.l.notify.forEach((cb) => cb(e.payload.method, e.payload.args)),
      ),
      listen<ExitInfo>('nvim-exit', (e) => this.l.exit.forEach((cb) => cb(e.payload))),
      listen<string[]>('open-files', (e) => this.l.openFiles.forEach((cb) => cb(e.payload))),
    ]);
  }

  async start(cols: number, rows: number): Promise<void> {
    await this.invoke('nvim_start', { cols, rows });
  }
  input(keys: string): void {
    this.invoke('nvim_input', { keys }).catch(logError('nvim_input'));
  }
  inputMouse(button: string, action: string, modifier: string, grid: number, row: number, col: number): void {
    this.invoke('nvim_input_mouse', { button, action, modifier, grid, row, col }).catch(logError('nvim_input_mouse'));
  }
  call(method: string, params: unknown[]): Promise<unknown> {
    return this.invoke('nvim_call', { method, params });
  }
  setTitle(title: string): void {
    this.win.setTitle(title).catch(logError('setTitle'));
  }
  onRedraw(cb: (events: unknown[]) => void) { this.l.redraw.push(cb); }
  onNotify(cb: (method: string, args: unknown[]) => void) { this.l.notify.push(cb); }
  onExit(cb: (info: ExitInfo) => void) { this.l.exit.push(cb); }
  onOpenFiles(cb: (paths: string[]) => void) { this.l.openFiles.push(cb); }
}

/**
 * WebSocket transport for tests. The page URL carries the harness port and the
 * Neovim session to start: ?ws=5198&file=tests/fixtures/a.md&cmd=set+number
 */
export class WsTransport implements Transport {
  private l = newListeners();
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

  constructor(private readonly url: string, private readonly session: Record<string, unknown>) {}

  init(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(e);
      this.ws.onmessage = (m) => this.receive(JSON.parse(String(m.data)));
    });
  }

  private receive(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'redraw':
        this.l.redraw.forEach((cb) => cb(msg.events as unknown[]));
        break;
      case 'notify':
        this.l.notify.forEach((cb) => cb(msg.method as string, msg.args as unknown[]));
        break;
      case 'exit':
        this.l.exit.forEach((cb) => cb(msg.info as ExitInfo));
        break;
      case 'open-files':
        this.l.openFiles.forEach((cb) => cb(msg.paths as string[]));
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

  async start(cols: number, rows: number): Promise<void> {
    await this.request({ type: 'start', cols, rows, ...this.session });
  }
  input(keys: string): void {
    this.request({ type: 'input', keys }).catch(logError('nvim_input'));
  }
  inputMouse(button: string, action: string, modifier: string, grid: number, row: number, col: number): void {
    this.request({ type: 'mouse', args: [button, action, modifier, grid, row, col] }).catch(logError('nvim_input_mouse'));
  }
  call(method: string, params: unknown[]): Promise<unknown> {
    return this.request({ type: 'call', method, params });
  }
  setTitle(title: string): void {
    document.title = title;
  }
  /** Test only: makes the harness send an open-files event, as a file drop would. */
  simulateOpenFiles(paths: string[]): Promise<unknown> {
    return this.request({ type: 'echo-open-files', paths });
  }
  onRedraw(cb: (events: unknown[]) => void) { this.l.redraw.push(cb); }
  onNotify(cb: (method: string, args: unknown[]) => void) { this.l.notify.push(cb); }
  onExit(cb: (info: ExitInfo) => void) { this.l.exit.push(cb); }
  onOpenFiles(cb: (paths: string[]) => void) { this.l.openFiles.push(cb); }
}

export async function createTransport(): Promise<Transport> {
  if ('__TAURI_INTERNALS__' in window) {
    const t = new TauriTransport();
    await t.init();
    return t;
  }
  const q = new URLSearchParams(location.search);
  const port = q.get('ws') ?? '5198';
  const t = new WsTransport(`ws://127.0.0.1:${port}`, {
    file: q.get('file') ?? undefined,
    cmds: q.getAll('cmd'),
  });
  await t.init();
  return t;
}
