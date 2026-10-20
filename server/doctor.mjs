// openband doctor: is everything in place? ✓/✗ with a fix for each ✗. Returns the exit code.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasCommand, jsonClients, openbandEntry, readConfig } from './clients.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Is something listening on 127.0.0.1:port? */
export const portInUse = (port) =>
  new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.on('error', () => resolve(false));
    s.setTimeout(800, () => (s.destroy(), resolve(false)));
  });

/** Ask a server on the port whether it is OpenBand (its /version.json). */
async function whoIsOnPort(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/version.json`, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    return j?.app === 'openband' ? `OpenBand ${j.version}` : 'another program';
  } catch {
    return 'another program';
  }
}

export async function runChecks({ port = Number(process.env.OPENBAND_PORT || 7777), clients = jsonClients() } = {}) {
  const checks = [];
  /** ok: true / false; warn: not a failure (e.g. a client you may not use). */
  const add = (ok, label, fix, warn = false) => checks.push({ ok, label, ...(ok ? {} : { fix }), ...(warn && !ok ? { warn: true } : {}) });
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 18, `Node ${process.versions.node}`, 'Install Node 18 or newer from https://nodejs.org (or use the .mcpb extension for Claude Desktop).');
  const depVersion = (name) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')).version;
    } catch {
      return null;
    }
  };
  const deps = ['@modelcontextprotocol/sdk', 'ws', 'zod'].map((d) => [d, depVersion(d)]);
  const missingDeps = deps.filter(([, v]) => !v).map(([d]) => d);
  add(true, `OpenBand ${pkg.version} (${deps.filter(([, v]) => v).map(([d, v]) => `${d} ${v}`).join(', ')})`);
  if (missingDeps.length) add(false, `Missing packages: ${missingDeps.join(', ')}`, 'Reinstall: npx openband@latest (or npm install in a checkout).');
  add(fs.existsSync(path.join(root, 'dist', 'index.html')), 'Studio build (dist/)', 'Run "npm run build" (only needed in a git checkout; the npm package ships it).');
  if (await portInUse(port)) {
    const who = await whoIsOnPort(port);
    add(who.startsWith('OpenBand'), `Port ${port}: ${who} is running there`, `Port ${port} is taken by ${who}. OpenBand will use the next free port automatically, or set OPENBAND_PORT.`);
  } else add(true, `Port ${port} is free`);
  let anyClient = false;
  let configured = 0;
  for (const c of clients) {
    if (!fs.existsSync(c.dir)) continue;
    anyClient = true;
    let entry = null;
    try {
      entry = openbandEntry(readConfig(c.file), c.key);
    } catch {
      add(false, `${c.name}: config is not valid JSON`, `Fix ${c.file}`);
      continue;
    }
    const usesNpx = entry && entry.command === 'npx' && (entry.args ?? []).includes('openband');
    const usesPath = entry && (entry.args ?? []).some((a) => /mcp-server\.mjs$/.test(a));
    const pathOk = usesPath && (entry.args ?? []).every((a) => !/mcp-server\.mjs$/.test(a) || fs.existsSync(a));
    // A local checkout: which version is it?
    const checkout = usesPath ? (entry.args ?? []).find((a) => /mcp-server\.mjs$/.test(a)) : null;
    let checkoutVersion = '';
    try {
      if (checkout && pathOk) checkoutVersion = ` ${JSON.parse(fs.readFileSync(path.join(path.dirname(checkout), '..', 'package.json'), 'utf8')).version}`;
    } catch {
      // not an OpenBand checkout
    }
    if (entry && (usesNpx || pathOk)) configured++;
    // Not configured is only a warning (you may not use that client); a broken entry is an error.
    add(!!entry && (usesNpx || pathOk), `${c.name}: ${!entry ? 'OpenBand not configured' : usesNpx ? 'uses npx openband' : pathOk ? `uses a local checkout${checkoutVersion}` : 'points to a file that does not exist'}`, 'Run "npx openband setup".', !entry);
  }
  if (hasCommand('claude')) {
    anyClient = true;
    configured++;
    add(true, 'Claude Code CLI found (check with "claude mcp list")');
  }
  if (!anyClient) add(false, 'No MCP client found', 'Install Claude Desktop, Claude Code, Cursor or VS Code, then run "npx openband setup".');
  else if (!configured) add(false, 'No MCP client has OpenBand yet', 'Run "npx openband setup".');
  return checks;
}

export async function doctor() {
  const checks = await runChecks();
  for (const c of checks) {
    console.log(`${c.ok ? '✓' : c.warn ? '⚠' : '✗'} ${c.label}`);
    if (!c.ok) console.log(`    → ${c.fix}`);
  }
  return checks.every((c) => c.ok || c.warn) ? 0 : 1;
}
