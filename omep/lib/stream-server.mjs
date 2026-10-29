// The engine's end of OMEP stream 1.0 (stream.mjs): a WebSocket server on this computer (or the LAN) that
// sessions open through the `stream.jam` tool. Each session runs a StreamProducer on the studio's clock and
// asks the engine's `render` for the frames it owes, in order:
//
//   const host = await createStreamHost({ render: async ({ beat, frames, bpm, control }) => Float32Array });
//   const s = host.open({ style, chords, intensity });   → { session, url }
//   host.close(session)
//
// `render` returns frames × 2 interleaved samples at 48 kHz. It may be slower than real time: the studio
// sees it in clock_ack (gen_ms) and in its underruns. `delay` makes every message late on purpose (the
// mock engine's simulated network).
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { encodeFrame, FRAME_SAMPLES, SAMPLE_RATE, STREAM_PROTOCOL, StreamProducer } from './stream.mjs';

export async function createStreamHost({ render, host = '127.0.0.1', port = 0, delay = null, log = () => {} } = {}) {
  const sessions = new Map();
  const wss = new WebSocketServer({ host, port, maxPayload: 1 << 20 });
  await new Promise((ok, fail) => {
    wss.once('listening', ok);
    wss.once('error', fail);
  });
  const address = wss.address();
  const send = (ws, data) => {
    const go = () => ws.readyState === 1 && ws.send(data);
    const d = delay?.();
    if (d > 0) setTimeout(go, d);
    else go();
  };

  wss.on('connection', (ws, req) => {
    const id = new URL(req.url || '/', 'http://x').pathname.split('/').pop();
    const s = sessions.get(id);
    if (!s || s.ws) return void ws.close(4404, 'Unknown or used session');
    s.ws = ws;
    const producer = new StreamProducer({ now: () => performance.now() });
    let busy = false;
    let genMs = 0;
    const pump = async () => {
      if (busy || ws.readyState !== 1) return;
      busy = true;
      try {
        for (const f of producer.due()) {
          const t = performance.now();
          const samples = await render({ beat: f.beat, frames: f.frames, bpm: f.bpm, control: s.control, seq: f.seq });
          genMs = genMs ? genMs * 0.9 + (performance.now() - t) * 0.1 : performance.now() - t;
          send(ws, encodeFrame({ seq: f.seq, beat: f.beat, epoch: f.epoch, samples }));
        }
      } catch (e) {
        send(ws, JSON.stringify({ type: 'error', message: e.message }));
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(pump, 5);
    send(ws, JSON.stringify({ type: 'ready', protocol: STREAM_PROTOCOL, sample_rate: SAMPLE_RATE, channels: 2, frame_samples: FRAME_SAMPLES }));
    ws.on('message', (data, binary) => {
      if (binary) return;
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.type === 'clock') {
        const r = producer.clock(msg);
        send(ws, JSON.stringify({ type: 'clock_ack', seq: msg.seq, sent_ms: msg.sent_ms, produced_beat: r.produced_beat, lead_ms: r.lead_ms, gen_ms: +genMs.toFixed(2), frame_ms: (FRAME_SAMPLES / SAMPLE_RATE) * 1000 }));
        void pump();
      } else if (msg.type === 'control') {
        s.control = { ...s.control, ...pick(msg) };
        s.onControl?.(s.control);
      }
    });
    ws.on('close', () => {
      clearInterval(timer);
      sessions.delete(id);
      log(`stream ${id} closed`);
    });
  });

  return {
    url: (id) => `ws://${address.address === '::' ? '127.0.0.1' : address.address}:${address.port}/s/${id}`,
    port: address.port,
    open(control = {}, onControl) {
      const session = crypto.randomBytes(16).toString('hex');
      sessions.set(session, { control: pick(control), ws: null, onControl, opened: Date.now() });
      // A session nobody connects to does not stay open.
      setTimeout(() => {
        const s = sessions.get(session);
        if (s && !s.ws) sessions.delete(session);
      }, 60000).unref?.();
      return { session, url: this.url(session) };
    },
    close(session) {
      const s = sessions.get(session);
      sessions.delete(session);
      s?.ws?.close(1000, 'closed');
      return !!s;
    },
    get open_sessions() {
      return sessions.size;
    },
    async stop() {
      for (const s of sessions.values()) s.ws?.close(1001, 'engine stopping');
      await new Promise((ok) => wss.close(ok));
    },
  };
}

/** What a studio may steer: style (words), chords (one per bar, repeating), intensity 0..1. */
function pick(m) {
  const out = {};
  if (typeof m.style === 'string') out.style = m.style.slice(0, 500);
  if (Array.isArray(m.chords)) out.chords = m.chords.slice(0, 64).map(String);
  if (Number.isFinite(m.intensity)) out.intensity = Math.max(0, Math.min(1, Number(m.intensity)));
  return out;
}
