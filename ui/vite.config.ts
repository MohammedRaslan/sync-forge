import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // During development the engine runs separately on :4000.
    proxy: { '/api': 'http://127.0.0.1:4000' },
  },
});
