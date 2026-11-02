// A finished rehearsal becomes part of a song (R2.5), on the server and without a browser: a sample per
// channel, one audio track per channel, a region and a section per song, a version on the branch `prove`.
// The main branch stays what the band arranges. emptyProject and audioTrack mirror src/store.ts (test: project.test.ts).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { SAMPLE_RATE, stitchChannel } from './capture.mjs';

const AUDIO_COLOR = '#e879f9';
const BRANCH = 'prove';
const uid = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;

export function emptyProject(name, bpm = 110) {
  const now = Date.now();
  return { version: 3, name, bpm, key: 'Am', tracks: [], regions: [], loop: { enabled: false, start: 0, end: 16 }, masterVolume: 0.8, metronome: false, meta: { projectId: uid('song'), createdAt: now, updatedAt: now } };
}

export function audioTrack(name) {
  return { id: uid('trk'), name, kind: 'audio', instrument: 'audio', color: AUDIO_COLOR, volume: 0.8, pan: 0, mute: false, solo: false, reverb: 0.05, delay: 0, cutoff: 1 };
}

const sampleId = (data) => `smp_${crypto.createHash('sha256').update(data).digest('hex').slice(0, 16)}`;
const label = (t) => {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `Prova ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** The state a new rehearsal builds on: the head of `prove`, else the song as it is. */
function baseOf(store, id) {
  const ref = store.branches(id).find((b) => b.name === BRANCH);
  const v = ref && store.getVersion(id, ref.headId);
  if (v) return { project: JSON.parse(gunzipSync(v.snapshot).toString()), parent: v.id };
  const main = store.branches(id).find((b) => b.name === 'main');
  return { project: store.getProject(id)?.value, parent: main?.headId };
}

/** Songs between the cuts, as [start, end] in frames. */
export function songsOf(endFrame, cuts = []) {
  const edges = [0, ...cuts.filter((c) => c > 0 && c < endFrame), endFrame];
  return edges.slice(0, -1).map((start, i) => [start, edges[i + 1]]);
}

/**
 * @param {{ store: any, dir: string, info: { id: string, channels: number, startedAt: number, endFrame: number, cuts?: number[], marks?: number[] }, names?: string[], projectId?: string, projectName?: string, emit?: (e: any) => void, now?: () => number }} o
 * @returns the version, or the existing one when this session was imported before
 */
export function importSession({ store, dir, info, names = [], projectId, projectName = 'Sala prove', emit = () => {}, now = () => Date.now() }) {
  let main = projectId ? store.getProject(projectId) : null;
  if (!main) {
    const fresh = emptyProject(projectName);
    if (projectId) fresh.meta.projectId = projectId;
    store.putProject(fresh.meta.projectId, fresh);
    main = store.getProject(fresh.meta.projectId);
  }
  const id = main.value.meta.projectId;
  const { project: base, parent } = baseOf(store, id);
  const project = structuredClone(base);
  const known = project.rehearsals?.find((r) => r.id === info.id);
  if (known) return { projectId: id, versionId: known.versionId, already: true };

  const secondsToBeats = (s) => (s * project.bpm) / 60;
  const songs = songsOf(info.endFrame, info.cuts);
  // A new rehearsal goes after everything there is, with a bar of air.
  const start = Math.ceil(Math.max(0, ...project.regions.map((r) => r.start + r.length)) / 4) * 4 + (project.regions.length ? 4 : 0);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openband-import-'));
  const trackIds = [];
  try {
    for (let c = 1; c <= info.channels; c++) {
      const file = path.join(tmp, `ch${c}.wav`);
      stitchChannel(dir, c, file, info.endFrame);
      const data = fs.readFileSync(file);
      const sid = sampleId(data);
      const name = names[c - 1] || `Canale ${c}`;
      store.putSample(sid, data, `${info.id} ${name}.wav`, 'audio/wav');
      const track = audioTrack(name);
      project.tracks.push(track);
      trackIds.push(track.id);
      for (const [i, [a, b]] of songs.entries())
        project.regions.push({ id: uid('rgn'), trackId: track.id, name: `Brano ${i + 1}`, start: start + secondsToBeats(a / SAMPLE_RATE), length: secondsToBeats((b - a) / SAMPLE_RATE), notes: [], audio: { sampleId: sid, offset: a / SAMPLE_RATE, gain: 1 } });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const sections = songs.map(([a, b], i) => ({ id: uid('sec'), name: `Brano ${i + 1}`, kind: 'custom', start: start + secondsToBeats(a / SAMPLE_RATE), length: secondsToBeats((b - a) / SAMPLE_RATE) }));
  project.sections = [...(project.sections ?? []), ...sections];
  project.flubs = [...(project.flubs ?? []), ...(info.marks ?? []).map((f) => ({ id: uid('flb'), beat: start + secondsToBeats(f / SAMPLE_RATE), trackId: trackIds[0], kind: 'flub', createdAt: now(), text: 'MARK' }))];
  const versionId = uid('ver');
  project.rehearsals = [...(project.rehearsals ?? []), { id: info.id, at: info.startedAt, label: label(info.startedAt), versionId, sections: sections.map((s) => s.id), trackIds, ...(info.recovered ? { recovered: true } : {}) }];
  const version = { id: versionId, projectId: id, parentIds: parent ? [parent] : [], branch: BRANCH, label: label(info.startedAt), createdAt: now(), author: 'user', snapshot: new Uint8Array(gzipSync(JSON.stringify(project))) };
  store.putVersion(id, version);
  store.putBranch(id, { id: `${id}:${BRANCH}`, projectId: id, name: BRANCH, headId: versionId, at: now() });
  store.setBox(id, { sessions: project.rehearsals.length });
  const event = { kind: 'box_session', id, session: info.id, version: versionId, songs: songs.length };
  emit(event);
  return { projectId: id, versionId, songs: songs.length, tracks: info.channels };
}
