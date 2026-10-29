// M1: monospace renderer scenarios S1–S4.
import { test } from '@playwright/test';
import { call, domRowText, expect, input, lua, open, screenRowText, screenshot } from './helpers';

test('S1: every drawn row matches the screen text Neovim reports', async ({ page }) => {
  await open(page, { file: 'tests/fixtures/sample.lua' });
  const wins = await page.evaluate(() =>
    [...(window as any).__nuivim.state.wins.values()].filter((b: any) => b.kind === 'win').map((b: any) => ({ ...b })),
  );
  expect(wins).toHaveLength(1);
  const w = wins[0];
  for (let r = 0; r < w.height; r++) {
    expect(await domRowText(page, w.grid, r)).toBe(await screenRowText(page, w.row + r, w.col, w.width));
  }
  // Grid 1 rows outside the window: the statusline.
  const rows = await lua<number>(page, 'return vim.o.lines');
  for (let r = w.row + w.height; r < rows - 1; r++) {
    expect(await domRowText(page, 1, r)).toBe(await screenRowText(page, r));
  }
});

test('S2: :vsplit then :split gives three window boxes and separators on grid 1', async ({ page }) => {
  await open(page, { file: 'tests/fixtures/sample.lua' });
  await input(page, ':vsplit<CR>:split<CR>');
  const boxes = await page.evaluate(() => {
    const p = (window as any).__nuivim;
    return [...p.state.wins.values()]
      .filter((b: any) => b.kind === 'win' && !b.hidden)
      .map((b: any) => {
        const el = document.querySelector<HTMLElement>(`.screen.active .grid[data-grid="${b.grid}"]`)!;
        const r = el.getBoundingClientRect();
        const s = document.querySelector('.screen.active')!.getBoundingClientRect();
        return { row: b.row, col: b.col, x: r.left - s.left, y: r.top - s.top, cw: p.metrics.cw, ch: p.metrics.ch };
      });
  });
  expect(boxes).toHaveLength(3);
  for (const b of boxes) {
    expect(Math.abs(b.x - b.col * b.cw)).toBeLessThan(0.5);
    expect(Math.abs(b.y - b.row * b.ch)).toBeLessThan(0.5);
  }
  const sepCol = Math.max(...boxes.map((b) => b.col)) - 1;
  const row0 = await domRowText(page, 1, 0);
  expect([...row0][sepCol]).toBe('│');
  // Horizontal split: the upper-left window's statusline is drawn on grid 1.
  const lower = boxes.find((b) => b.row > 0)!;
  expect(await domRowText(page, 1, lower.row - 1)).toBe(await screenRowText(page, lower.row - 1, 0, sepCol + 1));
});

test('S3: float with border, box drawing, CJK and emoji keeps every character on its cell', async ({ page }) => {
  await open(page);
  await lua(
    page,
    `local b = vim.api.nvim_create_buf(false, true)
     vim.api.nvim_buf_set_lines(b, 0, -1, false, {
       '┌────┬──────┐', '│ ab │ 漢字 │', '├────┼──────┤', '│ 😀 │ x    │', '└────┴──────┘', 'かなカナ ok' })
     vim.api.nvim_open_win(b, false, {relative='editor', row=3, col=10, width=16, height=6, border='rounded'})`,
  );
  await input(page, '');
  const off = await page.evaluate(() => {
    const p = (window as any).__nuivim;
    const cw: number = p.metrics.cw;
    const f = [...p.state.wins.values()].find((b: any) => b.kind === 'float');
    const gridEl = document.querySelector<HTMLElement>(`.screen.active .grid[data-grid="${f.grid}"]`)!;
    const base = gridEl.getBoundingClientRect().left;
    const worst: { ch: string; err: number }[] = [];
    let count = 0;
    // Each character is measured as its own element in a clone of its span.
    for (const span of gridEl.querySelectorAll<HTMLElement>('.row > span')) {
      const col = Math.round(parseFloat(span.style.left) / cw);
      const clone = span.cloneNode(false) as HTMLElement;
      const chars = [...(span.textContent ?? '')];
      for (const ch of chars) {
        const s = document.createElement('span');
        s.textContent = ch;
        clone.appendChild(s);
      }
      span.parentElement!.appendChild(clone);
      [...clone.children].forEach((s, i) => {
        if (chars[i] === ' ') return;
        const left = s.getBoundingClientRect().left - base;
        worst.push({ ch: chars[i], err: Math.abs(left - (col + i) * cw) });
        count++;
      });
      clone.remove();
    }
    worst.sort((a, b) => b.err - a.err);
    return { count, worst: worst.slice(0, 3) };
  });
  expect(off.count).toBeGreaterThan(40);
  expect(off.worst[0].err, JSON.stringify(off.worst)).toBeLessThanOrEqual(0.5);
  await screenshot(page, 'S3-float');
});

test('S4: insert-mode completion popup with 5 candidates aligns to cells', async ({ page }) => {
  await open(page, { file: 'tests/fixtures/words.txt', cmds: ['set ft=', 'set completeopt=menuone'] });
  await input(page, 'Goalp<C-n>');
  const pum = await page.evaluate(() => {
    const p = (window as any).__nuivim;
    const { cw, ch } = p.metrics;
    const f = [...p.state.wins.values()].find((b: any) => b.kind === 'float' && !b.hidden);
    if (!f) return null;
    const g = p.state.grids.get(f.grid);
    const el = document.querySelector<HTMLElement>(`.screen.active .grid[data-grid="${f.grid}"]`)!;
    const anchor = document.querySelector<HTMLElement>(`.screen.active .grid[data-grid="${f.float.anchorGrid}"]`)!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const lefts = [...el.querySelectorAll<HTMLElement>('.row > span')].map((s) => s.getBoundingClientRect().left - r.left);
    return {
      height: g.height,
      dx: r.left - anchor.left - f.float.anchorCol * cw,
      dy: r.top - anchor.top - f.float.anchorRow * ch,
      // Span edges are snapped to device pixels: within 0.5px of a cell boundary.
      offGrid: lefts.filter((x) => Math.abs(x - Math.round(x / cw) * cw) > 0.5).length,
      rows: g.rows.map((row: any) => row.text.join('').trim()),
    };
  });
  expect(pum).not.toBeNull();
  expect(pum!.height).toBe(5);
  expect(pum!.rows.map((r: string) => r.split(/\s+/)[0])).toEqual(['alpha1', 'alpha2', 'alpha3', 'alpha4', 'alpha5']);
  expect(Math.abs(pum!.dx)).toBeLessThan(0.5);
  expect(Math.abs(pum!.dy)).toBeLessThan(0.5);
  expect(pum!.offGrid).toBe(0);
  expect(await call(page, 'nvim_get_mode')).toMatchObject({ mode: expect.stringMatching(/^i/) });
});
