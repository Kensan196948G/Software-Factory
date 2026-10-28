import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5178,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:8781',
      '/healthz': 'http://127.0.0.1:8781',
      '/readyz': 'http://127.0.0.1:8781',
    },
  },
});
