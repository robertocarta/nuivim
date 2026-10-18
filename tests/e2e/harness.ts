// Dev-only test harness: a WebSocket server on 127.0.0.1 that gives each
// connection its own `nvim --embed --clean -u tests/fixtures/init.lua` and
// relays redraw batches and the transport's requests (see src/transport.ts).
//
//   npx tsx tests/e2e/harness.ts --port 5198

import { WebSocketServer, type WebSocket } from 'ws';
import { NvimRpc } from './nvim-rpc';

const portArg = process.argv.indexOf('--port');
const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 5198;

type Msg = { id: number; type: string; [k: string]: unknown };

function serve(ws: WebSocket): void {
  let nvim: NvimRpc | undefined;
  const send = (m: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  };
  const reply = (id: number, p: Promise<unknown>) =>
    p.then(
      (value) => send({ type: 'result', id, ok: true, value: value ?? null }),
      (error) => send({ type: 'result', id, ok: false, error: String(error instanceof Error ? error.message : JSON.stringify(error)) }),
    );

  ws.on('message', (data) => {
    const msg = JSON.parse(String(data)) as Msg;
    switch (msg.type) {
      case 'start': {
        nvim = new NvimRpc({ file: msg.file as string | undefined, cmds: (msg.cmds as string[]) ?? [] });
        const n = nvim;
        n.onNotify((method, args) => {
          if (method === 'redraw') send({ type: 'redraw', events: args });
          else send({ type: 'notify', method, args });
        });
        void n.exited.then((code) => send({ type: 'exit', info: { code, stderr: n.stderr } }));
        reply(msg.id, n.attach(msg.cols as number, msg.rows as number));
        break;
      }
      case 'input':
        if (nvim) reply(msg.id, nvim.request('nvim_input', [msg.keys]));
        break;
      case 'mouse':
        if (nvim) reply(msg.id, nvim.request('nvim_input_mouse', msg.args as unknown[]));
        break;
      case 'call':
        if (nvim) reply(msg.id, nvim.request(msg.method as string, msg.params as unknown[]));
        else send({ type: 'result', id: msg.id, ok: false, error: 'not started' });
        break;
      case 'echo-open-files':
        send({ type: 'open-files', paths: msg.paths });
        send({ type: 'result', id: msg.id, ok: true, value: null });
        break;
    }
  });
  ws.on('close', () => nvim?.kill());
}

const wss = new WebSocketServer({ host: '127.0.0.1', port });
wss.on('connection', serve);
console.log(`propvim harness listening on ws://127.0.0.1:${port}`);
