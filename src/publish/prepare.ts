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
