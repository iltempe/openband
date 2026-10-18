import { describe, expect, it } from 'vitest';
import { commands } from '../commands';
import { useStore } from '../store';
import { lint } from '../lint/engine';

describe('lyrics commands', () => {
  it('writes, aligns, checks and exports lyrics for a section', () => {
    commands.new_project({ name: 'Luna', bpm: 90, key: 'Am' });
    const voice = commands.add_track({ instrument: 'neon-lead', name: 'Voice' }) as { track_id: string };
    const keys = commands.add_track({ instrument: 'felt-piano', name: 'Keys' }) as { track_id: string };
    commands.add_chord_progression({ track_id: keys.track_id, chords: ['Am', 'F'], start_bar: 1 });
    // "la lu-na sa-le": "lu" on beat 3, "sa" on the next downbeat
    commands.add_region({ track_id: voice.track_id, start_bar: 1, length_bars: 2, notes: [{ pitch: 'A4', start: 1.5, duration: 0.5 }, { pitch: 'C5', start: 2, duration: 1 }, { pitch: 'B4', start: 3, duration: 0.5 }, { pitch: 'A4', start: 4, duration: 1 }, { pitch: 'G4', start: 5, duration: 2 }] });
    const sec = commands.add_section({ name: 'Verse', kind: 'verse', start_bar: 1, length_bars: 2 }) as { section_id: string };
    commands.set_lyrics({ section_id: sec.section_id, text: 'la luna sale', language: 'it' });
    expect(commands.check_prosody({})).toBeTruthy();
    const al = commands.align_lyrics({ melody_track_id: voice.track_id }) as { orphan_syllables: unknown[]; orphan_notes: number };
    expect(al).toMatchObject({ orphan_syllables: [], orphan_notes: 0 });
    const ly = commands.get_lyrics({}) as { lines: { syllables: { text: string; stressed: boolean; bar?: number }[]; aligned: boolean }[] };
    expect(ly.lines[0].aligned).toBe(true);
    expect(ly.lines[0].syllables.map((s) => `${s.text}${s.stressed ? '*' : ''}@${s.bar}`)).toEqual(['la@1.375', 'lu*@1.5', 'na@1.75', 'sa*@2', 'le@2.25']);
    // Rewriting the text re-aligns automatically.
    commands.set_lyrics({ section_id: sec.section_id, text: 'la luna sale piano' });
    expect((commands.check_prosody({}) as { issues: { code: string }[] }).issues.map((i) => i.code)).toContain('syllable_count');
    expect(lint(useStore.getState().project).issues.some((i) => i.rule === 'lyrics_prosody')).toBe(true);
    // Undo goes back to the aligned version.
    useStore.getState().undo();
    expect((commands.check_prosody({}) as { issues: unknown[] }).issues).toEqual([]);
    const sheet = commands.export_chord_sheet({ format: 'chordpro', return_data: true }) as { text: string };
    expect(sheet.text).toContain('{start_of_verse: Verse}');
    expect(sheet.text).toContain('[Am]');
    expect(sheet.text).toContain('luna');
  });
});
