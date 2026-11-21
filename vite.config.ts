import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';

// The Tauri CLI sets TAURI_ENV_* for its dev/build commands; then only the renderer is built and the
// Electron main/preload bundles are skipped (the Rust backend in src-tauri/ replaces them).
const tauri = !!process.env.TAURI_ENV_PLATFORM;

// Production-only CSP (Vite dev needs inline scripts and websockets for HMR). The renderer can reach
// git and a terminal over IPC, so script execution is limited to the bundled code.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' asset: http://asset.localhost data: blob: https:",
  "media-src 'self' asset: http://asset.localhost data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ipc: http://ipc.localhost",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const cspPlugin: Plugin = {
  name: 'gitverse-csp',
  apply: 'build',
  transformIndexHtml: () => [
    { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' },
  ],
};

export default defineConfig({
  base: './',
  clearScreen: !tauri,
  server: tauri ? { port: 5173, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } } : undefined,
  plugins: [
    react(),
    cspPlugin,
    ...(tauri
      ? []
      : [
          electron({
            main: {
              entry: 'electron/main.ts',
              vite: {
                build: {
                  outDir: 'dist-electron/main',
                  emptyOutDir: true,
                  rollupOptions: { external: ['node-pty', '@github/copilot-sdk'] },
                },
              },
            },
            preload: {
              input: 'electron/preload.ts',
              vite: { build: { outDir: 'dist-electron/preload', emptyOutDir: true } },
            },
          }),
        ]),
  ],
});
