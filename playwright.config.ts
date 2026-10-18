import { defineConfig, devices } from '@playwright/test';

// Keep Playwright's WebKit inside node_modules rather than the user's cache.
process.env.PLAYWRIGHT_BROWSERS_PATH = '0';

export const VITE_PORT = 5197;
export const HARNESS_PORT = 5198;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  workers: 4,
  timeout: 30_000,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${VITE_PORT}`, viewport: { width: 1000, height: 700 } },
  projects: [{ name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1000, height: 700 }, deviceScaleFactor: 2 } }],
  webServer: [
    {
      command: `PROPVIM_VITE_PORT=${VITE_PORT} npx vite`,
      url: `http://127.0.0.1:${VITE_PORT}`,
      reuseExistingServer: false,
    },
    {
      command: `npx tsx tests/e2e/harness.ts --port ${HARNESS_PORT}`,
      port: HARNESS_PORT,
      reuseExistingServer: false,
    },
  ],
});
