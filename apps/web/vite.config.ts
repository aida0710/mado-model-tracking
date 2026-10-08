import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5182,
    strictPort: true,
    // Route API preflights to the API's Origin policy instead of Vite's asset CORS middleware.
    cors: false,
    proxy: { '/api': 'http://127.0.0.1:4182' },
  },
});
