import { test } from '@playwright/test';
import { open, screenshot } from './helpers';

test('smoke', async ({ page }) => {
  page.on('console', (m) => console.log('console:', m.text()));
  await open(page, { file: 'tests/fixtures/prose.md', cmds: ['set number'] });
  await screenshot(page, 'smoke');
});
