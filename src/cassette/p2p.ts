// The P2P road for returns (D2.3): plain WebRTC over the y-webrtc signaling protocol, on the signaling server the
// musician chose. Works only while the studio is open. Shared by the player and the studio.
import { sha256 } from './crypto';

const CHUNK = 16 * 1024;
const ICE_MS = 2500;
const OPEN_MS = 12000;

/** The room comes from the series key: it can't be guessed. */
export const returnsRoom = async (seriesKey: string) => (await sha256(new TextEncoder().encode(`returns:${seriesKey}`))).slice(0, 32);

function iceDone(pc: RTCPeerConnection) {
  return new Promise<void>((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const t = setTimeout(resolve, ICE_MS);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(t);
        resolve();
      }
    });
  });
}

const signal = (url: string, room: string, on: (data: Record<string, unknown>, send: (d: unknown) => void) => void) => {
  const ws = new WebSocket(url);
  const send = (data: unknown) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'publish', topic: room, data }));
  ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', topics: [room] }));
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as { type: string; data?: Record<string, unknown> };
    if (m.type === 'publish' && m.data) on(m.data, send);
  };
  return { ws, send };
};

/** Listener's side: resolves true once the studio has the whole packet. */
export function sendP2P(urls: string[], room: string, text: string, timeoutMs = OPEN_MS) {
  return new Promise<boolean>((resolve) => {
    const id = Math.random().toString(36).slice(2);
    const pc = new RTCPeerConnection();
    const dc = pc.createDataChannel('return');
    let finished = false;
    const socks: WebSocket[] = [];
    const finish = (ok: boolean) => {
      if (finished) return;
      finished = true;
      socks.forEach((s) => s.close());
      pc.close();
      resolve(ok);
    };
    setTimeout(() => finish(false), timeoutMs);
    dc.onopen = () => {
      for (let i = 0; i < text.length; i += CHUNK) dc.send(text.slice(i, i + CHUNK));
      dc.send('\u0000');
    };
    dc.onmessage = (e) => e.data === 'ok' && finish(true);
    void (async () => {
      await pc.setLocalDescription(await pc.createOffer());
      await iceDone(pc);
      for (const url of urls) {
        const s = signal(url, room, (d) => {
          if (d.to === id && d.answer) void pc.setRemoteDescription(d.answer as RTCSessionDescriptionInit);
        });
        socks.push(s.ws);
        // The studio may be opening: say it again until it answers.
        const offer = () => s.send({ from: id, offer: pc.localDescription });
        s.ws.addEventListener('open', () => setTimeout(offer, 100));
        const again = setInterval(() => (finished ? clearInterval(again) : offer()), 2000);
      }
    })().catch(() => finish(false));
  });
}

/** Studio's side: every packet that arrives, until `stop`. */
export function listenP2P(urls: string[], room: string, onPacket: (text: string) => void) {
  const seen = new Set<string>();
  const socks = urls.map(
    (url) =>
      signal(url, room, (d, send) => {
        const from = d.from as string | undefined;
        if (!d.offer || !from || seen.has(from)) return;
        seen.add(from);
        const pc = new RTCPeerConnection();
        pc.ondatachannel = (e) => {
          let text = '';
          e.channel.onmessage = (m) => {
            if (m.data !== '\u0000') return void (text += String(m.data));
            onPacket(text);
            e.channel.send('ok');
          };
        };
        void (async () => {
          await pc.setRemoteDescription(d.offer as RTCSessionDescriptionInit);
          await pc.setLocalDescription(await pc.createAnswer());
          await iceDone(pc);
          send({ to: from, answer: pc.localDescription });
        })();
      }).ws,
  );
  return () => socks.forEach((s) => s.close());
}
