import { describe, expect, it } from 'vitest';
import { newIdentity } from './crypto';
import { listenerState, newListener, openReply, sealReply, type Reply } from './reply';

const make = async () => {
  const me = await newIdentity();
  const l = await newListener();
  const reply: Reply = { format: 'openband-reply/1', id: 'r1', seriesId: 's', edition: 1, trackId: 't', versionId: 'v', from: { name: 'Luca della Vespa', key: l.publicKey }, createdAt: 1, items: [{ kind: 'reaction', t: 12.5, label: 'brividi' }] };
  return { me, l, reply };
};

describe('a return', () => {
  it('reaches the musician, signed', async () => {
    const { me, l, reply } = await make();
    const box = await sealReply(reply, l.privateKey, me.box.publicKey);
    expect(JSON.stringify(box)).not.toContain('brividi');
    expect(JSON.stringify(box)).not.toContain('Luca');
    expect(await openReply(box, me.box.privateKey)).toMatchObject({ signed: true, reply: { items: [{ label: 'brividi' }] } });
  });
  it('is unreadable to anyone else', async () => {
    const { me, l, reply } = await make();
    const box = await sealReply(reply, l.privateKey, me.box.publicKey);
    await expect(openReply(box, (await newIdentity()).box.privateKey)).rejects.toThrow();
  });
  it('tampered, it does not open', async () => {
    const { me, l, reply } = await make();
    const box = await sealReply(reply, l.privateKey, me.box.publicKey);
    await expect(openReply({ ...box, body: `A${box.body.slice(1)}` }, me.box.privateKey)).rejects.toThrow();
  });
  it('signed by another key with the same name, it says so', async () => {
    const { me, reply } = await make();
    const other = await newListener();
    const box = await sealReply(reply, other.privateKey, me.box.publicKey);
    expect((await openReply(box, me.box.privateKey)).signed).toBe(false);
    expect(listenerState({}, 'Luca', 'a')).toBe('new');
    expect(listenerState({ Luca: 'a' }, 'Luca', 'a')).toBe('same');
    expect(listenerState({ Luca: 'a' }, 'Luca', 'b')).toBe('changed');
  });
});
