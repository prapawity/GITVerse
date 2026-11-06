import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';

export default defineConfig({
  base: './',
  plugins: [
    react(),
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
  ],
});
