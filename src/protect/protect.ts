// Protect (SPEC v0.6 G7): a proof that the work existed at a date, anchored in Bitcoin through OpenTimestamps.
// The page makes the work's files (master WAV, the project, lyrics, chords), their SHA-256 in a canonical
// manifest, and sends only the manifest's 32-byte digest to the local OpenBand, which asks the public
// calendars. The proof is pending for a few hours, then complete; the Proof package holds everything needed
// to verify it independently (`ots verify`), with a readable certificate.
import { zipSync } from 'fflate';
import { useStore } from '../store';
import { protectRequest } from '../bridge';
import { renderProject } from '../audio/render';
import { canonicalJSON } from '../versions/canonical';
import { releaseOf } from '../publish/release';
import { LICENSES, type LicenseCode } from '../publish/license';
import type { Project, Protection } from '../types';
import { canonicalManifest, sha256Hex, type Manifest, type WorkFile } from './manifest';
import { certificatePdf } from './pdf';

export const PARTS = ['master', 'project', 'lyrics', 'chords'] as const;
export type Part = (typeof PARTS)[number];

const st = () => useStore.getState();
const enc = new TextEncoder();
const safe = (s: string) => s.replace(/[^\w\- ]+/g, '').trim() || 'openband';

/** The project as it is versioned, without what a timestamp adds to it (the proofs, the publications). */
function projectBytes(p: Project): Uint8Array {
  const { protections: _a, publications: _b, ...rest } = p;
  return enc.encode(canonicalJSON(rest as Project));
}

/** The work's files, by part (what isn't there — no lyrics — is left out). */
export async function workFiles(p: Project, include: readonly Part[] = PARTS): Promise<Record<string, { name: string; bytes: Uint8Array }>> {
  const base = safe(releaseOf(p).title);
  const out: Record<string, { name: string; bytes: Uint8Array }> = {};
  if (include.includes('master')) out.master = { name: `${base}.wav`, bytes: new Uint8Array(await (await renderProject(p, { sampleRate: 44100, bits: 16, dither: true })).arrayBuffer()) };
  if (include.includes('project')) out.project = { name: `${base}.openband.json`, bytes: projectBytes(p) };
  const lyrics = (p.lyrics?.lines ?? []).map((l) => l.text).join('\n');
  if (include.includes('lyrics') && lyrics.trim()) out.lyrics = { name: 'lyrics.txt', bytes: enc.encode(`${lyrics}\n`) };
  if (include.includes('chords')) {
    const { commands } = await import('../commands');
    const sheet = (await commands.export_chord_sheet({ format: 'chordpro', return_data: true })) as { text: string };
    if (sheet.text.trim()) out.chords = { name: `${base}.cho`, bytes: enc.encode(sheet.text) };
  }
  return out;
}

export async function manifestOf(p: Project, files: Record<string, { name: string; bytes: Uint8Array }>): Promise<Manifest> {
  const r = releaseOf(p);
  const hashed: Record<string, WorkFile> = {};
  for (const [k, f] of Object.entries(files)) hashed[k] = { name: f.name, sha256: await sha256Hex(f.bytes), bytes: f.bytes.length };
  const credits = (r.credits ?? []).map((c) => c.name).filter(Boolean);
  return {
    format: 'openband-work/1',
    title: r.title,
    authors: [...new Set([...(r.artist ? [r.artist] : []), ...credits])],
    declared_date: r.date,
    license: LICENSES[r.license as LicenseCode]?.name ?? r.license,
    files: hashed,
    project_version: await sha256Hex(projectBytes(p)),
    made_with: 'OpenBand — https://www.openband.it',
  };
}

const record = (fn: (list: Protection[]) => Protection[]) => st().commit((d) => void (d.protections = fn(d.protections ?? [])), { history: false });

/** Timestamp the work: its manifest's digest, stamped on the calendars through the local OpenBand. */
export async function timestampWork(a: { include?: Part[] } = {}) {
  const include = a.include?.length ? a.include.filter((x) => (PARTS as readonly string[]).includes(x)) : [...PARTS];
  const p = st().project;
  const files = await workFiles(p, include);
  const m = await manifestOf(p, files);
  const manifest = canonicalManifest(m);
  const digest = await sha256Hex(manifest);
  const r = await protectRequest<{ ots: string; state: 'pending' | 'confirmed'; calendars?: string[]; answered: number }>('stamp', { digest });
  // Keep the master's exact bytes: a new render differs in its last bits, and the proof is of these.
  let masterSampleId: string | undefined;
  if (files.master) {
    const { importSample } = await import('../audio/samples');
    const b = files.master.bytes;
    masterSampleId = (await importSample(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, `${files.master.name.replace(/\.wav$/, '')} (timestamped master).wav`, 'audio/wav')).id;
  }
  const prot: Protection = { id: `ots_${digest.slice(0, 12)}_${Date.now().toString(36)}`, kind: 'opentimestamps', at: Date.now(), manifest, digest, ots: r.ots, state: r.state, includes: Object.keys(files), ...(masterSampleId ? { masterSampleId } : {}) };
  record((list) => [...list, prot]);
  return { protection_id: prot.id, digest, state: r.state, calendars: r.answered, includes: prot.includes, note: 'Pending: Bitcoin confirms it in a few hours; get_protections upgrades it. Only the 32-byte digest left this computer.' };
}

/** Ask the calendars about the pending proofs; save the ones Bitcoin confirmed. */
export async function upgradeProtections() {
  const pending = (st().project.protections ?? []).filter((x) => x.state === 'pending');
  let upgraded = 0;
  for (const x of pending) {
    const r = await protectRequest<{ ots: string; changed: boolean; state: 'pending' | 'confirmed'; height?: number }>('upgrade', { ots: x.ots }).catch(() => null);
    if (!r?.changed) continue;
    upgraded++;
    record((list) => list.map((y) => (y.id === x.id ? { ...y, ots: r.ots, state: r.state, ...(r.height ? { height: r.height } : {}) } : y)));
  }
  return upgraded;
}

export async function getProtections() {
  const upgraded = useStoreBridgeReady() ? await upgradeProtections().catch(() => 0) : 0;
  const list = st().project.protections ?? [];
  return {
    protections: list.map((x) => ({ id: x.id, at: new Date(x.at).toISOString(), state: x.state, ...(x.height ? { bitcoin_block: x.height } : {}), ...(x.blockTime ? { block_time: new Date(x.blockTime * 1000).toISOString() } : {}), digest: x.digest, includes: x.includes })),
    ...(upgraded ? { upgraded } : {}),
    note: 'A timestamp proves the work existed at that date; it is accepted as evidence (eIDAS, non-qualified) but is not a registration and not legal advice. Collecting royalties needs a collecting society.',
  };
}
const useStoreBridgeReady = () => st().bridgeStatus === 'connected';

/** Verify a proof: one of this song's (by id), or any file with its .ots. */
export async function verifyTimestamp(a: { protection_id?: string; file?: Uint8Array; ots?: Uint8Array }) {
  let ots: string;
  let digest: string;
  let prot: Protection | undefined;
  if (a.protection_id) {
    prot = (st().project.protections ?? []).find((x) => x.id === a.protection_id);
    if (!prot) throw new Error(`No timestamp "${a.protection_id}" in this song (get_protections lists them)`);
    ots = prot.ots;
    digest = prot.digest;
  } else {
    if (!a.file || !a.ots) throw new Error('Give a file and its .ots proof');
    ots = btoa(String.fromCharCode(...a.ots));
    digest = await sha256Hex(a.file);
  }
  const r = await protectRequest<{ verified: boolean; state: string; height?: number; time?: number; block?: string; reason?: string; ots?: string }>('verify', { ots, digest });
  if (prot && r.verified && r.time) record((list) => list.map((y) => (y.id === prot!.id ? { ...y, state: 'confirmed', ...(r.height ? { height: r.height } : {}), blockTime: r.time, ...(r.ots ? { ots: r.ots } : {}) } : y)));
  return { verified: r.verified, state: r.state, ...(r.height ? { bitcoin_block: r.height, block: r.block } : {}), ...(r.time ? { existed_by: new Date(r.time * 1000).toISOString() } : {}), ...(r.reason ? { reason: r.reason } : {}) };
}

/** The Proof package: the manifest and its .ots, the files it lists, how to verify, a certificate. */
export async function proofPackage(protectionId?: string): Promise<{ zip: Uint8Array; name: string; files: string[] }> {
  const list = st().project.protections ?? [];
  const prot = protectionId ? list.find((x) => x.id === protectionId) : list.at(-1);
  if (!prot) throw new Error('Timestamp the song first (timestamp_work)');
  const p = st().project;
  const m = JSON.parse(prot.manifest) as Manifest;
  // The master as stamped (kept with the song); the other files are made again — they are deterministic.
  const { getStoredSample, ensureSamples } = await import('../audio/samples');
  if (prot.masterSampleId) await ensureSamples([prot.masterSampleId]);
  const kept = prot.masterSampleId ? getStoredSample(prot.masterSampleId) : undefined;
  const files = await workFiles(p, (prot.includes as Part[]).filter((x) => !(x === 'master' && kept)));
  if (kept) files.master = { name: m.files.master?.name ?? 'master.wav', bytes: new Uint8Array(kept.data) };
  const out: Record<string, Uint8Array> = { 'work.json': enc.encode(prot.manifest), 'work.json.ots': Uint8Array.from(atob(prot.ots), (c) => c.charCodeAt(0)) };
  // The files as they are now: their hashes must match the manifest's, or the song changed since.
  const changed: string[] = [];
  for (const [k, f] of Object.entries(files)) {
    out[f.name] = f.bytes;
    if (m.files[k] && (await sha256Hex(f.bytes)) !== m.files[k].sha256) changed.push(f.name);
  }
  const when = prot.state === 'confirmed' && prot.blockTime ? new Date(prot.blockTime * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : null;
  out['README.txt'] = enc.encode(readme(m, prot, when, changed));
  out['certificate.pdf'] = certificatePdf([
    { text: 'Proof of existence', size: 22, bold: true },
    { text: m.title, size: 16, bold: true, gap: 10 },
    { text: m.authors.length ? `By ${m.authors.join(', ')}` : '' },
    { text: `Declared date: ${m.declared_date} · Licence: ${m.license}` },
    { text: when ? `Anchored in Bitcoin block ${prot.height}, which existed on ${when}.` : `Submitted on ${new Date(prot.at).toISOString().slice(0, 10)}; Bitcoin confirmation pending (upgrade it in OpenBand, or with "ots upgrade").`, bold: true, gap: 12 },
    { text: `Manifest (work.json) SHA-256: ${prot.digest}`, size: 9, gap: 10 },
    ...Object.values(m.files).map((f) => ({ text: `${f.name}: ${f.sha256}`, size: 9 })),
    { text: 'Verify independently: ots verify work.json.ots (opentimestamps.org), and sha256sum each file against work.json.', size: 10, gap: 14 },
    { text: 'What this is: a timestamp proves these files existed at that date. In Italy and the EU it is accepted as evidence (art. 8-ter DL 135/2018, a non-qualified electronic time stamp under art. 41 eIDAS) and a court weighs it freely. It is not a registration with a collecting society, and not legal advice.', size: 9, gap: 10 },
    { text: 'Made with OpenBand — https://www.openband.it', size: 9, gap: 10 },
  ]);
  return { zip: zipSync(out), name: `${safe(m.title)} - Proof.zip`, files: Object.keys(out), ...(changed.length ? { changed } : {}) };
}

function readme(m: Manifest, prot: Protection, when: string | null, changed: string[]) {
  return [
    `Proof of existence — ${m.title}`,
    '',
    when ? `Anchored in Bitcoin block ${prot.height} (${when}).` : 'Pending: Bitcoin confirms the timestamp in a few hours. Upgrade it with "ots upgrade work.json.ots" or in OpenBand.',
    '',
    'To verify it yourself:',
    '1. Install the OpenTimestamps client (https://opentimestamps.org).',
    '2. ots verify work.json.ots   — checks the proof of work.json against Bitcoin.',
    '3. sha256sum the files below and compare them with work.json: each listed file is part of the proof.',
    '',
    ...Object.values(m.files).map((f) => `   ${f.sha256}  ${f.name}`),
    '',
    ...(changed.length ? [`Note: these files changed since the timestamp, so their hashes no longer match: ${changed.join(', ')}. The proof covers the versions listed above.`, ''] : []),
    'A timestamp proves existence at a date (evidence, non-qualified under eIDAS art. 41); it is not a',
    'registration with a collecting society and not legal advice.',
    '',
    '---',
    '',
    `Prova di esistenza — ${m.title}`,
    when ? `Ancorata nel blocco Bitcoin ${prot.height} (${when}).` : 'In attesa: Bitcoin conferma la marca temporale in qualche ora (ots upgrade work.json.ots, o da OpenBand).',
    'Per verificarla: ots verify work.json.ots, poi sha256sum dei file confrontato con work.json.',
    'Una marca temporale prova che i file esistevano a quella data (prova, validazione temporale non qualificata,',
    'art. 8-ter DL 135/2018 e art. 41 eIDAS); non è un deposito presso una società di gestione né una consulenza legale.',
    '',
  ].join('\n');
}
