import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';

// The Tauri CLI sets TAURI_ENV_* for its dev/build commands; then only the renderer is built and the
// Electron main/preload bundles are skipped (the Rust backend in src-tauri/ replaces them).
const tauri = !!process.env.TAURI_ENV_PLATFORM;

export default defineConfig({
  base: './',
  clearScreen: !tauri,
  server: tauri ? { port: 5173, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } } : undefined,
  plugins: [
    react(),
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
