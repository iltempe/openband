// What each platform is sent (SPEC v0.6 G6), prepared in the page from the release: the Internet Archive's
// item identifier and metadata, the Wikimedia Commons file page with its {{Information}} and licence
// templates. Pure; the local server only carries it, with the user's keys, to the platform.
import type { Project } from '../types';
import { LICENSES, type LicenseCode } from './license';
import { releaseOf } from './release';

const ascii = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** An Archive item identifier: letters, digits, - and _, at most 100 characters, unique enough with a suffix. */
export function archiveIdentifier(p: Project, suffix: string): string {
  const r = releaseOf(p);
  const base = ['openband', ascii(r.artist ?? ''), ascii(r.title)].filter(Boolean).join('-').slice(0, 80) || 'openband-song';
  return `${base}-${r.date.replace(/-/g, '')}-${suffix}`.replace(/-+/g, '-').slice(0, 100);
}

export interface ArchiveItem {
  identifier: string;
  /** x-archive-meta-* (repeated keys as arrays). */
  meta: Record<string, string | string[]>;
}

export function archiveItem(p: Project, suffix: string): ArchiveItem {
  const r = releaseOf(p);
  const l = LICENSES[r.license as LicenseCode];
  if (!l?.cc) throw new Error('The Internet Archive needs a Creative Commons licence for this kind of upload: choose one in Release first');
  const description = [r.description, `Licence: ${l.name} (${l.url})`, `AI use: ${r.aiDisclosure}`, 'Made with OpenBand — https://www.openband.it'].filter(Boolean).join('\n\n');
  return {
    identifier: archiveIdentifier(p, suffix),
    meta: {
      mediatype: 'audio',
      collection: 'opensource_audio',
      title: r.title,
      ...(r.artist ? { creator: r.artist } : {}),
      date: r.date,
      description,
      licenseurl: l.url!,
      ...(r.tags?.length ? { subject: r.tags } : {}),
      ...(r.genre ? { genre: r.genre } : {}),
      ...(r.language ? { language: r.language } : {}),
    },
  };
}

/** The Commons licence template for each free licence (Commons takes no other). */
export const COMMONS_TEMPLATE: Partial<Record<LicenseCode, string>> = {
  'CC0-1.0': '{{cc-zero}}',
  'CC-BY-4.0': '{{cc-by-4.0}}',
  'CC-BY-SA-4.0': '{{cc-by-sa-4.0}}',
};

/** The file name on Commons: no characters MediaWiki refuses in titles. */
export function commonsFilename(p: Project, ext = 'flac'): string {
  const r = releaseOf(p);
  const name = `${r.title}${r.artist ? ` - ${r.artist}` : ''}`.replace(/[#<>[\]|{}:/\\]+/g, ' ').replace(/\s+/g, ' ').trim() || 'OpenBand song';
  return `${name}.${ext}`;
}

/** The file description page: {{Information}} with description, date, source, author, and the licence. */
export function commonsPage(p: Project): string {
  const r = releaseOf(p);
  const tpl = COMMONS_TEMPLATE[r.license as LicenseCode];
  if (!tpl) throw new Error(`Wikimedia Commons takes only free licences (CC0, CC BY, CC BY-SA), not ${LICENSES[r.license as LicenseCode]?.name ?? r.license}`);
  // Free text can hold pipes, braces or markup that would break the template: kept literal.
  const safe = (s: string) => `<nowiki>${s.replace(/<\/?nowiki>/gi, '')}</nowiki>`;
  const desc = [r.description, `AI use: ${r.aiDisclosure}`].filter(Boolean).map((s) => safe(s!)).join('<br>');
  const lang = r.language && /^[a-z]{2,3}$/.test(r.language) ? r.language : 'en';
  return [
    '=={{int:filedesc}}==',
    '{{Information',
    `|description={{${lang}|1=${safe(r.title)}${r.artist ? ` — ${safe(r.artist)}` : ''}. ${desc}}}`,
    `|date=${r.date}`,
    '|source={{own}}',
    `|author=${r.artist ? safe(r.artist) : '{{unknown|author}}'}`,
    '|other fields={{Information field|name=Software|value=OpenBand (https://www.openband.it)}}',
    '}}',
    '',
    '=={{int:license-header}}==',
    tpl,
    '',
  ].join('\n');
}

// ---- SoundCloud, YouTube, Mixcloud (G6c2)

/** SoundCloud's names for the licences. */
export const SOUNDCLOUD_LICENSE: Record<LicenseCode, string> = {
  'all-rights-reserved': 'all-rights-reserved',
  'CC0-1.0': 'no-rights-reserved',
  'CC-BY-4.0': 'cc-by',
  'CC-BY-SA-4.0': 'cc-by-sa',
  'CC-BY-NC-4.0': 'cc-by-nc',
  'CC-BY-ND-4.0': 'cc-by-nd',
  'CC-BY-NC-SA-4.0': 'cc-by-nc-sa',
  'CC-BY-NC-ND-4.0': 'cc-by-nc-nd',
};

/** The text that goes with the song everywhere: description, licence, AI use, where it was made. */
function longDescription(p: Project): string {
  const r = releaseOf(p);
  const l = LICENSES[r.license as LicenseCode];
  return [r.description, l?.cc ? `Licence: ${l.name} — ${l.url}` : null, `AI use: ${r.aiDisclosure}`, 'Made with OpenBand — https://www.openband.it'].filter(Boolean).join('\n\n');
}

/** Did any engine (an AI model) make part of it? From the ledger, not from what anyone says. */
export const usesGeneratedMedia = (p: Project) => (p.ledger ?? []).some((e) => e.source !== 'builtin');

export function soundcloudTrack(p: Project, privacy: 'public' | 'private' | 'unlisted' = 'public') {
  const r = releaseOf(p);
  return {
    track: {
      title: r.title,
      description: longDescription(p),
      ...(r.genre ? { genre: r.genre } : {}),
      // Tags with spaces are quoted, as SoundCloud's tag_list wants.
      tag_list: (r.tags ?? []).map((t) => (/\s/.test(t) ? `"${t.replace(/"/g, '')}"` : t)).join(' '),
      license: SOUNDCLOUD_LICENSE[r.license as LicenseCode] ?? 'all-rights-reserved',
      // SoundCloud has public and private (a private link is how it is unlisted).
      sharing: privacy === 'public' ? 'public' : 'private',
    },
  };
}

export function youtubeVideo(p: Project, privacy: 'public' | 'private' | 'unlisted' = 'public') {
  const r = releaseOf(p);
  const tags: string[] = [];
  let len = 0;
  for (const t of [...(r.tags ?? []), ...(r.genre ? [r.genre] : [])]) if ((len += t.length + 1) <= 480) tags.push(t);
  const desc = longDescription(p);
  return {
    snippet: { title: `${r.title}${r.artist ? ` — ${r.artist}` : ''}`.slice(0, 100), description: desc.slice(0, 4900), tags, categoryId: '10', ...(r.language ? { defaultLanguage: r.language, defaultAudioLanguage: r.language } : {}) },
    status: { privacyStatus: privacy, license: r.license === 'CC-BY-4.0' ? 'creativeCommon' : 'youtube', selfDeclaredMadeForKids: false, containsSyntheticMedia: usesGeneratedMedia(p) },
  };
}

export function mixcloudUpload(p: Project) {
  const r = releaseOf(p);
  return { name: `${r.title}${r.artist ? ` — ${r.artist}` : ''}`.slice(0, 100), description: longDescription(p).slice(0, 1000), tags: [...(r.genre ? [r.genre] : []), ...(r.tags ?? [])].slice(0, 5) };
}

/** Funkwhale's import metadata: title, description, copyright, tags, and the licence's code. */
export function funkwhaleUpload(p: Project, master: string) {
  const r = releaseOf(p);
  const l = LICENSES[r.license as LicenseCode];
  return {
    import_reference: `openband-${master}`.slice(0, 50),
    metadata: {
      title: r.title,
      description: longDescription(p).slice(0, 5000),
      copyright: `${r.date.slice(0, 4)}${r.artist ? ` ${r.artist}` : ''}`.slice(0, 500),
      position: 1,
      ...(r.tags?.length || r.genre ? { tags: [...(r.genre ? [r.genre] : []), ...(r.tags ?? [])].map((t) => t.replace(/\s+/g, '-')) } : {}),
      // Funkwhale's licence codes are the SPDX ones, in lowercase.
      ...(l?.cc ? { license: l.code.toLowerCase() } : {}),
    },
  };
}
