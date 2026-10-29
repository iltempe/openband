// OpenTimestamps (SPEC v0.6 G7): our client against the official example proofs and a mock calendar and
// block explorer — stamp (only 32 bytes leave), pending .ots, upgrade once confirmed, verify.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error — plain ESM modules
import { parseOts, serializeOts, stamp, summarize, upgrade, verifyBitcoin } from './protect/ots.mjs';
// @ts-expect-error
import { createFakePlatforms } from './fixtures/fake-platforms.mjs';

const ex = (f: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'ots', f));
let fake: ReturnType<typeof createFakePlatforms>;
let mock: string;
beforeAll(async () => {
  fake = createFakePlatforms();
  mock = `http://127.0.0.1:${await fake.listen()}`;
});
afterAll(() => fake.close());

describe('the .ots format', () => {
  it("reads the official client's proofs and writes them back byte for byte", () => {
    for (const f of ['hello-world.txt.ots', 'incomplete.txt.ots']) {
      const buf = ex(f);
      expect(serializeOts(parseOts(buf)).equals(buf)).toBe(true);
    }
  });
  it("its file hash is the file's SHA-256; confirmed in block 358391, or pending on its calendar", () => {
    const hello = parseOts(ex('hello-world.txt.ots'));
    expect(hello.msg.toString('hex')).toBe(crypto.createHash('sha256').update(ex('hello-world.txt')).digest('hex'));
    expect(summarize(hello)).toMatchObject({ state: 'confirmed', height: 358391 });
    expect(summarize(parseOts(ex('incomplete.txt.ots')))).toEqual({ state: 'pending', calendars: ['https://alice.btc.calendar.opentimestamps.org'] });
  });
  it('refuses what is not a proof', () => {
    expect(() => parseOts(Buffer.from('hello'))).toThrow(/Not an OpenTimestamps proof/);
  });
});

describe('stamp, upgrade, verify (mock calendars and explorer)', () => {
  const calendars = () => [`${mock}/ots-a`, `${mock}/ots-b`];
  it('only a 32-byte digest reaches the calendars, never the file or the manifest', async () => {
    const manifest = Buffer.from(JSON.stringify({ title: 'Fuori', master_sha256: 'ab'.repeat(32) }));
    const digest = crypto.createHash('sha256').update(manifest).digest();
    const r = await stamp(digest, { calendars: calendars() });
    expect(r.calendars).toBe(2);
    expect(fake.state.ots.digests.map((d: { length: number }) => d.length)).toEqual([32, 32]);
    // A nonce first: what the calendars see is not even the manifest's digest.
    expect(fake.state.ots.digests.some((d: { hex: string }) => d.hex === digest.toString('hex'))).toBe(false);
    const ots = serializeOts(r.timestamp);
    expect(summarize(parseOts(ots))).toEqual({ state: 'pending', calendars: calendars() });
  });
  it('pending until Bitcoin confirms; then complete, and it verifies against the block header', async () => {
    const digest = crypto.createHash('sha256').update('another song').digest();
    const { timestamp } = await stamp(digest, { calendars: calendars() });
    expect(await upgrade(timestamp)).toBe(false);
    fake.state.ots.confirmed = true;
    expect(await upgrade(timestamp)).toBe(true);
    const back = parseOts(serializeOts(timestamp));
    const s = summarize(back);
    expect(s.state).toBe('confirmed');
    const v = await verifyBitcoin(back, { explorer: `${mock}/esplora` });
    expect(v).toMatchObject({ verified: true, height: s.height });
    // Another file's digest with this proof's tree: not verified.
    const forged = parseOts(serializeOts(timestamp));
    forged.msg = crypto.createHash('sha256').update('forged').digest();
    const rebuilt = parseOts(serializeOts(forged));
    expect((await verifyBitcoin(rebuilt, { explorer: `${mock}/esplora` })).verified).toBe(false);
  });
  it('when fewer calendars answer than asked, it says so', async () => {
    await expect(stamp(Buffer.alloc(32, 1), { calendars: [`${mock}/ots-a`, `${mock}/nope`], min: 2 })).rejects.toThrow(/Only 1 of 2 calendars answered/);
  });
});
