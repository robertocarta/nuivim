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
