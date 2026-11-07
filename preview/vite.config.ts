import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ root: process.cwd(), plugins: [react()], server: { port: 5199 } });
