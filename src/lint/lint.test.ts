import { describe, expect, it } from 'vitest';
import { lint } from './engine';
import { demoV1Raw, dirtyProjectFixture } from '../__fixtures__/projects';
import { migrate } from '../migrations';
import { commands } from '../commands';
import { useStore } from '../store';

const summary = (issues: { rule: string; target: object }[]) => issues.map((i) => [i.rule, i.target]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

describe('linter', () => {
  it('finds exactly the problems planted in the dirty fixture', () => {
    const { issues, counts } = lint(dirtyProjectFixture());
    expect(issues.map((i) => i.rule).sort()).toEqual(
      ['bass_panned', 'empty_track', 'low_end_clash', 'notes_outside_region', 'out_of_key', 'overlapping_notes', 'overlapping_regions', 'robotic_velocity'].sort(),
    );
    const byRule = Object.fromEntries(issues.map((i) => [i.rule, i]));
    expect(byRule.out_of_key.target.note_ids).toEqual(['k_fsharp']); // the short G# passing note is tolerated
    expect(byRule.overlapping_notes.target.note_ids).toEqual(['k3', 'k_overlap']);
    expect(byRule.notes_outside_region.target.note_ids).toEqual(['k_outside']);
    expect(byRule.low_end_clash.target.track_id).toBe('t_sub'); // the real bass stays down
    expect(byRule.bass_panned.target.track_id).toBe('t_bass');
    expect(byRule.empty_track.target.track_id).toBe('t_empty');
    expect(counts).toEqual({ error: 0, warn: 6, info: 2 });
    expect(summary(issues)).toMatchSnapshot();
  });

  it('flags melodic parts locked to the grid, but not patterns or arpeggios', async () => {
    const { track, region, note } = await import('../__fixtures__/projects');
    const p = dirtyProjectFixture();
    const melody = [1, 0.5, 0.25, 1, 0.5, 0.25, 1, 0.5].map((d, i) => note(60 + (i % 5), i, d));
    p.tracks.push(track('t_lead', { name: 'Lead' }));
    p.regions.push(region('r_lead', 't_lead', 32, 8, melody), region('r_arp', 't_lead', 40, 8, melody.map((n) => ({ ...n, id: n.id + 'a' })), { name: 'Arpeggio' }));
    const timing = lint(p).issues.filter((i) => i.rule === 'robotic_timing');
    expect(timing.map((i) => i.target.region_id)).toEqual(['r_lead']);
  });

  it('gives issues stable ids across runs', () => {
    const a = lint(dirtyProjectFixture()).issues.map((i) => i.id);
    const b = lint(dirtyProjectFixture()).issues.map((i) => i.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });

  it('applies the project lint settings', () => {
    const p = dirtyProjectFixture();
    const first = lint(p).issues.find((i) => i.rule === 'empty_track')!;
    p.lint = { disabled: ['robotic_timing'], severity: { out_of_key: 'error' }, ignored: [first.id] };
    const { issues, counts } = lint(p);
    expect(issues.some((i) => i.rule === 'robotic_timing')).toBe(false);
    expect(issues.some((i) => i.id === first.id)).toBe(false);
    expect(issues.find((i) => i.rule === 'out_of_key')!.severity).toBe('error');
    expect(counts.error).toBe(1);
    expect(lint(p, { minSeverity: 'warn' }).issues.every((i) => i.severity !== 'info')).toBe(true);
  });

  it('every automatic fix resolves its issue, in one undo step', async () => {
    commands.import_project_json({ project: dirtyProjectFixture() });
    const fixable = lint(useStore.getState().project).issues.filter((i) => i.fix);
    expect(fixable.length).toBeGreaterThanOrEqual(7);
    for (const issue of fixable) {
      const before = useStore.getState().past.length;
      await commands.apply_fix({ issue_id: issue.id });
      expect(useStore.getState().past.length).toBe(before + 1);
      expect(lint(useStore.getState().project).issues.map((i) => i.id)).not.toContain(issue.id);
    }
  });

  it('ignore_issue hides an issue', () => {
    commands.import_project_json({ project: dirtyProjectFixture() });
    const issue = lint(useStore.getState().project).issues[0];
    commands.ignore_issue({ issue_id: issue.id });
    expect(lint(useStore.getState().project).issues.map((i) => i.id)).not.toContain(issue.id);
  });

  it('the demo song has no errors', () => {
    expect(lint(migrate(demoV1Raw)).counts.error).toBe(0);
  });
});
