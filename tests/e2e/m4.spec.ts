// M4: input methods, file drop, focus, wheel, performance.
import path from 'node:path';
import { test } from '@playwright/test';
import { call, expect, input, lua, open } from './helpers';
import { ROOT } from './nvim-rpc';

test('S12: composing かな types it; a dropped path with spaces and % opens that file', async ({ page }) => {
  await open(page, { file: 'tests/fixtures/prose.md' });
  await input(page, 'Go');
  const overlay = await page.evaluate(() => {
    const ta = document.getElementById('input') as HTMLTextAreaElement;
    ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'か' }));
    ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'かな' }));
    const ime = document.getElementById('ime')!;
    return { text: ime.textContent, visible: ime.style.display !== 'none', underline: getComputedStyle(ime).textDecorationLine };
  });
  expect(overlay).toEqual({ text: 'かな', visible: true, underline: 'underline' });
  // Nothing reaches Neovim while composing.
  expect(await lua(page, 'return vim.api.nvim_get_current_line()')).toBe('');
  await page.evaluate(() => {
    const ta = document.getElementById('input') as HTMLTextAreaElement;
    ta.dispatchEvent(new CompositionEvent('compositionend', { data: 'かな' }));
  });
  await input(page, '');
  expect(await lua(page, 'return vim.api.nvim_get_current_line()')).toBe('かな');
  expect(await page.evaluate(() => document.getElementById('ime')!.style.display)).toBe('none');

  await input(page, '<Esc>');
  const dropped = path.join(ROOT, 'tests/fixtures/drop dir/notes 100% done.md');
  await page.evaluate((p) => (window as any).__propvim.transport.simulateOpenFiles([p]), dropped);
  await input(page, '');
  await expect.poll(() => call(page, 'nvim_buf_get_name', [0])).toBe(dropped);
  expect(await lua(page, 'return vim.api.nvim_buf_get_lines(0, 0, 1, false)[1]')).toBe('dropped file');
});

test('typing goes through the textarea, with < escaped', async ({ page }) => {
  await open(page);
  await page.keyboard.press('i');
  await page.keyboard.type('a<b> é');
  await page.keyboard.press('Escape');
  await input(page, '');
  expect(await lua(page, 'return vim.api.nvim_get_current_line()')).toBe('a<b> é');
  expect(await call(page, 'nvim_get_mode')).toMatchObject({ mode: 'n' });
});

test('window focus and blur reach Neovim as FocusGained/FocusLost', async ({ page }) => {
  await open(page);
  await lua(page, `vim.g.focus_log = {}
    vim.api.nvim_create_autocmd({'FocusGained', 'FocusLost'}, { callback = function(a) local l = vim.g.focus_log; table.insert(l, a.event); vim.g.focus_log = l end })`);
  await page.evaluate(() => {
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
  });
  await expect.poll(() => lua(page, 'return vim.g.focus_log')).toEqual(['FocusLost', 'FocusGained']);
  expect(await page.evaluate(() => document.body.classList.contains('unfocused'))).toBe(false);
});

test('wheel deltas accumulate: one scroll step per cell height crossed', async ({ page }) => {
  await open(page, { file: 'tests/fixtures/long.txt', cmds: ['set ft=', 'set mousescroll=ver:1'] });
  const ch = await page.evaluate(() => (window as any).__propvim.metrics.ch);
  await page.mouse.move(300, 200);
  // 10 small deltas of ch/4 cross 2 cell heights (plus a remainder).
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, ch / 4);
  await input(page, '');
  await expect.poll(() => lua(page, 'return vim.fn.line("w0")')).toBe(3);
});

test('performance: 95th percentile paint under 16ms while scrolling 10,000 lines; full repaint of 200x60', async ({ page }) => {
  // A 200 × 60 grid.
  const cell = { w: 8.43, h: 20 };
  await page.setViewportSize({ width: Math.ceil(200 * cell.w) + 2, height: 61 * cell.h });
  for (const ft of ['text', '']) {
    await open(page, { file: 'tests/fixtures/long.txt', cmds: [`set ft=${ft}`, 'set number'] });
    const before = await page.evaluate(() => (window as any).__propvim.renderer.stats.times.length);
    await page.evaluate(async () => {
      const t = (window as any).__propvim.transport;
      for (let i = 0; i < 200; i++) {
        await t.call('nvim_input', ['<C-e>']);
        await new Promise((r) => setTimeout(r, 5));
      }
    });
    await input(page, '');
    const times: number[] = await page.evaluate((n) => (window as any).__propvim.renderer.stats.times.slice(n), before);
    expect(await lua(page, 'return vim.fn.line("w0")')).toBe(201);
    const sorted = [...times].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    console.log(`ft=${ft || 'none'}: ${times.length} paints, p50 ${sorted[Math.floor(sorted.length / 2)].toFixed(2)}ms, p95 ${p95.toFixed(2)}ms, max ${sorted.at(-1)!.toFixed(2)}ms`);
    expect(p95).toBeLessThan(16);

    // Full repaint: every row of every grid redrawn.
    const size = await lua<number[]>(page, 'return { vim.o.columns, vim.o.lines }');
    expect(size[0]).toBeGreaterThanOrEqual(199);
    expect(size[1]).toBeGreaterThanOrEqual(60);
    const full = await page.evaluate(async () => {
      const p = (window as any).__propvim;
      p.state.markAllDirty();
      const t0 = performance.now();
      p.renderer.paint(p.state);
      return performance.now() - t0;
    });
    console.log(`ft=${ft || 'none'}: full repaint ${full.toFixed(2)}ms`);
    expect(full).toBeLessThan(16);
  }
});
