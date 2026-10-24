#!/usr/bin/env node
// Build openband-plughost (G8) with CMake, for the desktop app.
//   node scripts/build-plughost.mjs [--arch x64|arm64] [--no-fixtures]
// macOS: one universal binary (arm64 + x86_64) in build/plughost. Windows and Linux: build/plughost for
// this machine's architecture, build/plughost-<arch> for the other one (Linux needs a cross compiler,
// e.g. gcc-aarch64-linux-gnu). The test fixtures are built for this machine only and never shipped.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arch = argv.includes('--arch') ? argv[argv.indexOf('--arch') + 1] : process.arch;
const native = process.platform === 'darwin' || arch === process.arch;
const fixtures = native && !argv.includes('--no-fixtures');
const dir = path.join(root, 'build', native ? 'plughost' : `plughost-${arch}`);
const EXE = process.platform === 'win32' ? 'openband-plughost.exe' : 'openband-plughost';

const args = ['-S', path.join(root, 'native', 'plughost'), '-B', dir, '-DCMAKE_BUILD_TYPE=Release', `-DOPENBAND_FIXTURES=${fixtures ? 'ON' : 'OFF'}`];
if (process.platform === 'darwin') args.push('-DCMAKE_OSX_ARCHITECTURES=arm64;x86_64', '-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0');
if (process.platform === 'win32') args.push('-A', arch === 'arm64' ? 'ARM64' : 'x64');
if (process.platform === 'linux' && !native) args.push(`-DCMAKE_C_COMPILER=${arch === 'arm64' ? 'aarch64-linux-gnu-gcc' : 'x86_64-linux-gnu-gcc'}`, `-DCMAKE_SYSTEM_PROCESSOR=${arch === 'arm64' ? 'aarch64' : 'x86_64'}`, '-DCMAKE_SYSTEM_NAME=Linux');
execFileSync('cmake', args, { stdio: 'inherit' });
execFileSync('cmake', ['--build', dir, '--config', 'Release'], { stdio: 'inherit' });

// The Visual Studio generator puts outputs in Release/: bring them up so every platform looks the same.
const rel = path.join(dir, 'Release');
if (fs.existsSync(rel)) for (const f of fs.readdirSync(rel)) fs.cpSync(path.join(rel, f), path.join(dir, f), { recursive: true });
if (!fs.existsSync(path.join(dir, EXE))) {
  console.error(`No ${EXE} in ${dir}`);
  process.exit(1);
}
console.log(path.relative(root, path.join(dir, EXE)));
