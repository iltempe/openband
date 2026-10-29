// What each platform is sent (SPEC v0.6 G6): the Internet Archive item and the Wikimedia Commons file page.
import { describe, expect, it } from 'vitest';
import { archiveIdentifier, archiveItem, commonsFilename, commonsPage, mixcloudUpload, soundcloudTrack, usesGeneratedMedia, youtubeVideo } from './prepare';
import { emptyProject } from '../store';
import type { Project, ReleaseMeta } from '../types';

const song = (release: Partial<ReleaseMeta> = {}): Project => ({ ...emptyProject(), name: 'Notte', release: { title: 'Notte à Trastevere', artist: 'iltempe', date: '2026-10-25', license: 'CC-BY-4.0', ...release } as ReleaseMeta });

describe('Internet Archive', () => {
  it('a valid identifier from artist, title and date', () => {
    expect(archiveIdentifier(song(), 'ab12cd')).toBe('openband-iltempe-notte-a-trastevere-20261025-ab12cd');
    expect(archiveIdentifier(song({ title: '!!!', artist: '' }), 'x1')).toMatch(/^openband-20261025-x1$|^openband-song-20261025-x1$/);
  });
  it('metadata with the licence URL, the AI statement and the tags', () => {
    const it = archiveItem(song({ tags: ['lo-fi', 'notte'], description: 'Di notte.' }), 'ab12cd');
    expect(it.meta).toMatchObject({ mediatype: 'audio', collection: 'opensource_audio', title: 'Notte à Trastevere', creator: 'iltempe', date: '2026-10-25', licenseurl: 'https://creativecommons.org/licenses/by/4.0/', subject: ['lo-fi', 'notte'] });
    expect(it.meta.description).toMatch(/Di notte\.[\s\S]*Licence: CC BY 4\.0[\s\S]*AI use:/);
  });
  it('blocked without a Creative Commons licence, with the reason', () => {
    expect(() => archiveItem(song({ license: 'all-rights-reserved' }), 'x')).toThrow(/needs a Creative Commons licence/);
  });
});

describe('Wikimedia Commons', () => {
  it('the file page has {{Information}} and the right licence template', () => {
    const page = commonsPage(song());
    expect(page).toContain('{{Information');
    expect(page).toContain('|date=2026-10-25');
    expect(page).toContain('|source={{own}}');
    expect(page).toContain('|author=<nowiki>iltempe</nowiki>');
    expect(page).toMatch(/=={{int:license-header}}==\n{{cc-by-4.0}}/);
    expect(commonsPage(song({ license: 'CC0-1.0' }))).toContain('{{cc-zero}}');
    expect(commonsPage(song({ license: 'CC-BY-SA-4.0' }))).toContain('{{cc-by-sa-4.0}}');
  });
  it('refuses NC and ND licences', () => {
    for (const l of ['CC-BY-NC-4.0', 'CC-BY-ND-4.0', 'CC-BY-NC-SA-4.0', 'all-rights-reserved']) expect(() => commonsPage(song({ license: l }))).toThrow(/only free licences/);
  });
  it('free text cannot break the template', () => {
    const page = commonsPage(song({ title: 'A | B }} {{delete}}', description: '[[Category:Spam]]' }));
    expect(page).toContain('<nowiki>A | B }} {{delete}}</nowiki>');
    expect(page).toContain('<nowiki>[[Category:Spam]]</nowiki>');
  });
  it('a file name MediaWiki accepts', () => {
    expect(commonsFilename(song({ title: 'Notte: #1 [demo]' }))).toBe('Notte 1 demo - iltempe.flac');
  });
});

describe('SoundCloud, YouTube, Mixcloud', () => {
  it("SoundCloud: its names for the licences, quoted tags, private for anything not public", () => {
    const t = soundcloudTrack(song({ tags: ['lo fi', 'notte'], genre: 'Lo-fi' }), 'unlisted').track;
    expect(t).toMatchObject({ title: 'Notte à Trastevere', genre: 'Lo-fi', tag_list: '"lo fi" notte', license: 'cc-by', sharing: 'private' });
    expect(t.description).toMatch(/Licence: CC BY 4\.0[\s\S]*AI use:/);
    expect(soundcloudTrack(song({ license: 'CC0-1.0' })).track.license).toBe('no-rights-reserved');
    expect(soundcloudTrack(song({ license: 'CC-BY-NC-SA-4.0' })).track.license).toBe('cc-by-nc-sa');
  });
  it('YouTube: Music, its licence only for CC BY, synthetic media from the ledger', () => {
    const v = youtubeVideo(song(), 'unlisted');
    expect(v.snippet).toMatchObject({ title: 'Notte à Trastevere — iltempe', categoryId: '10' });
    expect(v.status).toEqual({ privacyStatus: 'unlisted', license: 'creativeCommon', selfDeclaredMadeForKids: false, containsSyntheticMedia: false });
    expect(youtubeVideo(song({ license: 'CC-BY-SA-4.0' })).status.license).toBe('youtube');
    const withAi = { ...song(), ledger: [{ source: 'engine' }] } as never;
    expect(usesGeneratedMedia(withAi)).toBe(true);
    expect(youtubeVideo(withAi).status.containsSyntheticMedia).toBe(true);
    expect(usesGeneratedMedia({ ...song(), ledger: [{ source: 'builtin' }] } as never)).toBe(false);
  });
  it('Mixcloud: at most 5 tags, the genre first', () => {
    const m = mixcloudUpload(song({ genre: 'House', tags: ['a', 'b', 'c', 'd', 'e', 'f'] }));
    expect(m.tags).toEqual(['House', 'a', 'b', 'c', 'd']);
    expect(m.name).toBe('Notte à Trastevere — iltempe');
  });
});
