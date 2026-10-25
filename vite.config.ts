import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Write dist/sw.js (precache of every built file) and dist/version.json after the build. */
function openbandPwa(): Plugin {
  let outDir = 'dist';
  return {
    name: 'openband-pwa',
    apply: 'build',
    configResolved(c) {
      outDir = c.build.outDir;
    },
    closeBundle() {
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const f of fs.readdirSync(dir)) {
          const full = path.join(dir, f);
          if (fs.statSync(full).isDirectory()) walk(full);
          else files.push(path.relative(outDir, full).split(path.sep).join('/'));
        }
      };
      walk(outDir);
      // Loop audio (F24) is cached when first used, not up front.
      const precache = ['./', ...files.filter((f) => f !== 'sw.js' && f !== 'version.json' && !f.endsWith('.map') && !f.endsWith('.wasm') && !(f.startsWith('loops/') && f.endsWith('.wav'))).map((f) => `./${f}`)];
      const hash = crypto.createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 10);
      const version = `${pkg.version}-${hash}`;
      const sw = fs.readFileSync('scripts/sw.template.js', 'utf8').replace('__VERSION__', version).replace('__PRECACHE__', JSON.stringify(precache, null, 1));
      fs.writeFileSync(path.join(outDir, 'sw.js'), sw);
      fs.writeFileSync(path.join(outDir, 'version.json'), JSON.stringify({ app: 'openband', version: pkg.version, build: version }) + '\n');
      // Deep links on static hosts (GitHub Pages serves 404.html for unknown paths).
      fs.copyFileSync(path.join(outDir, 'index.html'), path.join(outDir, '404.html'));
      // Headers for Netlify and Cloudflare Pages (the same CSP and cache rules as the Docker image).
      return import('./server/csp.mjs').then(({ contentSecurityPolicy, CACHE_RULES }) => {
        const lines = ['/*', `  Content-Security-Policy: ${contentSecurityPolicy()}`, '  X-Content-Type-Options: nosniff', '  Referrer-Policy: strict-origin-when-cross-origin', ''];
        for (const r of CACHE_RULES) lines.push(r.path, `  Cache-Control: ${r.value}`, '');
        fs.writeFileSync(path.join(outDir, '_headers'), lines.join('\n'));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), openbandPwa()],
  define: { __APP_VERSION__: JSON.stringify(JSON.parse(fs.readFileSync('package.json', 'utf8')).version) },
  // Relative asset paths: the same build works from the MCP server (/) and GitHub Pages (/openband/).
  base: './',
  server: { port: 5173 },
  build: { chunkSizeWarningLimit: 1200 },
  // Pure modules are tested in Node; anything needing a DOM opts into jsdom per file.
  test: { environment: 'node', include: ['src/**/*.test.ts', 'server/**/*.test.ts', 'omep/**/*.test.ts', 'deploy/**/*.test.ts'] },
});
