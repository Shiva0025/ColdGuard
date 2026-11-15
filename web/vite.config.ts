import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API = process.env.COLDGUARD_API ?? 'http://127.0.0.1:4000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: true, // reachable from phones on the same Wi-Fi (judges join by QR)
    // Public tunnels (Cloudflare quick tunnel, ngrok) for phones on other networks; extend with COLDGUARD_ALLOWED_HOSTS=a.example,b.example
    allowedHosts: ['.trycloudflare.com', '.ngrok-free.app', '.ngrok-free.dev', '.ngrok.app', '.ngrok.io', ...(process.env.COLDGUARD_ALLOWED_HOSTS?.split(',').filter(Boolean) ?? [])],
    proxy: {
      '/api': API,
      '/socket.io': { target: API, ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
});
