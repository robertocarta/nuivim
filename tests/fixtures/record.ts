// Records redraw batches from a real Neovim into tests/fixtures/<name>.json for
// the unit tests. Re-run after a Neovim upgrade:  npx tsx tests/fixtures/record.ts

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { NvimRpc, ROOT } from '../e2e/nvim-rpc';

interface Recording {
  name: string;
  file?: string;
  cols?: number;
  rows?: number;
  /** Steps run after startup; batches from each step are kept. */
  steps: (n: NvimRpc) => Promise<unknown>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const recordings: Recording[] = [
  { name: 'startup', file: 'tests/fixtures/prose.md', steps: async () => {} },
  {
    name: 'split',
    file: 'tests/fixtures/prose.md',
    steps: (n) => n.request('nvim_command', ['vsplit | split']),
  },
  {
    name: 'float',
    steps: (n) =>
      n.request('nvim_exec_lua', [
        `local b = vim.api.nvim_create_buf(false, true)
         vim.api.nvim_buf_set_lines(b, 0, -1, false, {'┌──┬──┐', '│ab│漢│', '└──┴──┘', '😀 x'})
         vim.api.nvim_open_win(b, false, {relative='editor', row=3, col=10, width=12, height=4, border='rounded', zindex=60})`,
        [],
      ]),
  },
  {
    name: 'pum',
    file: 'tests/fixtures/prose.md',
    steps: async (n) => {
      await n.request('nvim_input', ['Goth<C-n>']);
    },
  },
  {
    name: 'scroll',
    file: 'tests/fixtures/long.txt',
    steps: async (n) => {
      await n.request('nvim_input', ['<C-e><C-e><C-e>']);
      await sleep(100);
      await n.request('nvim_input', ['<C-y>']);
    },
  },
  {
    name: 'tabs',
    file: 'tests/fixtures/prose.md',
    steps: async (n) => {
      await n.request('nvim_exec_lua', [
        `local b = vim.api.nvim_create_buf(false, true)
         _G.f = vim.api.nvim_open_win(b, false, {relative='editor', row=1, col=1, width=5, height=2})`,
        [],
      ]);
      await sleep(100);
      await n.request('nvim_exec_lua', ['vim.api.nvim_win_close(_G.f, true)', []]);
      await sleep(100);
      await n.request('nvim_command', ['tabnew']);
    },
  },
  {
    name: 'modes',
    file: 'tests/fixtures/prose.md',
    steps: async (n) => {
      await n.request('nvim_input', ['i']);
      await sleep(100);
      await n.request('nvim_input', ['<Esc>:echo "hello"<CR>']);
    },
  },
];

async function record(r: Recording): Promise<void> {
  const n = new NvimRpc({ file: r.file });
  const batches: unknown[] = [];
  n.onNotify((method, args) => {
    if (method === 'redraw') batches.push(args);
  });
  await n.attach(r.cols ?? 80, r.rows ?? 24);
  await sleep(300);
  await r.steps(n);
  await sleep(300);
  n.kill();
  writeFileSync(path.join(ROOT, 'tests/fixtures', `${r.name}.json`), JSON.stringify(batches) + '\n');
  console.log(`${r.name}: ${batches.length} batches`);
}

for (const r of recordings) await record(r);
