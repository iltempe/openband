// VST3 preset files (.vstpreset, Steinberg's format, as DAWproject stores a VST3 plugin's state) ↔ the
// state of a VST3 plugin in OpenBand (openband-plughost: [u32 component size][component][controller]).
//   header  "VST3", int32 version (1), the class id as 32 ASCII hex digits, int64 offset of the chunk list
//   data    the chunks
//   list    "List", int32 count, then per chunk: 4-char id ("Comp", "Cont", "Info"), int64 offset, int64 size
// Little-endian throughout.

const HEADER = 48;
const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

/** A .vstpreset → its class id and the plugin state as openband-plughost keeps it; null if it isn't one. */
export function vstPresetToState(file: Uint8Array): { classId: string; state: Uint8Array } | null {
  if (file.length < HEADER || ascii(file, 0, 4) !== 'VST3') return null;
  const v = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const classId = ascii(file, 8, 32);
  const list = Number(v.getBigInt64(40, true));
  if (list < HEADER || list + 8 > file.length || ascii(file, list, 4) !== 'List') return null;
  const count = v.getInt32(list + 4, true);
  const chunks = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    const at = list + 8 + i * 20;
    if (at + 20 > file.length) return null;
    const off = Number(v.getBigInt64(at + 4, true));
    const size = Number(v.getBigInt64(at + 12, true));
    if (off < 0 || size < 0 || off + size > file.length) return null;
    chunks.set(ascii(file, at, 4), file.subarray(off, off + size));
  }
  const comp = chunks.get('Comp') ?? new Uint8Array(0);
  const cont = chunks.get('Cont') ?? new Uint8Array(0);
  const state = new Uint8Array(4 + comp.length + cont.length);
  new DataView(state.buffer).setUint32(0, comp.length, true);
  state.set(comp, 4);
  state.set(cont, 4 + comp.length);
  return { classId, state };
}

/** The plugin state as openband-plughost keeps it → a .vstpreset for a class id (32 hex digits). */
export function stateToVstPreset(classId: string, state: Uint8Array): Uint8Array {
  const sv = new DataView(state.buffer, state.byteOffset, state.byteLength);
  const compLen = state.length >= 4 ? Math.min(sv.getUint32(0, true), state.length - 4) : 0;
  const comp = state.subarray(4, 4 + compLen);
  const cont = state.subarray(4 + compLen);
  const chunks: [string, Uint8Array][] = [['Comp', comp], ...(cont.length ? ([['Cont', cont]] as [string, Uint8Array][]) : [])];
  const dataLen = chunks.reduce((n, [, c]) => n + c.length, 0);
  const out = new Uint8Array(HEADER + dataLen + 8 + chunks.length * 20);
  const v = new DataView(out.buffer);
  const put = (at: number, s: string) => [...s].forEach((ch, i) => (out[at + i] = ch.charCodeAt(0)));
  put(0, 'VST3');
  v.setInt32(4, 1, true);
  put(8, classId.toUpperCase().padEnd(32, '0').slice(0, 32));
  let at = HEADER;
  const offsets: number[] = [];
  for (const [, c] of chunks) {
    offsets.push(at);
    out.set(c, at);
    at += c.length;
  }
  v.setBigInt64(40, BigInt(at), true);
  put(at, 'List');
  v.setInt32(at + 4, chunks.length, true);
  chunks.forEach(([id, c], i) => {
    const e = at + 8 + i * 20;
    put(e, id);
    v.setBigInt64(e + 4, BigInt(offsets[i]), true);
    v.setBigInt64(e + 12, BigInt(c.length), true);
  });
  return out;
}
