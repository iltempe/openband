// Standard MIDI File (SMF) reading and writing, plus the mapping between General MIDI programs
// and OpenBand's instruments.
import type { Project } from './types';

const PPQ = 480;

// ---------- General MIDI mapping ----------

/** GM program (0-based) used when exporting each built-in preset. */
const PRESET_PROGRAM: Record<string, number> = {
  'felt-piano': 0,
  'velvet-keys': 4,
  'retro-organ': 16,
  'crystal-bells': 14,
  'neon-lead': 81,
  pluck: 46,
  chip: 80,
  'sub-bass': 38,
  'acid-bass': 39,
  'finger-bass': 33,
  'aurora-pad': 89,
  'silk-strings': 50,
};

/** Closest built-in preset for a GM program, used when importing. */
export function presetForProgram(program: number): string {
  if (program === 4 || program === 5) return 'velvet-keys';
  if (program <= 7) return 'felt-piano';
  if (program <= 15) return 'crystal-bells';
  if (program <= 23) return 'retro-organ';
  if (program <= 31) return 'pluck';
  if (program === 38) return 'sub-bass';
  if (program === 39) return 'acid-bass';
  if (program <= 39) return 'finger-bass';
  if (program <= 55) return 'silk-strings';
  if (program <= 79) return 'neon-lead';
  if (program === 80) return 'chip';
  if (program <= 87) return 'neon-lead';
  if (program <= 103) return 'aurora-pad';
  return 'pluck';
}

// ---------- writing ----------

function vlq(n: number): number[] {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
}
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const text = (s: string) => [...new TextEncoder().encode(s)];

function chunk(id: string, body: number[]) {
  return [...text(id), ...u32(body.length), ...body];
}

interface Ev {
  tick: number;
  /** Sort key at the same tick: note-offs before note-ons. */
  order: number;
  bytes: number[];
}

function trackChunk(events: Ev[]) {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const body: number[] = [];
  let last = 0;
  for (const e of events) {
    body.push(...vlq(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  body.push(0, 0xff, 0x2f, 0); // end of track
  return chunk('MTrk', body);
}

const meta = (tick: number, type: number, data: number[]): Ev => ({ tick, order: -1, bytes: [0xff, type, ...vlq(data.length), ...data] });

/** Export every instrument and drum track (audio tracks have no MIDI) as a format-1 file. */
export function writeMidi(p: Project): Uint8Array {
  const usPerBeat = Math.round(60_000_000 / p.bpm);
  const conductor: Ev[] = [
    meta(0, 0x03, text(p.name)),
    meta(0, 0x51, [(usPerBeat >> 16) & 0xff, (usPerBeat >> 8) & 0xff, usPerBeat & 0xff]),
    meta(0, 0x58, [4, 2, 24, 8]),
  ];
  const tracks = [trackChunk(conductor)];
  let nextChannel = 0;
  for (const t of p.tracks) {
    if (t.kind === 'audio') continue;
    let channel = 9;
    if (t.kind !== 'drums') {
      if (nextChannel === 9) nextChannel++;
      channel = nextChannel++ % 16;
      if (channel === 9) channel = 10;
    }
    const evs: Ev[] = [meta(0, 0x03, text(t.name))];
    if (t.kind !== 'drums') evs.push({ tick: 0, order: 0, bytes: [0xc0 | channel, PRESET_PROGRAM[t.instrument] ?? 0] });
    evs.push({ tick: 0, order: 0, bytes: [0xb0 | channel, 7, Math.round(Math.min(1, t.volume / 0.8) * 100)] });
    evs.push({ tick: 0, order: 0, bytes: [0xb0 | channel, 10, Math.round(64 + t.pan * 63)] });
    for (const r of p.regions.filter((x) => x.trackId === t.id)) {
      for (const n of r.notes) {
        if (n.start < 0 || n.start >= r.length) continue;
        const on = Math.round((r.start + n.start) * PPQ);
        const off = Math.max(on + 1, Math.round((r.start + Math.min(n.start + n.duration, r.length)) * PPQ));
        const vel = Math.max(1, Math.min(127, Math.round(n.velocity * 127)));
        evs.push({ tick: on, order: 1, bytes: [0x90 | channel, n.pitch, vel] });
        evs.push({ tick: off, order: 0, bytes: [0x80 | channel, n.pitch, 0] });
      }
    }
    tracks.push(trackChunk(evs));
  }
  const header = chunk('MThd', [0, 1, (tracks.length >> 8) & 0xff, tracks.length & 0xff, (PPQ >> 8) & 0xff, PPQ & 0xff]);
  return new Uint8Array([...header, ...tracks.flat()]);
}

// ---------- reading ----------

export interface MidiNote {
  pitch: number;
  /** In beats from the song start. */
  start: number;
  duration: number;
  velocity: number;
}

export interface MidiPart {
  name: string;
  channel: number;
  program: number;
  notes: MidiNote[];
}

export interface MidiSong {
  name?: string;
  bpm?: number;
  parts: MidiPart[];
}

export function readMidi(data: ArrayBuffer): MidiSong {
  const v = new DataView(data);
  const id = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (v.byteLength < 14 || id(0) !== 'MThd') throw new Error('Not a MIDI file');
  const nTracks = v.getUint16(10);
  const division = v.getUint16(12);
  if (division & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported');
  const tpb = division || 480;
  const song: MidiSong = { parts: [] };
  // Parts keyed by track + channel, so format-0 files are split per channel.
  const parts = new Map<string, MidiPart>();
  let o = 8 + v.getUint32(4);

  for (let tr = 0; tr < nTracks && o + 8 <= v.byteLength; tr++) {
    const len = v.getUint32(o + 4);
    const end = Math.min(v.byteLength, o + 8 + len);
    let p = o + 8;
    o = end;
    if (id(p - 8) !== 'MTrk') continue;
    let tick = 0;
    let status = 0;
    let trackName = '';
    const programs = new Map<number, number>();
    const open = new Map<number, { tick: number; vel: number }[]>();
    const readVlq = () => {
      let n = 0;
      for (let i = 0; i < 4 && p < end; i++) {
        const b = v.getUint8(p++);
        n = (n << 7) | (b & 0x7f);
        if (!(b & 0x80)) break;
      }
      return n;
    };
    const partFor = (ch: number) => {
      const key = `${tr}:${ch}`;
      let part = parts.get(key);
      if (!part) {
        part = { name: trackName, channel: ch, program: programs.get(ch) ?? 0, notes: [] };
        parts.set(key, part);
      }
      return part;
    };
    const close = (ch: number, pitch: number, at: number) => {
      const stack = open.get(ch * 128 + pitch);
      const start = stack?.shift();
      if (!start) return;
      partFor(ch).notes.push({ pitch, start: start.tick / tpb, duration: Math.max(1, at - start.tick) / tpb, velocity: start.vel / 127 });
    };

    while (p < end) {
      tick += readVlq();
      let b = v.getUint8(p);
      if (b & 0x80) {
        p++;
        if (b < 0xf0) status = b;
      } else {
        b = status; // running status
      }
      if (b === 0xff) {
        const type = v.getUint8(p++);
        const l = readVlq();
        const bytes = new Uint8Array(data, p, Math.min(l, end - p));
        p += l;
        if (type === 0x51 && l === 3 && song.bpm === undefined) song.bpm = Math.round((60_000_000 / ((bytes[0] << 16) | (bytes[1] << 8) | bytes[2])) * 100) / 100;
        if (type === 0x03) {
          trackName = new TextDecoder().decode(bytes).trim();
          if (tr === 0 && !song.name) song.name = trackName;
          for (const part of parts.values()) if (part.name === '' && part.notes.length === 0) part.name = trackName;
        }
        continue;
      }
      if (b === 0xf0 || b === 0xf7) {
        p += readVlq();
        continue;
      }
      const type = b & 0xf0;
      const ch = b & 0x0f;
      const d1 = v.getUint8(p++);
      const d2 = type === 0xc0 || type === 0xd0 ? 0 : v.getUint8(p++);
      if (type === 0x90 && d2 > 0) {
        const key = ch * 128 + d1;
        if (!open.has(key)) open.set(key, []);
        open.get(key)!.push({ tick, vel: d2 });
        partFor(ch);
      } else if (type === 0x80 || (type === 0x90 && d2 === 0)) {
        close(ch, d1, tick);
      } else if (type === 0xc0) {
        programs.set(ch, d1);
        const part = parts.get(`${tr}:${ch}`);
        if (part && !part.notes.length) part.program = d1;
      }
    }
    // Notes never released end at the end of the track.
    for (const [key, stack] of open) while (stack.length) close(Math.floor(key / 128), key % 128, tick);
  }

  song.parts = [...parts.values()].filter((p) => p.notes.length).map((p) => ({ ...p, notes: p.notes.sort((a, b) => a.start - b.start) }));
  return song;
}
