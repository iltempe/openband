// A return (D2.2): signed by the listener, sealed for the musician. Whatever road it takes, only the musician reads it.
import { canonical, fromB64u, openFrom, sealFor, signText, toB64u, verifyText, newSigner } from './crypto';

export type ReplyItem =
  | { kind: 'reaction'; t: number; t2?: number; label: string }
  | { kind: 'comment'; t: number; t2?: number; text: string }
  | { kind: 'voice'; t: number; blob: string; type: string }
  | { kind: 'overdub'; start: number; blob: string; type: string; latencyMs: number; headphones: boolean; label?: string }
  | { kind: 'listen'; segments: [number, number][]; completed: boolean; plays: number };

export interface Reply {
  format: 'openband-reply/1';
  id: string;
  seriesId: string;
  edition: number;
  trackId: string;
  versionId: string;
  from: { name: string; key: JsonWebKey };
  createdAt: number;
  items: ReplyItem[];
  via?: string;
}

export interface ReplyBox {
  format: 'openband-reply-box/1';
  epk: JsonWebKey;
  salt: string;
  body: string;
}

export const MAX_OVERDUB = 50 * 1024 * 1024;
export const newListener = newSigner;
export const b64 = toB64u;
export const unb64 = fromB64u;

export async function sealReply(r: Reply, signPrivate: JsonWebKey, boxKey: JsonWebKey): Promise<ReplyBox> {
  const signature = await signText(signPrivate, canonical(r));
  const box = await sealFor(boxKey, new TextEncoder().encode(JSON.stringify({ reply: r, signature })));
  return { format: 'openband-reply-box/1', ...box };
}

export interface Opened {
  reply: Reply;
  /** The signature is by the key in the reply. */
  signed: boolean;
}

export async function openReply(box: ReplyBox, boxPrivate: JsonWebKey): Promise<Opened> {
  const { reply, signature } = JSON.parse(new TextDecoder().decode(await openFrom(boxPrivate, box))) as { reply: Reply; signature: string };
  return { reply, signed: await verifyText(reply.from.key, canonical(reply), signature).catch(() => false) };
}

/** Same name, other key: "Luca has a new device?", and the musician decides. */
export function listenerState(known: Record<string, string>, name: string, keyPrint: string): 'new' | 'same' | 'changed' {
  const have = known[name];
  return !have ? 'new' : have === keyPrint ? 'same' : 'changed';
}
