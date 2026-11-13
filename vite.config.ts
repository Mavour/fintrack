import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/web',
  build: {
    outDir: '../../dist/public',
    emptyOutDir: true,
  },
  // Stempel build untuk diagnosis versi di UI (bukti update terlihat).
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3100',
      '/health': 'http://localhost:3100',
    },
  },
});
