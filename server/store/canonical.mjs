// canonicalJSON of src/versions/canonical.ts for the server: the etag is a hash of it, so a browser and a
// server agree on when two songs are the same. server/store/store.test.ts checks the two give equal strings.
const round = (x) => (Number.isInteger(x) ? x : Math.round(x * 1e4) / 1e4);

function normalize(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? round(v) : null;
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = normalize(v[k]);
    return out;
  }
  return v;
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byNote = (a, b) => cmp(round(a.start), round(b.start)) || a.pitch - b.pitch || cmp(a.id, b.id);
/** automation.ts targetKey. */
const targetKey = (t) => (t.kind === 'mix' ? `mix:${t.param}` : t.kind === 'fx' ? `fx:${t.unit}.${t.param}` : `plugin:${t.slotId ?? 'instrument'}:${t.paramId}`);

export function canonicalJSON(p) {
  const c = structuredClone(p);
  c.regions = (c.regions ?? [])
    .map((r) => ({ ...r, notes: [...r.notes].sort(byNote), ...(r.takes ? { takes: r.takes.map((t) => ({ ...t, notes: [...t.notes].sort(byNote) })) } : {}) }))
    .sort((a, b) => cmp(a.trackId, b.trackId) || cmp(round(a.start), round(b.start)) || cmp(a.id, b.id));
  if (c.sections) c.sections = [...c.sections].sort((a, b) => a.start - b.start || cmp(a.id, b.id));
  if (c.instruments) c.instruments = [...c.instruments].sort((a, b) => cmp(a.id, b.id));
  if (c.annotations) c.annotations = [...c.annotations].sort((a, b) => a.createdAt - b.createdAt || cmp(a.id, b.id));
  for (const t of c.tracks ?? [])
    if (t.automation) t.automation = t.automation.map((l) => ({ ...l, points: [...l.points].sort((a, b) => a.beat - b.beat) })).sort((a, b) => cmp(targetKey(a.target), targetKey(b.target)));
  if (c.meta) c.meta = { ...c.meta, updatedAt: 0 };
  return JSON.stringify(normalize(c), null, 2);
}

/** store.ts projectSampleIds: every sample a project depends on. */
export const projectSampleIds = (p) => [
  ...(p.instruments ?? []).flatMap((i) => i.zones.map((z) => z.sampleId)),
  ...(p.regions ?? []).flatMap((r) => (r.audio ? [r.audio.sampleId] : [])),
  ...(p.reference ? [p.reference.sampleId] : []),
  ...(p.tracks ?? []).flatMap((t) => (t.frozen ? [t.frozen.sampleId] : [])),
  ...(p.protections ?? []).flatMap((x) => (x.masterSampleId ? [x.masterSampleId] : [])),
];
