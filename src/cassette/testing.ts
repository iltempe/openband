// For ?debug: a return as a listener would send it, without a microphone.
import { identity, type StoredCassette } from './burn';
import type { CassetteTrack } from './format';
import { newListener, sealReply, type ReplyItem } from './reply';
import { intake } from './returns';

export async function intakeReply(c: StoredCassette, t: CassetteTrack, name: string, items: ReplyItem[]) {
  const me = await newListener();
  const id = await identity();
  const box = await sealReply({ format: 'openband-reply/1', id: crypto.randomUUID(), seriesId: c.seriesId, edition: c.edition, trackId: t.id, versionId: t.versionId, from: { name, key: me.publicKey }, createdAt: Date.now(), items }, me.privateKey, id.box.publicKey);
  return intake(JSON.stringify(box));
}
