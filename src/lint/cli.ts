// Entry point bundled by scripts/openband-lint.mjs: read a song file, migrate it, lint it.
import { unzipSync, strFromU8 } from 'fflate';
import { migrate } from '../migrations';
import { lint } from './engine';
import type { Severity } from '../types';

export function lintFile(bytes: Uint8Array, opts: { minSeverity?: Severity } = {}) {
  // .openband bundles are zip files with project.json inside.
  const json = bytes[0] === 0x50 && bytes[1] === 0x4b ? strFromU8(unzipSync(bytes)['project.json'] ?? new Uint8Array()) : new TextDecoder().decode(bytes);
  const project = migrate(json);
  return { project: project.name, ...lint(project, { minSeverity: opts.minSeverity }) };
}
