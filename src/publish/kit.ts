// The Release Kit (SPEC v0.6 G6): everything a release needs, in one zip — the master as FLAC with its
// tags (title, artist, licence, copyright, contact) and cover, the cover itself, LICENSE.txt, the lyrics as
// plain text and as LRC synchronised from their alignment, the credits with the AI-use statement.
import { zipSync } from 'fflate';
import type { Project } from '../types';
import { encodeFlac } from '../audio/flac';
import { LICENSES, explain, IRREVOCABLE, type LicenseCode } from './license';
import { releaseOf } from './release';
import { coverPng } from './cover';

/** A line as sung: without the hyphens that split it into syllables. */
const sungText = (t: string) => t.replace(/(\p{L})-(?=\p{L})/gu, '$1');
const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}`;

/** LRC from the aligned lyrics: each line at its first syllable's time. */
export function lrcOf(p: Project): string | null {
  const lines = p.lyrics?.lines ?? [];
  const timed = lines.map((l) => ({ text: sungText(l.text), beat: l.syllables.find((s) => typeof s.beat === 'number')?.beat })).filter((l) => l.beat !== undefined);
  if (!timed.length) return null;
  const r = releaseOf(p);
  const head = [`[ti:${r.title}]`, ...(r.artist ? [`[ar:${r.artist}]`] : []), '[by:OpenBand]'];
  return [...head, ...timed.map((l) => `[${mmss(((l.beat as number) * 60) / p.bpm)}]${l.text}`)].join('\n') + '\n';
}

export function licenseText(p: Project): string {
  const r = releaseOf(p);
  const l = LICENSES[r.license as LicenseCode] ?? LICENSES['all-rights-reserved'];
  const year = r.date.slice(0, 4);
  return [
    `${r.title}${r.artist ? ` — ${r.artist}` : ''}`,
    `© ${year}${r.artist ? ` ${r.artist}` : ''}`,
    '',
    `Licence: ${l.name}${l.url ? ` — ${l.url}` : ''}`,
    explain(l.code),
    ...(l.cc ? ['', IRREVOCABLE.en] : []),
    ...(r.contact ? ['', `Contact: ${r.contact}`] : []),
    '',
  ].join('\n');
}

export function creditsText(p: Project): string {
  const r = releaseOf(p);
  return [
    `${r.title}${r.artist ? ` — ${r.artist}` : ''}${r.featuring ? ` feat. ${r.featuring}` : ''}`,
    ...(r.genre ? [`Genre: ${r.genre}`] : []),
    ...(r.credits?.length ? ['', ...r.credits.map((c) => `${c.role}: ${c.name}`)] : []),
    '',
    `AI use: ${r.aiDisclosure}`,
    '',
    'Made with OpenBand — https://www.openband.it',
    '',
  ].join('\n');
}

/** FLAC tags for the master, from the release. */
export function flacTags(p: Project): Record<string, string> {
  const r = releaseOf(p);
  const l = LICENSES[r.license as LicenseCode];
  return {
    TITLE: r.title,
    ...(r.artist ? { ARTIST: r.artist } : {}),
    ...(r.genre ? { GENRE: r.genre } : {}),
    DATE: r.date,
    ...(r.description ? { DESCRIPTION: r.description } : {}),
    ...(r.contact ? { CONTACT: r.contact } : {}),
    COPYRIGHT: `${r.date.slice(0, 4)}${r.artist ? ` ${r.artist}` : ''}. ${l?.name ?? r.license}`,
    LICENSE: l?.url ?? l?.name ?? r.license,
    COMMENT: `AI use: ${r.aiDisclosure}`,
  };
}

/** The release's files by name, from the rendered master (channels at its rate). */
export async function releaseFiles(p: Project, master: { channels: Float32Array[]; sampleRate: number }): Promise<Record<string, Uint8Array>> {
  const r = releaseOf(p);
  const name = r.title.replace(/[\\/:*?"<>|]/g, '_');
  const cover = r.cover?.kind === 'image' ? dataUrlBytes(r.cover.dataUrl) : await coverPng(r.cover?.kind === 'generated' ? r.cover : { style: 'bold', palette: 'night', seed: 1 }, { title: r.title, artist: r.artist });
  const flac = encodeFlac(master.channels, master.sampleRate, { bitsPerSample: 24, tags: flacTags(p), picture: { mime: 'image/png', data: cover, width: 3000, height: 3000 } });
  const enc = new TextEncoder();
  const files: Record<string, Uint8Array> = {
    [`${name}.flac`]: flac,
    'cover.png': cover,
    'LICENSE.txt': enc.encode(licenseText(p)),
    'CREDITS.txt': enc.encode(creditsText(p)),
  };
  const lyrics = (p.lyrics?.lines ?? []).map((l) => sungText(l.text)).join('\n');
  if (lyrics) files['lyrics.txt'] = enc.encode(`${lyrics}\n`);
  const lrc = lrcOf(p);
  if (lrc) files[`${name}.lrc`] = enc.encode(lrc);
  return files;
}

/** The kit as zip bytes, from the rendered master. */
export async function buildKit(p: Project, master: { channels: Float32Array[]; sampleRate: number }): Promise<{ zip: Uint8Array; files: string[] }> {
  const files = await releaseFiles(p, master);
  // FLAC and PNG don't compress further: store them.
  const zip = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, [v, { level: /\.(flac|png)$/.test(k) ? 0 : 6 }]])));
  return { zip, files: Object.keys(files) };
}

function dataUrlBytes(url: string): Uint8Array {
  const b64 = url.slice(url.indexOf(',') + 1);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
