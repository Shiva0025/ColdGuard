import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API = process.env.COLDGUARD_API ?? 'http://127.0.0.1:4000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: true, // reachable from phones on the same Wi-Fi (judges join by QR)
    proxy: {
      '/api': API,
      '/socket.io': { target: API, ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
});
