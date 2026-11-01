import type { Project } from '../types';

/** Every sample a project depends on (imported instruments and audio clips). */
export const projectSampleIdsOf = (p: Project) => [
  ...(p.instruments ?? []).flatMap((i) => i.zones.map((z) => z.sampleId)),
  ...p.regions.flatMap((r) => (r.audio ? [r.audio.sampleId] : [])),
  ...(p.reference ? [p.reference.sampleId] : []),
  ...p.tracks.flatMap((t) => (t.frozen ? [t.frozen.sampleId] : [])),
  ...(p.protections ?? []).flatMap((x) => (x.masterSampleId ? [x.masterSampleId] : [])),
];
