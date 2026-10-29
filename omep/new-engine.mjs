#!/usr/bin/env node
// omep-template: start a new OMEP engine from omep/template/.
//
//   node omep/new-engine.mjs <folder> [--id my-engine] [--name "My engine"] [--license MIT] [--homepage URL]
//   openband omep-new <folder> …
//
// It copies the template, fills in who the engine is, and says how to run and check it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function newEngine(dir, { id, name, license = 'MIT', homepage } = {}) {
  const folder = path.resolve(dir);
  if (fs.existsSync(folder) && fs.readdirSync(folder).length) throw new Error(`${folder} is not empty`);
  const engineId = (id ?? path.basename(folder)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(engineId)) throw new Error(`"${engineId}" is not a valid engine id (letters, digits, . _ -)`);
  const values = { __ID__: engineId, __NAME__: name ?? engineId, __LICENSE__: license, __HOMEPAGE__: homepage ?? `https://example.org/${engineId}` };
  fs.mkdirSync(folder, { recursive: true });
  for (const f of ['engine.mjs', 'package.json', 'README.md']) {
    let text = fs.readFileSync(path.join(here, 'template', f), 'utf8');
    for (const [k, v] of Object.entries(values)) text = text.split(k).join(f === 'package.json' ? JSON.stringify(v).slice(1, -1) : v);
    fs.writeFileSync(path.join(folder, f), text);
  }
  fs.chmodSync(path.join(folder, 'engine.mjs'), 0o755);
  return { folder, id: engineId };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (k) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
  };
  const o = { id: opt('id'), name: opt('name'), license: opt('license'), homepage: opt('homepage') };
  const dir = args[0];
  if (!dir) {
    console.error('Usage: omep-new <folder> [--id my-engine] [--name "My engine"] [--license MIT] [--homepage URL]');
    process.exit(2);
  }
  try {
    const r = newEngine(dir, Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)));
    console.log(`OMEP engine "${r.id}" in ${r.folder}\n\n  cd ${path.relative(process.cwd(), r.folder) || '.'}\n  npm install\n  npm run conformance\n\nThen replace makeDrums() in engine.mjs with your model.`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
