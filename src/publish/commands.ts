// The release in the studio (SPEC v0.6 G6): metadata, licence, cover, checks and the Release Kit, as
// commands (the same names as the MCP tools) and a lint rule, so licence conflicts show in Problems too.
import { useStore } from '../store';
import { useSamples } from '../audio/samples';
import { useLoops } from '../loopsLive';
import { registerLintRule } from '../lint/engine';
import { renderBuffer } from '../audio/render';
import type { ReleaseMeta } from '../types';
import { LICENSES, chooseLicense, explain, COLLECTING_SOCIETY, IRREVOCABLE, type LicenseCode } from './license';
import { aiDisclosure, licenseConflicts, materials, releaseOf } from './release';
import { checkRelease, ccTargets, PLATFORMS } from './check';
import { COVER_STYLES, PALETTES, coverPng } from './cover';
import { buildKit } from './kit';

const st = () => useStore.getState();
const context = () => ({
  loopIds: new Set((useLoops.getState().manifest?.loops ?? []).map((l) => l.id)),
  sampleNames: Object.fromEntries(Object.entries(useSamples.getState().info).map(([id, i]) => [id, i.name])),
});

export function getRelease() {
  const p = st().project;
  const r = releaseOf(p);
  const l = LICENSES[r.license as LicenseCode];
  return {
    release: r,
    license: l ? { code: l.code, name: l.name, url: l.url, meaning: explain(l.code), ...(l.cc ? { note: `${IRREVOCABLE.en} ${COLLECTING_SOCIETY.en}` } : {}) } : null,
    materials: materials(p, context()),
    platforms: PLATFORMS.map((x) => ({ id: x.id, name: x.name, audio: x.audio, needs_server: x.needsServer, notes: x.notes })),
  };
}

export interface SetReleaseArgs extends ReleaseMeta {
  /** The licence from the three answers, instead of a code. */
  choose?: { commercial: boolean; derivatives: boolean; share_alike?: boolean; public_domain?: boolean };
  sample_licenses?: Record<string, string>;
}

export function setRelease(a: SetReleaseArgs) {
  const { choose, sample_licenses, ...meta } = a;
  if (choose) meta.license = chooseLicense({ commercial: choose.commercial, derivatives: choose.derivatives, shareAlike: choose.share_alike, publicDomain: choose.public_domain });
  if (meta.license && !LICENSES[meta.license as LicenseCode]) throw new Error(`Unknown licence "${meta.license}": use one of ${Object.keys(LICENSES).join(', ')}`);
  st().commit((d) => {
    d.release = { ...d.release, ...Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined)) };
    if (sample_licenses) d.sampleLicenses = { ...d.sampleLicenses, ...sample_licenses };
  });
  return getRelease();
}

export function checkReleaseCommand(platforms: string[] = PLATFORMS.map((x) => x.id)) {
  const p = st().project;
  const issues = checkRelease(p, platforms, { ...context(), hasCover: !!p.release?.cover });
  const r = releaseOf(p);
  return {
    issues,
    ready: platforms.filter((id) => !issues.some((i) => i.severity === 'error' && (i.platform === id || i.platform === null))),
    ...(LICENSES[r.license as LicenseCode]?.cc ? { publish_in_cc: ccTargets(r.license as LicenseCode) } : {}),
  };
}

export async function generateCover(a: { style?: string; palette?: string; seed?: number }) {
  const style = (COVER_STYLES as readonly string[]).includes(a.style ?? '') ? a.style! : 'bold';
  const palette = a.palette && PALETTES[a.palette] ? a.palette : 'night';
  const seed = Number.isFinite(a.seed) ? Math.round(a.seed!) : Math.floor(Math.random() * 1e6);
  st().commit((d) => void (d.release = { ...d.release, cover: { kind: 'generated', style, palette, seed } }));
  const r = releaseOf(st().project);
  const png = await coverPng({ style, palette, seed }, { title: r.title, artist: r.artist }, 600);
  let bin = '';
  for (let i = 0; i < png.length; i += 0x8000) bin += String.fromCharCode(...png.subarray(i, i + 0x8000));
  return { cover: { style, palette, seed }, preview: `data:image/png;base64,${btoa(bin)}`, note: 'Deterministic: the same style, palette and seed make the same cover (3000 px in the Release Kit).' };
}

/** Render the master and build the Release Kit; answers the zip (to save) and what's in it. */
export async function releaseKit() {
  const p = st().project;
  const buf = await renderBuffer(p, { sampleRate: 48000 });
  const channels = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  return buildKit(p, { channels, sampleRate: buf.sampleRate });
}

/** In Problems: a Creative Commons licence that something in the song doesn't allow. */
registerLintRule({
  id: 'release-license',
  category: 'release',
  severity: 'error',
  check(p) {
    const code = p.release?.license as LicenseCode | undefined;
    if (!code || !LICENSES[code]?.cc) return [];
    return licenseConflicts(p, code, context()).map((m) => ({
      message: `"${m.name}" (${m.license}) can't be released under ${LICENSES[code].name}: ${m.why}`,
      target: { track_id: m.trackId, region_id: m.regionId },
      params: { name: m.name, license: m.license },
    }));
  },
});

export const releaseAiDisclosure = () => aiDisclosure(st().project);
