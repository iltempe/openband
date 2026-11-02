import { describe, expect, it } from 'vitest';
import { newIdentity, newSeriesKey } from './crypto';
import { DEFAULT_OPTIONS, blobIds, blobRef, cassetteLink, openManifest, packCassette, parseLink, signerState, type CassetteManifest } from './format';

const bytes = (s: string) => new TextEncoder().encode(s);
const make = async () => {
  const id = await newIdentity();
  const audio = await blobRef('b1', 'audio/mp4', bytes('audio'));
  const cover = await blobRef('b2', 'image/png', bytes('cover'));
  const m: CassetteManifest = { format: 'openband-cassette/1', seriesId: 'serie-segreta', edition: 1, createdAt: 1, title: 'Canzoni del treno', artist: 'Matteo', dedication: 'per Giulia', jcard: { cover, style: 'bold' }, sides: [{ name: 'A', tracks: [{ id: 't1', title: 'Febbraio', durationS: 180, projectId: 'p', versionId: 'v', audio, beatMap: { bpm: 92, offsetS: 0 } }] }], options: DEFAULT_OPTIONS, author: { name: 'Matteo', signKey: id.sign.publicKey, boxKey: id.box.publicKey }, returns: [] };
  return { id, m, key: newSeriesKey() };
};

describe('the package', () => {
  it('hides titles, names and audio from whoever hosts it', async () => {
    const { id, m, key } = await make();
    const pkg = await packCassette(m, { b1: bytes('audio-audio-audio'), b2: bytes('cover') }, key, id.sign.privateKey);
    const everything = new TextDecoder('latin1').decode(Buffer.concat([pkg.manifest, ...Object.values(pkg.blobs)]));
    for (const secret of ['Canzoni', 'Febbraio', 'Giulia', 'Matteo', 'audio-audio', 'serie-segreta']) expect(everything).not.toContain(secret);
  });
  it('opens with the key, and the signature holds', async () => {
    const { id, m, key } = await make();
    const pkg = await packCassette(m, {}, key, id.sign.privateKey);
    expect(await openManifest(pkg.manifest, key)).toMatchObject({ signed: true, manifest: { title: 'Canzoni del treno' } });
    await expect(openManifest(pkg.manifest, newSeriesKey())).rejects.toThrow();
  });
  it('a print by someone else is not the same signature', async () => {
    const { m, key } = await make();
    const other = await newIdentity();
    const forged = await openManifest((await packCassette(m, {}, key, other.sign.privateKey)).manifest, key);
    expect(forged.signed).toBe(false);
    expect(signerState(null, 'a')).toBe('first');
    expect(signerState('a', 'a')).toBe('same');
    expect(signerState('a', 'b')).toBe('changed');
  });
  it('lists its blobs', async () => expect(blobIds((await make()).m)).toEqual(['b2', 'b1']));
  it('keeps the key in the fragment only', () => {
    const link = cassetteLink('https://x.example/c/', 's1', 'KEY', 'luca');
    expect(new URL(link).pathname + new URL(link).search).not.toContain('KEY');
    expect(parseLink(new URL(link).hash)).toEqual({ key: 'KEY', seriesId: 's1', via: 'luca' });
    expect(parseLink(new URL(cassetteLink('https://x.example/', 's1', null)).hash).key).toBeNull();
  });
});
