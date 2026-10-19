import { defineConfig } from 'vite';

// Tauri expects a fixed dev port; tests use their own (see playwright.config.ts).
export default defineConfig({
  clearScreen: false,
  server: { port: Number(process.env.NUIVIM_VITE_PORT ?? 1420), strictPort: true, host: '127.0.0.1' },
  build: { target: 'safari15', outDir: 'dist', emptyOutDir: true },
});
