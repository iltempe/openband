// Draw the song (G2) in the app: the curve in the project, the arrangement on a branch of its own
// (arrangement-<n>, opened in compare view against the song as it was), its transitions rendered to
// samples, and transitions added one at a time.
import type { Note, Project, Region } from '../types';
import { BEATS_PER_BAR, uid } from '../music';
import { makeTrack, useStore } from '../store';
import { encodePcm } from '../audio/render';
import { importSample } from '../audio/samples';
import { createBranch, checkout, replaceProject, saveVersion, startCompare, useVersions } from '../versioning';
import { splitAllAt } from '../structure';
import { generateDrums } from '../generate/drummer';
import { arrange, transitionSample, type ArrangeOptions, type TransitionKind } from './arrange';
import { ENERGY_SHAPES, barsFor, curveAt, measureEnergy, shapeCurve, type EnergyCurve, type EnergyShape } from './energy';
import { synthTransition } from './transitions';

const st = () => useStore.getState();
const SR = 48000;

/** Set the drawn curve: points, or a shape (pop, slow_build, edm_drop, ballad) for a length. */
export function setEnergyCurve(o: { points?: { bar: number; energy: number }[]; shape?: string; length_bars?: number; seconds?: number }) {
  const p = st().project;
  const current = Math.ceil(Math.max(0, ...p.regions.map((r) => r.start + r.length)) / BEATS_PER_BAR);
  const length = o.length_bars ?? (o.seconds ? barsFor(o.seconds, p.bpm) : (p.energy?.length_bars ?? Math.max(32, Math.round(current / 4) * 4 * 4)));
  let curve: EnergyCurve;
  if (o.shape) {
    if (!ENERGY_SHAPES.includes(o.shape as EnergyShape)) throw new Error(`Shapes: ${ENERGY_SHAPES.join(', ')}`);
    curve = shapeCurve(o.shape as EnergyShape, length);
  } else if (o.points?.length) {
    const pts = o.points.map((x) => ({ bar: Math.max(1, Math.round(x.bar)), energy: Math.max(0, Math.min(1, x.energy)) })).sort((a, b) => a.bar - b.bar);
    curve = { points: pts, length_bars: o.length_bars ?? Math.max(length, Math.ceil(pts[pts.length - 1].bar / 4) * 4) };
  } else throw new Error('Give points [{bar, energy 0..1}] or a shape');
  st().commit((d) => void (d.energy = curve), { label: 'Draw the energy' });
  return { length_bars: curve.length_bars, points: curve.points.length, ...(curve.shape ? { shape: curve.shape } : {}) };
}

/** The drawn curve and the measured one, per bar. */
export function getEnergy() {
  const p = st().project;
  const measured = measureEnergy(p);
  const bars = Math.max(measured.length, p.energy?.length_bars ?? 0);
  return {
    bars,
    drawn: p.energy ? Array.from({ length: bars }, (_, b) => +curveAt(p.energy as EnergyCurve, b + 1).toFixed(3)) : null,
    measured: [...measured, ...new Array(Math.max(0, bars - measured.length)).fill(0)],
    ...(p.energy?.shape ? { shape: p.energy.shape } : {}),
  };
}

/** Render the arrangement's transitions and point its regions at the samples. */
async function renderTransitions(p: Project) {
  const ids = new Map<string, string>();
  for (const r of p.regions) {
    const ref = r.audio?.sampleId;
    if (!ref?.startsWith('transition:')) continue;
    if (!ids.has(ref)) {
      const [, kind, seconds] = ref.split(':');
      const x = synthTransition(kind as Exclude<TransitionKind, 'fill' | 'stop'>, Number(seconds), SR);
      const wav = encodePcm([x, x], SR, 16);
      const info = await importSample(wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer, `${kind.replace('_', ' ')} ${(+seconds).toFixed(1)} s`, 'audio/wav');
      ids.set(ref, info.id);
    }
    r.audio!.sampleId = ids.get(ref)!;
  }
}

/** Arrange the song from its curve; on a new branch, opened in compare view (as_branch, default). */
export async function arrangeFromEnergy(o: Omit<ArrangeOptions, 'curve'> & { as_branch?: boolean }, author: 'user' | 'ai' = 'user') {
  const p = st().project;
  if (!p.energy?.points.length) throw new Error('Draw the energy first (set_energy_curve: points or a shape)');
  if (!p.regions.some((r) => r.notes.length || r.audio)) throw new Error('There is nothing to arrange yet: write a loop first');
  const a = arrange(p, { ...o, curve: p.energy as EnergyCurve });
  await renderTransitions(a.project);
  let branch: string | null = null;
  if (o.as_branch !== false) {
    const before = await saveVersion('Before arranging', author);
    const taken = new Set(useVersions.getState().branches.map((b) => b.name));
    let n = 1;
    while (taken.has(`arrangement-${n}`)) n++;
    branch = `arrangement-${n}`;
    await createBranch(branch, before.id);
    await checkout({ branch }, author);
    replaceProject(a.project, 'Arrange from energy');
    await saveVersion('Arrangement from energy', author, { branch });
    await startCompare(before.id);
  } else replaceProject(a.project, 'Arrange from energy');
  return {
    ...(branch ? { branch, compare: 'open: the song as it was, against the arrangement' } : {}),
    sections: a.sections,
    transitions: a.transitions,
    ending: a.ending,
    length_bars: a.target.length,
    follows_the_curve: a.correlation,
  };
}

/** One transition at a bar: an audio one on the "FX transitions" track, a drum fill, or a stop. */
export async function addTransition(o: { at_bar: number; kind: TransitionKind; bars?: number }) {
  const p = st().project;
  const at = (Math.max(1, Math.round(o.at_bar)) - 1) * BEATS_PER_BAR;
  const bars = Math.max(1, Math.min(8, Math.round(o.bars ?? (o.kind === 'riser' || o.kind === 'downlifter' ? 2 : 1))));
  if (o.kind === 'stop') {
    // A bar of silence: everything but the transitions is cut out of it (one undo step).
    st().commit((d) => {
      splitAllAt(d, at);
      splitAllAt(d, at + BEATS_PER_BAR);
      const fx = new Set(d.tracks.filter((t) => t.name === 'FX transitions').map((t) => t.id));
      d.regions = d.regions.filter((r) => fx.has(r.trackId) || !(r.start >= at - 1e-6 && r.start + r.length <= at + BEATS_PER_BAR + 1e-6));
    }, { label: 'Add a stop' });
    return { kind: 'stop', bar: o.at_bar };
  }
  if (o.kind === 'fill') {
    const drums = p.tracks.find((t) => t.kind === 'drums');
    if (!drums) throw new Error('A fill needs a drum track');
    const notes: Note[] = generateDrums([{ start: 0, bars: 1 }], { style: 'pop', complexity: 0.8, loudness: 0.8, swing: 0, fills: 'end_of_section', seed: o.at_bar }).filter((n) => n.start >= 2).map((n) => ({ ...n, id: uid('n'), start: n.start - 2 }));
    const r: Region = { id: uid('rgn'), trackId: drums.id, name: 'Fill', start: at + 2, length: 2, notes };
    st().commit((d) => void d.regions.push(r), { label: 'Add a fill' });
    return { kind: 'fill', bar: o.at_bar, region_id: r.id };
  }
  const seconds = +((bars * BEATS_PER_BAR * 60) / p.bpm).toFixed(2);
  const x = synthTransition(o.kind, seconds, SR);
  const wav = encodePcm([x, x], SR, 16);
  const info = await importSample(wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer, `${o.kind.replace('_', ' ')} ${seconds.toFixed(1)} s`, 'audio/wav');
  let track = p.tracks.find((t) => t.name === 'FX transitions');
  const fresh = !track;
  if (!track) {
    track = makeTrack(p, 'audio', undefined, 'FX transitions');
    track.role = 'fx';
    track.volume = 0.6;
  }
  // A riser or reverse cymbal ends on the bar; the others start there.
  const start = o.kind === 'riser' || o.kind === 'reverse_cymbal' ? Math.max(0, at - bars * BEATS_PER_BAR) : at;
  const r: Region = { id: uid('rgn'), trackId: track.id, name: o.kind.replace('_', ' '), start, length: bars * BEATS_PER_BAR, notes: [], audio: { sampleId: info.id, offset: 0, gain: 1 } };
  const t = track;
  st().commit((d) => {
    if (fresh) d.tracks.push(t);
    d.regions.push(r);
  }, { label: `Add a ${o.kind.replace('_', ' ')}` });
  return { kind: o.kind, bar: o.at_bar, bars, region_id: r.id, track_id: t.id };
}

export { transitionSample };
