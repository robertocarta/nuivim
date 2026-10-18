// Minimal msgpack-rpc client for an embedded Neovim (dev and test only).

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { decode, decodeMultiStream, encode, ExtensionCodec } from '@msgpack/msgpack';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const BRIDGE = readFileSync(path.join(ROOT, 'src-tauri/src/bridge.lua'), 'utf8');
export const UI_OPTIONS = { rgb: true, ext_linegrid: true, ext_multigrid: true, ext_hlstate: true };

// Buffer, Window and Tabpage handles (ext types 0-2) become plain integers, as in the app.
const codec = new ExtensionCodec();
for (const type of [0, 1, 2]) codec.register({ type, encode: () => null, decode: (data) => decode(data) });

export interface NvimOptions {
  file?: string;
  cmds?: string[];
  nvim?: string;
}

export class NvimRpc {
  readonly proc: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private notifyHandlers: ((method: string, args: unknown[]) => void)[] = [];
  readonly exited: Promise<number | null>;
  stderr: string[] = [];

  constructor(opts: NvimOptions = {}) {
    const args = ['--embed', '--clean', '-u', path.join(ROOT, 'tests/fixtures/init.lua')];
    for (const c of opts.cmds ?? []) args.push('-c', c);
    if (opts.file) args.push('--', path.resolve(ROOT, opts.file));
    this.proc = spawn(opts.nvim ?? process.env.PROPVIM_NVIM ?? 'nvim', args, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stderr!.on('data', (d: Buffer) => {
      this.stderr.push(...d.toString().split('\n'));
      this.stderr = this.stderr.slice(-50);
    });
    this.exited = new Promise((resolve) => this.proc.on('exit', (code) => resolve(code)));
    void this.read();
  }

  private async read(): Promise<void> {
    try {
      for await (const msg of decodeMultiStream(this.proc.stdout!, { extensionCodec: codec })) {
        const m = msg as unknown[];
        if (m[0] === 1) {
          const p = this.pending.get(m[1] as number);
          this.pending.delete(m[1] as number);
          if (m[2] !== null && m[2] !== undefined) p?.reject(m[2]);
          else p?.resolve(m[3]);
        } else if (m[0] === 2) {
          for (const h of this.notifyHandlers) h(m[1] as string, m[2] as unknown[]);
        } else if (m[0] === 0) {
          // Neovim asked us something (e.g. rpcrequest); answer with nil.
          this.proc.stdin!.write(encode([1, m[1], null, null]));
        }
      }
    } catch {
      // stream closed
    }
    for (const p of this.pending.values()) p.reject(new Error('nvim exited'));
    this.pending.clear();
  }

  request(method: string, params: unknown[] = []): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin!.write(encode([0, id, method, params]));
    });
  }

  onNotify(cb: (method: string, args: unknown[]) => void): void {
    this.notifyHandlers.push(cb);
  }

  /** Attaches as a UI with the app's options and runs the bridge, like src-tauri/src/nvim.rs. */
  async attach(cols: number, rows: number): Promise<void> {
    const info = (await this.request('nvim_get_api_info')) as [number, unknown];
    await this.request('nvim_ui_attach', [cols, rows, UI_OPTIONS]);
    this.request('nvim_exec_lua', [BRIDGE, [info[0]]]).catch((e) => console.error('bridge failed', e));
  }

  kill(): void {
    this.proc.kill();
  }
}
