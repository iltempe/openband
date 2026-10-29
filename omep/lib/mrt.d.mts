export function conditioningFor(beat: number, frames: number, bpm: number, control: { intensity?: number; chords?: string[] }): { notes: number[] | null; drums: -1 | 0 | 1 };
