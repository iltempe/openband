import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative asset paths: the same build works from the MCP server (/) and GitHub Pages (/openband/).
  base: './',
  server: { port: 5173 },
  build: { chunkSizeWarningLimit: 1200 },
});
