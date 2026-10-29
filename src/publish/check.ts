// Release checks per platform (SPEC v0.6 G6): only platforms that take uploads through an open API.
// Each check is an issue like the linter's (category "release"), with what to do. Pure.
import type { Project } from '../types';
import { LICENSES, platformAccepts, type LicenseCode } from './license';
import { licenseConflicts, releaseOf, type Material } from './release';

export interface Platform {
  id: string;
  name: string;
  /** What it gets: the master's format. */
  audio: 'flac' | 'mp3' | 'aac-mp4' | 'ogg-or-flac';
  /** Needs the local OpenBand server (or desktop app) to hold an app secret. */
  needsServer: boolean;
  maxTags?: number;
  coverMaxMb?: number;
  notes: string;
}

export const PLATFORMS: Platform[] = [
  { id: 'soundcloud', name: 'SoundCloud', audio: 'flac', needsServer: true, notes: 'Every Creative Commons licence in its license field.' },
  { id: 'youtube', name: 'YouTube', audio: 'aac-mp4', needsServer: true, notes: 'A video is made from the cover, the waveform and the lyrics. 100 uploads a day per app.' },
  { id: 'mixcloud', name: 'Mixcloud', audio: 'mp3', needsServer: true, maxTags: 5, coverMaxMb: 10, notes: 'Made for mixes and shows; at most 5 tags.' },
  { id: 'audius', name: 'Audius', audio: 'flac', needsServer: false, notes: 'Open to developers; works from the browser alone.' },
  { id: 'archive', name: 'Internet Archive', audio: 'flac', needsServer: false, notes: 'Permanent and public. Needs a Creative Commons licence.' },
  { id: 'funkwhale', name: 'Funkwhale', audio: 'flac', needsServer: false, notes: 'Your instance’s rules apply (some ask for MusicBrainz metadata).' },
  { id: 'wikimedia', name: 'Wikimedia Commons', audio: 'ogg-or-flac', needsServer: false, notes: 'Free licences only: CC0, CC BY, CC BY-SA.' },
];
export const platformById = (id: string) => PLATFORMS.find((x) => x.id === id);
/** Platforms that stream the music to listeners (what some music-service plans don't allow). */
const STREAMING = new Set(['soundcloud', 'youtube', 'mixcloud', 'audius', 'funkwhale']);

export interface ReleaseIssue {
  platform: string | null;
  severity: 'error' | 'warn' | 'info';
  code: string;
  message: string;
  /** The material it is about, when it is about one. */
  material?: Pick<Material, 'name' | 'license' | 'trackId' | 'regionId'>;
}

export function checkRelease(p: Project, platforms: string[], o: Parameters<typeof licenseConflicts>[2] & { hasCover?: boolean; coverBytes?: number } = {}): ReleaseIssue[] {
  const r = releaseOf(p);
  const issues: ReleaseIssue[] = [];
  const code = r.license as LicenseCode;
  const lic = LICENSES[code];
  if (!lic) issues.push({ platform: null, severity: 'error', code: 'license-unknown', message: `Unknown licence "${r.license}"` });
  if (!p.release?.title && !p.name) issues.push({ platform: null, severity: 'error', code: 'title', message: 'The release needs a title' });
  if (!r.artist) issues.push({ platform: null, severity: 'warn', code: 'artist', message: 'No artist name: platforms will show your account name' });
  // A Creative Commons licence must be allowed by everything in the song.
  if (lic?.cc)
    for (const m of licenseConflicts(p, code, o))
      issues.push({ platform: null, severity: 'error', code: 'license-material', message: `"${m.name}" (${m.license}) can't be released under ${lic.name}: ${m.why}`, material: { name: m.name, license: m.license, trackId: m.trackId, regionId: m.regionId } });
  if (!o.hasCover) issues.push({ platform: null, severity: platforms.includes('youtube') ? 'error' : 'warn', code: 'cover', message: 'No cover: make one (generate_cover) or add your own' });
  // What the engines that made parts of the song allow — e.g. a music service plan without streaming
  // distribution (ElevenLabs Starter): their conditions, from the ledger, for the parts still in the song.
  const alive = new Set(p.regions.map((x) => x.contribution).filter(Boolean));
  const conditioned = new Map<string, string>();
  for (const e of (p.ledger ?? []).filter((x) => alive.has(x.id) && x.license.conditions)) conditioned.set(e.engineName ?? e.engine, e.license.conditions!);
  for (const [engine, conditions] of conditioned) {
    const noStreaming = /streaming services is NOT allowed/i.test(conditions);
    const streaming = platforms.filter((id) => STREAMING.has(id));
    if (noStreaming && streaming.length) for (const id of streaming) issues.push({ platform: id, severity: 'error', code: 'engine-terms', message: `Parts made with ${engine} can't be distributed to streaming services on your plan: ${conditions}` });
    else issues.push({ platform: null, severity: 'warn', code: 'engine-terms', message: `Parts made with ${engine} come with conditions: ${conditions}` });
  }
  for (const id of platforms) {
    const pl = platformById(id);
    if (!pl) {
      issues.push({ platform: id, severity: 'error', code: 'platform', message: `"${id}" is not a platform OpenBand publishes to (only ones with an open upload API)` });
      continue;
    }
    if (lic) {
      const ok = platformAccepts(id, code);
      if (!ok.ok) issues.push({ platform: id, severity: 'error', code: 'license-platform', message: ok.why! });
    }
    if (pl.maxTags && (r.tags?.length ?? 0) > pl.maxTags) issues.push({ platform: id, severity: 'error', code: 'tags', message: `${pl.name} takes at most ${pl.maxTags} tags (you have ${r.tags!.length})` });
    if (pl.coverMaxMb && (o.coverBytes ?? 0) > pl.coverMaxMb * 1e6) issues.push({ platform: id, severity: 'error', code: 'cover-size', message: `${pl.name} takes covers up to ${pl.coverMaxMb} MB` });
    if (id === 'archive') issues.push({ platform: id, severity: 'info', code: 'permanent', message: 'An upload to the Internet Archive is permanent and public: it cannot be taken back.' });
    if (id === 'funkwhale') issues.push({ platform: id, severity: 'info', code: 'instance', message: pl.notes });
  }
  return issues;
}

/** The platforms a "Publish in CC" can go to with this licence. */
export const ccTargets = (code: LicenseCode) => PLATFORMS.filter((pl) => LICENSES[code]?.cc && platformAccepts(pl.id, code).ok).map((pl) => pl.id);
