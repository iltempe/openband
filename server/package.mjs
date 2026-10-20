// Where OpenBand is installed from. The npm name "openband" is held by someone else (a "reserved" 0.0.0
// package), so `npx openband` would run a stranger's code. OpenBand installs from its GitHub Releases
// instead: each release carries the built package as openband.tgz, which npx runs directly (any npm
// version, no build on the user's machine). One place to change it — the app keeps the same strings in
// src/install.ts (a test checks they match).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = 'iltempe/openband';
/** The newest release: what people type the first time. */
export const PACKAGE_SPEC = `https://github.com/${REPO}/releases/latest/download/openband.tgz`;
/** One release exactly (MCP client configs pin it, so npx never runs a stale cached copy by mistake). */
export const versionSpec = (version) => `https://github.com/${REPO}/releases/download/v${version}/openband-${version}.tgz`;
/** npx flags: npm 12 refuses to fetch a tarball URL unless allowed (npm 10/11 ignore the flag). */
export const NPX_ARGS = ['-y', '--allow-remote=all'];
/** The command people type. */
export const RUN = `npx ${NPX_ARGS.join(' ')} ${PACKAGE_SPEC}`;
/** Is this npx argument one of OpenBand's packages (any release)? */
export const isOurPackage = (arg) => typeof arg === 'string' && arg.startsWith(`https://github.com/${REPO}/releases/`) && arg.endsWith('.tgz');

const version = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;
/** The entry `setup` writes into MCP clients: this version's release, no absolute paths. */
export const SERVER_ENTRY = { command: 'npx', args: [...NPX_ARGS, versionSpec(version), 'mcp'] };
