// Shared helpers for the end-to-end scenarios.

import { expect, type Page } from '@playwright/test';
import { HARNESS_PORT } from '../../playwright.config';

export interface Session {
  file?: string;
  cmds?: string[];
}

/** Opens the frontend on a fresh Neovim (via the harness) and waits for the first paint. */
export async function open(page: Page, s: Session = {}): Promise<void> {
  const q = new URLSearchParams({ ws: String(HARNESS_PORT) });
  if (s.file) q.set('file', s.file);
  for (const c of s.cmds ?? []) q.append('cmd', c);
  await page.goto(`/?${q}`);
  await page.waitForFunction(() => {
    const p = (window as any).__propvim;
    return p && p.renderer.stats.times.length > 0 && p.state.wins.size > 0;
  });
  await settle(page);
}

/** Calls a Neovim API method through the page's transport. */
export function call<T = unknown>(page: Page, method: string, params: unknown[] = []): Promise<T> {
  return page.evaluate(([m, p]) => (window as any).__propvim.transport.call(m, p), [method, params] as const) as Promise<T>;
}

export function lua<T = unknown>(page: Page, code: string, args: unknown[] = []): Promise<T> {
  return call<T>(page, 'nvim_exec_lua', [code, args]);
}

/** Sends keys and waits until Neovim has redrawn. */
export async function input(page: Page, keys: string): Promise<void> {
  await call(page, 'nvim_input', [keys]);
  await settle(page);
}

/** Waits for Neovim to finish pending work and for the resulting paints. */
export async function settle(page: Page): Promise<void> {
  await call(page, 'nvim_eval', ['1']);
  // Two round trips: one for the redraw that follows the input, one for any window-info query it triggers.
  await page.waitForTimeout(60);
  await call(page, 'nvim_eval', ['1']);
  await page.waitForTimeout(60);
}

export async function screenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `tests/e2e/screenshots/${name}.png` });
}

export { expect };

/** Row text of a grid as drawn in the DOM, rebuilt cell by cell from span positions. */
export function domRowText(page: Page, grid: number, row: number): Promise<string> {
  return page.evaluate(
    ([grid, row]) => {
      const p = (window as any).__propvim;
      const cw: number = p.metrics.cw;
      const g = p.state.grids.get(grid);
      const rowObj = g.rows[row];
      const el = document.querySelector(`.grid[data-grid="${grid}"]`)!;
      const rowEl = [...el.querySelectorAll<HTMLElement>(':scope > .row')].find((r) => Math.round(parseFloat(r.style.top) / p.metrics.ch) === row)!;
      const cells: string[] = new Array(g.width).fill(' ');
      for (const span of rowEl.querySelectorAll<HTMLElement>(':scope > span')) {
        const col = Math.round(parseFloat(span.style.left) / cw);
        const chars = [...(span.textContent ?? '')];
        if (chars.length === 1) cells[col] = chars[0];
        else chars.forEach((c, i) => (cells[col + i] = c));
      }
      void rowObj;
      return cells.join('').trimEnd();
    },
    [grid, row] as const,
  );
}

/** Screen text Neovim reports for a screen row (0-based), from screenstring(). */
export function screenRowText(page: Page, row: number, col = 0, width?: number): Promise<string> {
  return lua<string>(
    page,
    `local row, col, width = ...
     local out = {}
     for c = col + 1, col + width do out[#out + 1] = vim.fn.screenstring(row + 1, c) end
     return (table.concat(out):gsub('%s+$', ''))`,
    [row, col, width ?? 0],
  ).then(async (s) => (width === undefined ? screenRowText(page, row, col, await lua<number>(page, 'return vim.o.columns')) : s));
}
