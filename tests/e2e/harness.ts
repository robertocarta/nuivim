// Dev-only test harness: a WebSocket server on 127.0.0.1. Each connection is one
// app window; each of its tabs gets its own `nvim --embed --clean -u
// tests/fixtures/init.lua`. Relays redraw batches and the transport's requests
// (see src/transport.ts).
//
//   npx tsx tests/e2e/harness.ts --port 5198

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { NvimRpc, ROOT } from './nvim-rpc';

const portArg = process.argv.indexOf('--port');
const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 5198;

type Msg = { id: number; type: string; tab: number; [k: string]: unknown };

function serve(ws: WebSocket): void {
  const tabs = new Map<number, NvimRpc>();
  const send = (m: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  };
  const reply = (id: number, p: Promise<unknown>) =>
    p.then(
      (value) => send({ type: 'result', id, ok: true, value: value ?? null }),
      (error) => send({ type: 'result', id, ok: false, error: String(error instanceof Error ? error.message : JSON.stringify(error)) }),
    );
  const nvim = (msg: Msg) => {
    const n = tabs.get(msg.tab);
    if (!n) send({ type: 'result', id: msg.id, ok: false, error: `tab ${msg.tab} not started` });
    return n;
  };

  ws.on('message', (data) => {
    const msg = JSON.parse(String(data)) as Msg;
    switch (msg.type) {
      case 'start': {
        const tab = msg.tab;
        // Like the app: a missing working directory falls back to the project root ("home").
        const wanted = msg.cwd ? path.resolve(ROOT, msg.cwd as string) : undefined;
        const cwd = wanted && existsSync(wanted) && statSync(wanted).isDirectory() ? wanted : undefined;
        const n = new NvimRpc({ cwd, files: (msg.files as string[]) ?? [], cmds: (msg.cmds as string[]) ?? [] });
        tabs.set(tab, n);
        n.onNotify((method, args) => {
          if (method === 'redraw') send({ type: 'redraw', tab, events: args });
          else send({ type: 'notify', tab, method, args });
        });
        void n.exited.then((code) => {
          tabs.delete(tab);
          send({ type: 'exit', tab, info: { code, stderr: n.stderr } });
        });
        reply(msg.id, n.attach(msg.cols as number, msg.rows as number));
        break;
      }
      case 'input':
        if (nvim(msg)) reply(msg.id, nvim(msg)!.request('nvim_input', [msg.keys]));
        break;
      case 'mouse':
        if (nvim(msg)) reply(msg.id, nvim(msg)!.request('nvim_input_mouse', msg.args as unknown[]));
        break;
      case 'call':
        if (nvim(msg)) reply(msg.id, nvim(msg)!.request(msg.method as string, msg.params as unknown[]));
        break;
      case 'echo':
        // Test only: deliver an event as the backend would (file drop, shell command).
        send(msg.event);
        send({ type: 'result', id: msg.id, ok: true, value: null });
        break;
    }
  });
  ws.on('close', () => tabs.forEach((n) => n.kill()));
}

const wss = new WebSocketServer({ host: '127.0.0.1', port });
wss.on('connection', serve);
console.log(`nuivim harness listening on ws://127.0.0.1:${port}`);
