// Structural JSON patches for the journal (F21): diff(a, b) → ops, apply(a, ops) → b. Objects are
// diffed key by key; arrays of objects with an `id` (tracks, regions, notes, sections…) are diffed by id,
// so moving one note stores one small op, not the whole region. Other arrays are replaced when they
// differ. Pure and exact: apply(a, diff(a, b)) deep-equals b.

export type Path = (string | number)[];
export type Op =
  /** Set (or add) the value at a path. */
  | { o: 's'; p: Path; v: unknown }
  /** Delete a key. */
  | { o: 'd'; p: Path }
  /** An id-keyed array: the new order of ids, the new items, and the per-item patches of kept ones. */
  | { o: 'a'; p: Path; ids: string[]; add: Record<string, unknown>; ops: Record<string, Op[]> };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v);
const idArray = (v: unknown): v is { id: string }[] => Array.isArray(v) && v.length > 0 && v.every((x) => isObj(x) && typeof x.id === 'string') && new Set(v.map((x) => (x as { id: string }).id)).size === v.length;

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => equal(x, (b as unknown[])[i]));
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) return JSON.stringify(Array.from(a as ArrayLike<number>)) === JSON.stringify(Array.from(b as ArrayLike<number>));
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => equal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

export function diff(a: unknown, b: unknown, p: Path = [], out: Op[] = []): Op[] {
  if (equal(a, b)) return out;
  if (isObj(a) && isObj(b)) {
    for (const k of Object.keys(a)) if (a[k] !== undefined && b[k] === undefined) out.push({ o: 'd', p: [...p, k] });
    for (const k of Object.keys(b)) if (b[k] !== undefined) diff(a[k], b[k], [...p, k], out);
    return out;
  }
  if (idArray(a) && idArray(b)) {
    const before = new Map(a.map((x) => [x.id, x]));
    const add: Record<string, unknown> = {};
    const ops: Record<string, Op[]> = {};
    for (const x of b) {
      const old = before.get(x.id);
      if (!old) add[x.id] = clone(x);
      else {
        const d = diff(old, x);
        if (d.length) ops[x.id] = d;
      }
    }
    out.push({ o: 'a', p, ids: b.map((x) => x.id), add, ops });
    return out;
  }
  out.push({ o: 's', p, v: clone(b) });
  return out;
}

function applyOp(root: unknown, op: Op): unknown {
  if (op.p.length === 0) return applyAt(root, op);
  let parent = root as Record<string | number, unknown>;
  for (let i = 0; i < op.p.length - 1; i++) {
    const k = op.p[i];
    if (parent[k] === undefined || parent[k] === null || typeof parent[k] !== 'object') parent[k] = {};
    parent = parent[k] as Record<string | number, unknown>;
  }
  const last = op.p[op.p.length - 1];
  if (op.o === 'd') delete parent[last];
  else parent[last] = applyAt(parent[last], op);
  return root;
}

function applyAt(cur: unknown, op: Op): unknown {
  if (op.o === 's') return clone(op.v);
  if (op.o === 'd') return undefined;
  const byId = new Map(Array.isArray(cur) ? (cur as { id: string }[]).filter((x) => isObj(x)).map((x) => [x.id, x]) : []);
  return op.ids.map((id) => {
    if (id in op.add) return clone(op.add[id]);
    let item: unknown = byId.get(id);
    if (item === undefined) throw new Error(`Journal patch refers to a missing item "${id}"`);
    for (const o of op.ops[id] ?? []) item = applyOp(item, o);
    return item;
  });
}

/** Apply ops to a deep copy of `base`. */
export function apply<T>(base: T, ops: Op[]): T {
  let root: unknown = structuredClone(base);
  for (const op of ops) root = applyOp(root, op);
  return root as T;
}

export { equal as deepEqual };
