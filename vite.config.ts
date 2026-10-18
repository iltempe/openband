import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative asset paths: the same build works from the MCP server (/) and GitHub Pages (/openband/).
  base: './',
  server: { port: 5173 },
  build: { chunkSizeWarningLimit: 1200 },
  // Pure modules are tested in Node; anything needing a DOM opts into jsdom per file.
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
