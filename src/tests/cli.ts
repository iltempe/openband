// `openband test`: the part that needs no browser. Bundled into dist/cli/song-test.mjs at build time.
import { strFromU8, unzipSync } from 'fflate';
import { migrate } from '../migrations';
import { runTests } from './engine';
import { format } from './parse';
import type { SongTest, TestResult } from './types';

export function readSong(bytes: Uint8Array) {
  const json = bytes[0] === 0x50 && bytes[1] === 0x4b ? strFromU8(unzipSync(bytes)['project.json'] ?? new Uint8Array()) : strFromU8(bytes);
  return migrate(json);
}

export function symbolicRun(bytes: Uint8Array) {
  const project = readSong(bytes);
  return { project, run: runTests(project) };
}

export const needsAudio = (tests: SongTest[] = []) => tests.some((t) => t.enabled && t.assert.kind !== 'symbolic');

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const line = (t: SongTest) => t.source ?? format(t);
const detail = (r: TestResult) => `${r.value !== undefined ? `${+r.value.toFixed(2)}, ` : ''}expected ${r.expected}${r.where?.section_id ? ` in ${r.where.section_id}` : ''}`;

export function report(name: string, tests: SongTest[], results: TestResult[], fmt: 'text' | 'json' | 'junit') {
  const of = (t: SongTest) => results.filter((r) => r.testId === t.id);
  if (fmt === 'json') return JSON.stringify({ song: name, tests: tests.map((t) => ({ id: t.id, text: line(t), results: of(t) })) }, null, 2);
  if (fmt === 'junit') {
    const failures = results.filter((r) => !r.pass).length;
    const skipped = results.filter((r) => r.skipped).length;
    const cases = tests.map((t) => {
      const bad = of(t).filter((r) => !r.pass);
      const skip = of(t).some((r) => r.skipped);
      return `  <testcase classname="${esc(name)}" name="${esc(line(t))}">${bad.map((r) => `<failure message="${esc(detail(r))}"/>`).join('')}${skip ? '<skipped/>' : ''}</testcase>`;
    });
    return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${esc(name)}" tests="${tests.length}" failures="${failures}" skipped="${skipped}">\n${cases.join('\n')}\n</testsuite>`;
  }
  return tests
    .map((t) => {
      const rs = of(t);
      const bad = rs.filter((r) => !r.pass);
      const mark = bad.length ? '✗' : rs.some((r) => r.skipped) ? '–' : '✓';
      return [`${mark} ${line(t)}`, ...bad.map((r) => `    ${detail(r)}`)].join('\n');
    })
    .join('\n');
}
