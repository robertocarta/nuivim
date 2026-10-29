// Tabs (one Neovim each), the shell command's open requests, settings.
import path from 'node:path';
import { test, type Page } from '@playwright/test';
import { expect, input, lua, open, settle } from './helpers';
import { ROOT } from './nvim-rpc';

const tabs = (page: Page) =>
  page.evaluate(() => {
    const app = (window as any).__nuivim.app;
    return { ids: app.tabs.list.map((t: any) => t.id), titles: app.tabs.list.map((t: any) => t.title), active: app.tabs.active };
  });
const tabBarVisible = (page: Page) => page.evaluate(() => !document.getElementById('tabbar')!.hidden);
const menu = (page: Page, id: string) => page.evaluate((id) => (window as any).__nuivim.transport.simulateMenu(id), id);
const waitTabs = async (page: Page, n: number) => {
  await expect.poll(async () => (await tabs(page)).ids.length).toBe(n);
  if (n) await settle(page);
};

test('tabs: each has its own Neovim; the tab bar hides with one tab; ⌘1/⌘2 switch', async ({ page }) => {
  await open(page, { file: 'tests/fixtures/prose.md' });
  expect(await tabBarVisible(page)).toBe(false);
  const pid1 = await lua<number>(page, 'return vim.fn.getpid()');

  await menu(page, 'new-tab');
  await waitTabs(page, 2);
  expect(await tabBarVisible(page)).toBe(true);
  const pid2 = await lua<number>(page, 'return vim.fn.getpid()');
  expect(pid2).not.toBe(pid1);
  expect((await tabs(page)).titles[0]).toBe('prose.md');

  await page.keyboard.press('Meta+1');
  expect(await lua<number>(page, 'return vim.fn.getpid()')).toBe(pid1);
  await page.keyboard.press('Meta+2');
  expect(await lua<number>(page, 'return vim.fn.getpid()')).toBe(pid2);
  // Only the active tab's screen is shown.
  expect(await page.evaluate(() => document.querySelectorAll('.screen.active').length)).toBe(1);

  // :q in the second tab closes only that tab.
  await page.keyboard.type(':q');
  await page.keyboard.press('Enter');
  await waitTabs(page, 1);
  expect(await tabBarVisible(page)).toBe(false);
  expect(await lua<number>(page, 'return vim.fn.getpid()')).toBe(pid1);
});

test('tab bar stays visible with one tab when autohide is off; clicks select and close tabs', async ({ page }) => {
  await open(page, { settings: { autohide_tabs: false } });
  expect(await tabBarVisible(page)).toBe(true);
  await page.click('#tabbar .new-tab');
  await waitTabs(page, 2);
  const { ids } = await tabs(page);
  await page.click(`#tabbar .tab[data-tab="${ids[0]}"] .label`);
  expect((await tabs(page)).active).toBe(ids[0]);
  await page.hover(`#tabbar .tab[data-tab="${ids[1]}"]`);
  await page.click(`#tabbar .tab[data-tab="${ids[1]}"] .close`);
  await waitTabs(page, 1);
  expect(await tabBarVisible(page)).toBe(true);
});

test('the shell command opens a new tab in the directory it was run from', async ({ page }) => {
  await open(page, { file: 'tests/fixtures/prose.md', settings: { working_directory: 'tests', homepage: 'fixtures/prose.md' } });
  const dir = path.join(ROOT, 'tests/fixtures/drop dir');
  await page.evaluate((dir) => (window as any).__nuivim.transport.simulateOpenRequest({ cwd: dir, files: ['notes 100% done.md'] }), dir);
  await waitTabs(page, 2);
  expect(await lua(page, 'return vim.fn.getcwd()')).toBe(dir);
  expect(await lua(page, 'return vim.api.nvim_buf_get_name(0)')).toBe(path.join(dir, 'notes 100% done.md'));
  expect((await tabs(page)).titles[1]).toBe('notes 100% done.md');
  await expect.poll(() => page.title()).toBe('notes 100% done.md — NuiVim');
});

test('new tabs start in the working directory with the homepage', async ({ page }) => {
  await open(page, { settings: { working_directory: 'tests/fixtures', homepage: 'prose.md' } });
  expect(await lua(page, 'return vim.fn.getcwd()')).toBe(path.join(ROOT, 'tests/fixtures'));
  expect(await lua(page, 'return vim.fn.expand("%:t")')).toBe('prose.md');
  await menu(page, 'new-tab');
  await waitTabs(page, 2);
  expect(await lua(page, 'return vim.fn.getcwd()')).toBe(path.join(ROOT, 'tests/fixtures'));
  expect(await lua(page, 'return vim.fn.expand("%:t")')).toBe('prose.md');
});

test('a missing working directory falls back to home', async ({ page }) => {
  await open(page, { settings: { working_directory: 'no/such/dir' } });
  expect(await lua(page, 'return vim.fn.getcwd()')).toBe(ROOT);
});

test('settings: saving applies to every tab; vim.g.nuivim keys are shown as overridden', async ({ page }) => {
  await open(page, { file: 'tests/fixtures/prose.md' });
  await menu(page, 'new-tab');
  await waitTabs(page, 2);
  await input(page, ':e tests/fixtures/prose.md<CR>');
  await lua(page, "vim.g.nuivim = { prose_font = 'Georgia' }");
  await input(page, ':NuivimReload<CR>');

  await menu(page, 'settings');
  await expect(page.locator('form.settings')).toBeVisible();
  await expect(page.locator('input[name="prose_font"]')).toBeDisabled();
  await expect(page.locator('form.settings')).toContainText('Set by vim.g.nuivim');
  await page.fill('input[name="prose_size"]', '21');
  await page.selectOption('select[name="overflow"]', 'clip');
  await page.uncheck('input[name="autohide_tabs"]');
  await page.click('button.primary');
  await expect(page.locator('form.settings')).toHaveCount(0);

  const fontOf = () =>
    page.evaluate(() => {
      const span = document.querySelector('.screen.active .pc > span')!;
      return [getComputedStyle(span).fontSize, getComputedStyle(span).fontFamily];
    });
  await expect.poll(fontOf).toEqual(['21px', expect.stringContaining('Georgia')]);
  await page.keyboard.press('Meta+1');
  await expect.poll(fontOf).toEqual(['21px', expect.stringContaining('Charter')]);
  const saved = await page.evaluate(() => (window as any).__nuivim.transport.settings);
  expect(saved).toEqual({ working_directory: '', homepage: '', autohide_tabs: false, appearance: { prose_size: 21, overflow: 'clip' } });

  // A bad value is refused with a message, and nothing is saved.
  await menu(page, 'settings');
  await page.fill('input[name="linespace"]', '2.5');
  await page.click('button.primary');
  await expect(page.locator('form.settings .error')).toContainText('Line spacing (px) must be a whole number');
  await page.keyboard.press('Escape');
  await expect(page.locator('form.settings')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__nuivim.transport.settings.appearance.linespace)).toBeUndefined();
});

test('highlights stay separate between tabs', async ({ page }) => {
  await open(page, { file: 'tests/fixtures/prose.md' });
  const bg = () => page.evaluate(() => getComputedStyle(document.querySelector('.screen.active .grid')!).backgroundColor);
  const first = await bg();
  await menu(page, 'new-tab');
  await waitTabs(page, 2);
  await lua(page, "vim.cmd('hi Normal guibg=#336699')");
  await expect.poll(bg).toBe('rgb(51, 102, 153)');
  await page.keyboard.press('Meta+1');
  expect(await bg()).toBe(first);
});

test('quit asks every tab to quit, then quits the app', async ({ page }) => {
  await open(page, { file: 'tests/fixtures/prose.md' });
  await menu(page, 'new-tab');
  await waitTabs(page, 2);
  await menu(page, 'quit');
  await waitTabs(page, 0);
  expect(await page.evaluate(() => (window as any).__nuivim.transport.quitCalls)).toBe(1);
});
