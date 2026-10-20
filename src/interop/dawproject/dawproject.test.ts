import { describe, expect, it, beforeAll } from 'vitest';
import { mix, pointsOf } from '../../automation';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DOMParser } from '@xmldom/xmldom';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import { setDomParser } from './xml';
import { dawprojectToProject } from './import';
import { projectToDawproject, OPENBAND_JSON, type ExportSample } from './export';
import { reportLine } from './report';
import { useStore } from '../../store';
import { commands } from '../../commands';
import { canonicalJSON } from '../../versions/canonical';
import type { Project } from '../../types';

const FIX = path.join(__dirname, '..', '..', '__fixtures__', 'dawproject');
const SCHEMA = path.join(__dirname, 'schema', 'Project.xsd');
const load = (name: string) => new Uint8Array(fs.readFileSync(path.join(FIX, name)));
const codes = (r: { items: { code: string }[] }) => r.items.map((i) => i.code);

beforeAll(() => setDomParser(DOMParser as unknown as { new (): globalThis.DOMParser }));

describe('DAWproject import: Bitwig-style fixture', () => {
  it('imports tracks, notes, warped audio, markers and automation, and reports the rest', () => {
    const { project: p, samples, report } = dawprojectToProject(load('bitwig-5.dawproject'));
    expect(report.application).toBe('Bitwig Studio 5.0');
    expect(report.lossless).toBe(false);
    expect(p.bpm).toBe(149);
    expect(p.name).toBe('Bitwig demo');
    expect(p.tracks.map((t) => [t.name, t.kind])).toEqual([
      ['Bass', 'instrument'],
      ['Drumloop', 'audio'],
    ]);
    const [bass, loop] = p.tracks;
    expect(bass.instrument).toBe('sub-bass'); // Surge XT on a track called Bass → the closest preset
    expect(bass.volume).toBeCloseTo(0.65914 * 0.8, 3);
    expect(bass.color).toBe('#a2eabf');
    expect(loop.pan).toBeCloseTo(0.5, 3);
    const notes = p.regions.find((r) => r.trackId === bass.id)!;
    expect(notes.length).toBe(8);
    expect(notes.notes).toHaveLength(9);
    expect(notes.notes[0]).toMatchObject({ pitch: 65, start: 0, duration: 0.25 });
    expect(notes.notes[0].velocity).toBeCloseTo(0.787, 2);
    const audio = p.regions.find((r) => r.trackId === loop.id)!;
    expect(audio.audio).toMatchObject({ sampleId: 'dawp:0', offset: 0 });
    expect(samples).toHaveLength(1);
    expect(samples[0].name).toBe('Drumfunk3 170bpm.wav');
    expect(pointsOf(bass, mix('volume'))?.map((x) => x.beat)).toEqual([0, 8]);
    expect(pointsOf(bass, mix('volume'))![0].value).toBeCloseTo(0.16, 3);
    expect(p.sections?.map((s) => [s.name, s.start, s.length])).toEqual([
      ['Intro', 0, 4],
      ['Drop', 4, 4],
    ]);
    expect(p.sections![0].color).toBe('#ffcc00');
    // Not portable: the plugins, the stretched loop, the EQ+ automation, the scene.
    expect(codes(report)).toEqual(expect.arrayContaining(['instrument_replaced', 'plugin', 'warp', 'automation', 'clip_launcher']));
    expect(report.items.find((i) => i.code === 'plugin')!.detail).toContain('EQ+ (VST3)');
    expect(report.items.find((i) => i.code === 'warp')!.detail).toMatch(/×0\.88/);
    expect(reportLine(report.items.find((i) => i.code === 'instrument_replaced')!)).toMatch(/Surge XT \(CLAP\) → Sub Bass/);
  });
});

describe('DAWproject import: Studio One-style fixture', () => {
  it('converts seconds to beats, unrolls loops, maps EQ, compressor and sends, flattens folders', () => {
    const { project: p, samples, report } = dawprojectToProject(load('studio-one-6.dawproject'));
    expect(p.bpm).toBe(96);
    expect(p.tracks.map((t) => [t.name, t.kind])).toEqual([
      ['Drums', 'drums'],
      ['Electric Piano', 'instrument'],
      ['Vocal', 'audio'],
    ]);
    const [drums, keys, vox] = p.tracks;
    expect(drums.volume).toBeCloseTo(0.8 * Math.pow(10, -3 / 20), 3);
    expect(p.masterVolume).toBeCloseTo(0.8 * Math.pow(10, -1.5 / 20), 3);
    // 5 s at 96 BPM = 8 beats; the 2.5 s loop (4 beats) plays twice.
    const groove = p.regions.find((r) => r.trackId === drums.id)!;
    expect(groove.length).toBe(8);
    expect(groove.notes.map((n) => [n.pitch, n.start])).toEqual([
      [36, 0],
      [38, 1],
      [36, 2],
      [38, 3],
      [36, 4],
      [38, 5],
      [36, 6],
      [38, 7],
    ]);
    // playStart 0.625 s = 1 beat: the note before it is cut, the others shift.
    const chords = p.regions.find((r) => r.trackId === keys.id)!;
    expect(chords.start).toBe(4);
    expect(chords.notes.map((n) => [n.pitch, n.start])).toEqual([
      [64, 0],
      [67, 0],
      [69, 2],
    ]);
    expect(keys).toMatchObject({ instrument: 'velvet-keys', solo: true });
    expect(keys.pan).toBeCloseTo(-0.4, 3);
    expect(keys.fx?.eq).toMatchObject({ on: true, low: -4, mid: 2.5, midFreq: 1800 });
    expect(keys.fx?.comp).toMatchObject({ on: true, threshold: -20, ratio: 3, attack: 0.02, release: 0.25 });
    expect(keys.reverb).toBeCloseTo(Math.pow(10, -6 / 20), 3);
    expect(keys.delay).toBeCloseTo(Math.pow(10, -18 / 20), 3);
    expect(drums.reverb).toBeCloseTo(Math.pow(10, -12 / 20), 3);
    expect(pointsOf(keys, mix('pan'))).toEqual([
      { beat: 4, value: -1 },
      { beat: 8, value: 1 },
    ]);
    expect(vox).toMatchObject({ mute: true });
    const take = p.regions.find((r) => r.trackId === vox.id)!;
    expect(take.audio?.offset).toBeCloseTo(0.5, 3);
    expect(take.start).toBe(2);
    expect(samples.map((s) => s.name)).toEqual(['lead vocal.wav']);
    expect(p.sections?.map((s) => [s.name, s.start])).toEqual([
      ['Verse', 0],
      ['Chorus', 4],
    ]);
    const c = codes(report);
    expect(c).toEqual(expect.arrayContaining(['group', 'tempo_changes', 'instrument_replaced', 'plugin', 'send', 'audio_missing', 'fade']));
    expect(report.items.find((i) => i.code === 'group')!.detail).toBe('Rhythm Section');
    expect(report.items.filter((i) => i.code === 'plugin').map((i) => i.detail).join(' | ')).toMatch(/highPass.*VintageVerb|VintageVerb.*highPass/);
    expect(report.items.find((i) => i.code === 'tempo_changes')!.detail).toMatch(/96–104/);
  });
});

function richProject(): { p: Project; samples: Record<string, ExportSample> } {
  commands.new_project({ name: 'Round trip', bpm: 92, key: 'Dm' });
  useStore.setState({ past: [], future: [] });
  const d = commands.add_track({ kind: 'drums', name: 'Beat' }) as unknown as { track_id: string };
  const k = commands.add_track({ kind: 'instrument', name: 'Rhodes', instrument: 'velvet-keys' }) as unknown as { track_id: string };
  const a = commands.add_track({ kind: 'audio', name: 'Vox' }) as unknown as { track_id: string };
  commands.add_drum_pattern({ track_id: d.track_id, start_bar: 1, bars: 2, pattern: { kick: 'x...x...x...x...', snare: '....x.......x...' } });
  const r = commands.add_region({ track_id: k.track_id, start_bar: 2, length_bars: 2, notes: [{ pitch: 'D4', start: 0, duration: 2, velocity: 0.6 }, { pitch: 'F4', start: 2, duration: 1.5 }] }) as { region_id: string };
  commands.add_take({ region_id: r.region_id, notes: [{ pitch: 'A4', start: 0, duration: 4 }], activate: false });
  commands.update_track({ track_id: k.track_id, volume: 0.6, pan: -0.25, reverb: 0.4, delay: 0.1, mute: true });
  commands.set_track_effects({ track_id: k.track_id, eq: { on: true, low: 3, mid: -2, high: 1.5, mid_freq: 1500 }, compressor: { on: true, threshold: -22, ratio: 3, attack: 0.02, release: 0.2, makeup: 2 } });
  commands.set_automation({ track_id: k.track_id, param: 'volume', points: [{ bar: 2, value: 0.3 }, { bar: 4, value: 0.7 }] });
  commands.set_automation({ track_id: k.track_id, param: 'pan', points: [{ bar: 2, value: -1 }, { bar: 3, value: 1 }] });
  commands.add_section({ name: 'Verse', kind: 'verse', start_bar: 1, length_bars: 2 });
  commands.add_section({ name: 'Chorus', kind: 'chorus', start_bar: 3, length_bars: 2 });
  commands.set_lyrics({ text: 'round and round we go' });
  const sampleId = 'smp_vox';
  useStore.getState().commit((x) => void x.regions.push({ id: 'rgn_vox', trackId: a.track_id, name: 'Take', start: 4, length: 4, notes: [], audio: { sampleId, offset: 0.25, gain: 1 } }));
  return { p: structuredClone(useStore.getState().project), samples: { [sampleId]: { name: 'vox take.wav', data: new Uint8Array([82, 73, 70, 70, 0, 0]), channels: 1, sampleRate: 44100, duration: 3 } } };
}

describe('DAWproject export and round trip', () => {
  it('OpenBand → DAWproject → OpenBand is exact', () => {
    const { p, samples } = richProject();
    const { zip, report } = projectToDawproject(p, samples);
    expect(report.map((r) => r.detail)).toEqual(expect.arrayContaining(['lyrics', 'alternative takes (the active one is exported)']));
    const back = dawprojectToProject(zip);
    expect(back.report.lossless).toBe(true);
    expect(canonicalJSON(back.project, { includeMeta: true })).toBe(canonicalJSON(p, { includeMeta: true }));
    expect(back.samples.map((s) => [s.ref, s.name, s.data.length])).toEqual([['smp_vox', 'vox take.wav', 6]]);
  });

  it('read back without openband.json (as another DAW would see it): the portable parts survive', () => {
    const { p, samples } = richProject();
    const files = unzipSync(projectToDawproject(p, samples).zip);
    delete files[OPENBAND_JSON];
    const { project: q, report } = dawprojectToProject(zipSync(files));
    expect(report.lossless).toBe(false);
    expect(report.items.filter((i) => i.code !== 'export_skipped')).toEqual([]); // nothing foreign to report
    expect(q.bpm).toBe(92);
    expect(q.tracks.map((t) => [t.name, t.kind])).toEqual(p.tracks.map((t) => [t.name, t.kind]));
    const k = q.tracks.find((t) => t.name === 'Rhodes')!;
    const k0 = p.tracks.find((t) => t.name === 'Rhodes')!;
    expect(k).toMatchObject({ mute: true, instrument: 'velvet-keys' });
    expect(k.volume).toBeCloseTo(k0.volume, 3);
    expect(k.pan).toBeCloseTo(k0.pan, 3);
    expect(k.reverb).toBeCloseTo(k0.reverb, 3);
    expect(k.delay).toBeCloseTo(k0.delay, 3);
    expect(k.fx?.eq).toMatchObject({ on: true, low: 3, mid: -2, high: 1.5, midFreq: 1500 });
    expect(k.fx?.comp).toMatchObject({ on: true, threshold: -22, ratio: 3, makeup: 2 });
    expect(pointsOf(k, mix('volume'))?.map((x) => [x.beat, +x.value.toFixed(3)])).toEqual(pointsOf(k0, mix('volume'))!.map((x) => [x.beat, +x.value.toFixed(3)]));
    expect(pointsOf(k, mix('pan'))).toEqual(pointsOf(k0, mix('pan'))!);
    const notesOf = (pr: Project, name: string) => pr.regions.filter((r) => r.trackId === pr.tracks.find((t) => t.name === name)!.id).flatMap((r) => r.notes.map((n) => [r.start + n.start, n.pitch, n.duration, +n.velocity.toFixed(2)])).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const name of ['Beat', 'Rhodes']) expect(notesOf(q, name)).toEqual(notesOf(p, name));
    expect(q.sections?.map((s) => [s.name, s.start, s.length])).toEqual(p.sections!.map((s) => [s.name, s.start, s.length]));
    const vox = q.regions.find((r) => r.audio)!;
    expect(vox).toMatchObject({ start: 4, length: 4 });
    expect(vox.audio!.offset).toBeCloseTo(0.25, 3);
  });

  it('the exported project.xml is valid against the official XSD', () => {
    const { p, samples } = richProject();
    const xml = strFromU8(unzipSync(projectToDawproject(p, samples).zip)['project.xml']);
    let hasXmllint = true;
    try {
      execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
    } catch {
      hasXmllint = false;
    }
    if (hasXmllint) {
      const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ob-dawp-')), 'project.xml');
      fs.writeFileSync(f, xml);
      const out = execFileSync('xmllint', ['--noout', '--schema', SCHEMA, f], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      expect(out).toBe('');
    } else {
      // Structural check: the elements and order the schema requires.
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      const root = doc.documentElement!;
      expect(root.tagName).toBe('Project');
      expect(root.getAttribute('version')).toBe('1.0');
      const order = Array.from(root.childNodes).filter((n) => n.nodeType === 1).map((n) => (n as Element).tagName);
      expect(order).toEqual(['Application', 'Transport', 'Structure', 'Arrangement', 'Scenes']);
    }
  });
});
