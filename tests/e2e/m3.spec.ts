// M3: floats and config, scenarios S9–S11.
import { test } from '@playwright/test';
import { currentWinGrid, cursorBox, expect, input, lua, open, screenshot } from './helpers';

const MD = 'tests/fixtures/prose.md';

test('S9: cursor-relative floats after a prose word put each anchor corner at the cursor', async ({ page }) => {
  await open(page, { file: MD, cmds: ['set number'] });
  // Cursor on the space after "word" in line 7.
  await input(page, '7G0/word<CR>e');
  await input(page, 'l');
  const grid = await currentWinGrid(page);
  const cur = await cursorBox(page);
  expect(cur.grid).toBe(grid);
  const corners = ['NW', 'NE', 'SW', 'SE'] as const;
  const wins = await lua<number[]>(
    page,
    `local out = {}
     for i, corner in ipairs(...) do
       local b = vim.api.nvim_create_buf(false, true)
       vim.api.nvim_buf_set_lines(b, 0, -1, false, { corner .. ' float', 'second line' })
       out[i] = vim.api.nvim_open_win(b, false, { relative = 'cursor', row = 0, col = 0, width = 12, height = 2, anchor = corner, border = 'single' })
     end
     return out`,
    [corners],
  );
  await input(page, '');
  const boxes = await page.evaluate(
    ({ grid, wins }) => {
      const p = (window as any).__propvim;
      const g = document.querySelector<HTMLElement>(`.grid[data-grid="${grid}"]`)!.getBoundingClientRect();
      return wins.map((w: number) => {
        const box = [...p.state.wins.values()].find((b: any) => b.win === w);
        const r = document.querySelector<HTMLElement>(`.grid[data-grid="${box.grid}"]`)!.getBoundingClientRect();
        return { left: r.left - g.left, right: r.right - g.left, top: r.top - g.top, bottom: r.bottom - g.top };
      });
    },
    { grid, wins },
  );
  const ch = await page.evaluate(() => (window as any).__propvim.metrics.ch);
  const rowTop = cur.top;
  corners.forEach((corner, i) => {
    const b = boxes[i];
    const x = corner.endsWith('W') ? b.left : b.right;
    const y = corner.startsWith('N') ? b.top : b.bottom;
    expect(Math.abs(x - cur.left), `${corner} x`).toBeLessThanOrEqual(1);
    expect(Math.abs(y - rowTop), `${corner} y`).toBeLessThanOrEqual(1);
  });
  expect(ch).toBeGreaterThan(0);
  await screenshot(page, 'S9-floats');
});

test('S10: inline code in Markdown renders in the mono font', async ({ page }) => {
  await open(page, { file: MD });
  const fonts = await page.evaluate(async () => {
    const p = (window as any).__propvim;
    const spans = [...document.querySelectorAll<HTMLElement>('.pc > span')];
    const code = spans.find((s) => s.textContent!.includes('inline code'))!;
    const plain = spans.find((s) => s.textContent!.startsWith('Some'))!;
    return { code: getComputedStyle(code).fontFamily, plain: getComputedStyle(plain).fontFamily, mono: p.metrics.fonts.monoFamily };
  });
  expect(fonts.plain).toContain('Charter');
  expect(fonts.code).not.toContain('Charter');
  expect(fonts.mono).toContain(fonts.code.split(',')[0].replace(/"/g, ''));
});

test('S11: :PropvimReload applies a new prose_size; a bad value warns and the app keeps running', async ({ page }) => {
  await open(page, { file: MD });
  const size = () => page.evaluate(() => getComputedStyle(document.querySelector('.pc > span')!).fontSize);
  expect(await size()).toBe('16px');
  await lua(page, 'vim.g.propvim = { prose_size = 22 }');
  await input(page, ':PropvimReload<CR>');
  await expect.poll(size).toBe('22px');

  await lua(page, "vim.g.propvim = { prose_size = 22, overflow = 'bad' }");
  await input(page, ':PropvimReload<CR>');
  const messages = async () =>
    page.evaluate(() => {
      const p = (window as any).__propvim;
      const msg = [...p.state.wins.values()].find((b: any) => b.kind === 'msg');
      return msg ? p.state.grids.get(msg.grid).rows.map((r: any) => r.text.join('')).join('\n') : '';
    });
  await expect.poll(messages).toContain('propvim: overflow must be "shrink" or "clip"');
  const dom = await page.evaluate(() => document.getElementById('screen')!.textContent);
  expect(dom).toContain('propvim: overflow must be');
  expect(await size()).toBe('22px');
  expect(await page.evaluate(() => (window as any).__propvim.config.overflow)).toBe('shrink');
  // Still responsive.
  await input(page, '<CR>ggdd');
  expect(await lua(page, 'return vim.api.nvim_buf_get_lines(0, 0, 1, false)[1]')).toBe('');
});

test('linespace in vim.g.propvim adds pixels to every row and overrides the option', async ({ page }) => {
  await open(page, { file: MD, cmds: ['set linespace=2'] });
  const ch = () => page.evaluate(() => (window as any).__propvim.metrics.ch);
  const before = await ch();
  await lua(page, 'vim.g.propvim = { linespace = 8 }');
  await input(page, ':PropvimReload<CR>');
  await expect.poll(ch).toBe(before + 6);
  const rows = await lua<number>(page, 'return vim.o.lines');
  expect(rows).toBe(await page.evaluate(() => Math.floor(window.innerHeight / (window as any).__propvim.metrics.ch)));
});

test('Cmd keys: the bridge maps <D-c>/<D-v>/<D-a> only where the user has not', async ({ page }) => {
  await open(page, { file: MD, cmds: ['nnoremap <D-a> <Nop>'] });
  await input(page, '');
  const maps = await lua<Record<string, string>>(
    page,
    `local function m(lhs, mode) return vim.fn.maparg(lhs, mode, false, true).desc or vim.fn.maparg(lhs, mode) end
     return { c = m('<D-c>', 'x'), v_n = m('<D-v>', 'n'), v_i = m('<D-v>', 'i'), v_c = m('<D-v>', 'c'), a = m('<D-a>', 'n') }`,
  );
  expect(maps).toEqual({ c: 'propvim: copy', v_n: 'propvim: paste', v_i: 'propvim: paste', v_c: 'propvim: paste', a: '<Nop>' });
});

test('Cmd-= / Cmd-- / Cmd-0 change both font sizes for the session', async ({ page }) => {
  await open(page, { file: MD });
  const sizes = () => page.evaluate(() => {
    const f = (window as any).__propvim.metrics.fonts;
    return [f.monoSize, f.proseSize];
  });
  const [mono, prose] = await sizes();
  const press = (key: string) => page.keyboard.press(`Meta+${key}`);
  await press('Equal');
  await press('Equal');
  expect(await sizes()).toEqual([mono + 2, prose + 2]);
  await press('Minus');
  expect(await sizes()).toEqual([mono + 1, prose + 1]);
  await press('Digit0');
  expect(await sizes()).toEqual([mono, prose]);
  // The grid follows the new cell size.
  await press('Equal');
  await input(page, '');
  const cols = await lua<number>(page, 'return vim.o.columns');
  const expected = await page.evaluate(() => Math.floor(window.innerWidth / (window as any).__propvim.metrics.cw));
  expect(cols).toBe(expected);
});
