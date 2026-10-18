// M2: prose windows, scenarios S5–S8.
import { test } from '@playwright/test';
import { call, currentWinGrid, cursorBox, expect, input, lua, open, proseCharBox, screenshot } from './helpers';

const MD = 'tests/fixtures/prose.md';

test('S5: Markdown with number and signcolumn=yes: prose text area, mono gutter on cells', async ({ page }) => {
  await open(page, { file: MD, cmds: ['set number signcolumn=yes'] });
  const grid = await currentWinGrid(page);
  const info = await page.evaluate((grid) => {
    const p = (window as any).__propvim;
    const cw: number = p.metrics.cw;
    const view = p.renderer.views.get(grid);
    const gridEl = document.querySelector<HTMLElement>(`.grid[data-grid="${grid}"]`)!;
    const g = gridEl.getBoundingClientRect();
    const rowEl = view.rowEls.get(p.state.grids.get(grid).rows[2].key) as HTMLElement;
    const pt = rowEl.querySelector<HTMLElement>('.pt')!;
    const gutter = [...rowEl.querySelectorAll<HTMLElement>(':scope > span')].map((s) => ({
      text: s.textContent,
      err: Math.abs(s.getBoundingClientRect().left - g.left - Math.round((s.getBoundingClientRect().left - g.left) / cw) * cw),
      font: getComputedStyle(s).fontFamily,
    }));
    return {
      textoff: view.textoff,
      proseFont: getComputedStyle(pt.querySelector('span')!).fontFamily,
      ptLeft: pt.getBoundingClientRect().left - g.left,
      cw,
      gutter,
      text: pt.textContent,
    };
  }, grid);
  expect(info.textoff).toBe(6); // 2 sign columns + number column of 4
  expect(info.proseFont).toContain('Charter');
  expect(Math.abs(info.ptLeft - info.textoff * info.cw)).toBeLessThan(0.5);
  expect(info.text).toBe('The quick brown fox jumps over the lazy dog. Typography matters for prose.');
  expect(info.gutter.map((s) => s.text!.trim()).join('')).toBe('3');
  for (const s of info.gutter) {
    expect(s.err).toBeLessThanOrEqual(0.5);
    expect(s.font).not.toContain('Charter');
  }
  await screenshot(page, 'S5-prose');
});

test('S6: the cursor follows mixed-width letters on a prose line', async ({ page }) => {
  await open(page, { file: MD, cmds: ['set number'] });
  await input(page, '4G0');
  const grid = await currentWinGrid(page);
  const textoff = await page.evaluate((g) => (window as any).__propvim.renderer.views.get(g).textoff, grid);
  const word = 'iiiWWWmmm';
  for (let i = 0; i < word.length; i++) {
    const cur = await cursorBox(page);
    const box = await proseCharBox(page, grid, 3, textoff + i);
    expect(cur.grid).toBe(grid);
    expect(Math.abs(cur.left - box.left), `column ${i} left`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(cur.width - box.width), `column ${i} width`).toBeLessThanOrEqual(0.5);
    if (i < word.length - 1) await input(page, 'l');
  }
});

test('S7: clicking the middle of the 5th character puts the cursor on column 4', async ({ page }) => {
  await open(page, { file: MD, cmds: ['set number'] });
  const grid = await currentWinGrid(page);
  const textoff = await page.evaluate((g) => (window as any).__propvim.renderer.views.get(g).textoff, grid);
  const box = await proseCharBox(page, grid, 2, textoff + 4);
  const origin = await page.evaluate((g) => {
    const r = document.querySelector<HTMLElement>(`.grid[data-grid="${g}"]`)!.getBoundingClientRect();
    return { x: r.left, y: r.top };
  }, grid);
  await page.mouse.click(origin.x + box.left + box.width / 2, origin.y + box.top + box.height / 2);
  await input(page, '');
  expect(await call(page, 'nvim_win_get_cursor', [0])).toEqual([3, 4]);
});

test('indentation and list markers keep cell widths in prose rows', async ({ page }) => {
  await open(page, { file: MD, cmds: ['set wrap linebreak breakindent breakindentopt=list:-1', 'set formatlistpat=^\\s*[-○]\\s\\+', '30vsplit', 'enew', 'set ft=markdown'] });
  await lua(
    page,
    `vim.api.nvim_buf_set_lines(0, 0, -1, false, {
       '- an item long enough to wrap onto a second row here',
       '○ Heading',
       'body under the heading',
     })
     -- Like orgmode's virtual indent: inline virtual spaces before the heading and its body.
     local ns = vim.api.nvim_create_namespace('t')
     vim.api.nvim_buf_set_extmark(0, ns, 1, 0, { virt_text = { { '    ' } }, virt_text_pos = 'inline' })
     vim.api.nvim_buf_set_extmark(0, ns, 2, 0, { virt_text = { { '      ' } }, virt_text_pos = 'inline' })`,
  );
  await input(page, 'G');
  const grid = await currentWinGrid(page);
  const cw = await page.evaluate(() => (window as any).__propvim.metrics.cw);
  const rowOf = (text: string) =>
    page.evaluate(
      ([g, text]) => (window as any).__propvim.state.grids.get(g).rows.findIndex((r: any) => r.text.join('').includes(text)),
      [grid, text] as const,
    );
  const itemRow = await rowOf('- an item');
  // Item text after "- " and its wrapped continuation both start at cell 2.
  expect(Math.abs((await proseCharBox(page, grid, itemRow, 2)).left - 2 * cw)).toBeLessThanOrEqual(0.5);
  expect(Math.abs((await proseCharBox(page, grid, itemRow + 1, 2)).left - 2 * cw)).toBeLessThanOrEqual(0.5);
  // Heading text after 4 virtual spaces and "○ " starts at cell 6, like the body under it.
  const heading = await rowOf('Heading');
  const body = await rowOf('body under');
  expect(Math.abs((await proseCharBox(page, grid, heading, 6)).left - 6 * cw)).toBeLessThanOrEqual(0.5);
  expect(Math.abs((await proseCharBox(page, grid, body, 6)).left - 6 * cw)).toBeLessThanOrEqual(0.5);
  // The cursor on the body's first letter is drawn there too.
  await input(page, '0');
  expect(Math.abs((await cursorBox(page)).left - 6 * cw)).toBeLessThanOrEqual(0.5);
  await screenshot(page, 'indent');
});

for (const overflow of ['shrink', 'clip'] as const) {
  test(`S8: 200 W characters in a narrow window (${overflow})`, async ({ page }) => {
    await open(page, { file: MD });
    await lua(page, `vim.g.propvim = { overflow = '${overflow}' }`);
    await input(page, ':PropvimReload<CR>:30vsplit<CR>:enew<CR>:set ft=markdown<CR>');
    await lua(page, `vim.api.nvim_buf_set_lines(0, 0, -1, false, { string.rep('W', 200) })`);
    await input(page, '');
    const grid = await currentWinGrid(page);
    const r = await page.evaluate((grid) => {
      const p = (window as any).__propvim;
      const gridEl = document.querySelector<HTMLElement>(`.grid[data-grid="${grid}"]`)!;
      const win = gridEl.getBoundingClientRect();
      const rows = [...gridEl.querySelectorAll<HTMLElement>('.row')].filter((r) => r.querySelector('.pc')?.textContent?.includes('W'));
      return {
        prose: p.renderer.views.get(grid).isProse,
        rows: rows.map((row) => {
          const pt = row.querySelector<HTMLElement>('.pt')!;
          const pc = row.querySelector<HTMLElement>('.pc')!;
          return {
            textRight: pc.getBoundingClientRect().right - win.left,
            ptRight: pt.getBoundingClientRect().right - win.left,
            overflow: getComputedStyle(pt).overflow,
            transform: pc.style.transform,
          };
        }),
        winWidth: win.width,
      };
    }, grid);
    expect(r.prose).toBe(true);
    expect(r.rows.length).toBeGreaterThan(5);
    for (const row of r.rows) {
      if (overflow === 'shrink') {
        expect(row.transform).toMatch(/^scaleX\(/);
        expect(row.textRight).toBeLessThanOrEqual(r.winWidth + 0.5);
      } else {
        expect(row.transform).toBe('');
        expect(row.textRight).toBeGreaterThan(r.winWidth); // the text is wider…
        expect(row.overflow).toBe('hidden'); // …but its box clips it
        expect(row.ptRight).toBeLessThanOrEqual(r.winWidth + 0.5);
      }
    }
    if (overflow === 'shrink') await screenshot(page, 'S8-shrink');
  });
}
