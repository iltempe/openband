// Build a song from a plan with the same commands the AI uses, as one undoable step.
import { runCommand } from '../commands';
import { useStore } from '../store';
import type { SongPlan } from './plan';

type R = Record<string, unknown>;
const run = (m: string, a: R) => runCommand(m, a, 'ui') as Promise<R>;

/** A fresh song from the plan (replaces the open one; undo brings it back). */
export async function applyPlan(plan: SongPlan, opts: { replace?: boolean; label?: string } = {}) {
  const st = useStore.getState();
  const tx = st.beginTransaction(opts.label ?? plan.name, 'ui');
  try {
    if (opts.replace !== false) await run('new_project', { name: plan.name, bpm: plan.bpm, key: plan.key });
    else {
      await run('set_tempo', { bpm: plan.bpm });
      await run('set_key', { key: plan.key });
    }
    const firstRegion: string[] = [];
    for (const t of plan.tracks) {
      const { track_id } = (await run('add_track', { kind: t.kind ?? 'instrument', instrument: t.instrument, name: t.name })) as { track_id: string };
      if (t.volume !== undefined || t.pan !== undefined || t.reverb !== undefined) await run('update_track', { track_id, volume: t.volume, pan: t.pan, reverb: t.reverb });
      let first: string | undefined;
      for (const p of t.parts) {
        const r =
          p.type === 'drums'
            ? await run('add_drum_pattern', { track_id, start_bar: p.start_bar, bars: p.bars, pattern: p.pattern, name: p.name })
            : p.type === 'chords'
              ? await run('add_chord_progression', { track_id, start_bar: p.start_bar, chords: p.chords, beats_per_chord: p.beats_per_chord, octave: p.octave, style: p.style, velocity: p.velocity, name: p.name })
              : await run('add_region', { track_id, start_bar: p.start_bar, length_bars: p.length_bars, notes: p.notes, name: p.name });
        first ??= r.region_id as string;
      }
      firstRegion.push(first ?? '');
    }
    const sectionIds: string[] = [];
    for (const s of plan.sections ?? []) sectionIds.push(((await run('add_section', s)) as { section_id: string }).section_id);
    for (const l of plan.lyrics ?? []) if (sectionIds[l.section]) await run('set_lyrics', { section_id: sectionIds[l.section], text: l.text, language: l.language ?? 'en' });
    for (const n of plan.notes ?? []) {
      const target = 'section' in n.on ? { type: 'section', id: sectionIds[n.on.section] } : { type: 'region', id: firstRegion[n.on.track] };
      if (target.id) await run('annotate', { target, text: n.text });
    }
    if (plan.loop) await run('set_loop', { enabled: true, start_bar: plan.loop[0], end_bar: plan.loop[1] });
  } finally {
    useStore.getState().endTransaction(tx);
  }
}
