import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  root: 'src/web',
  build: {
    outDir: '../../dist/public',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
});
