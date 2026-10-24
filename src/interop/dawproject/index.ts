// DAWproject in the app: import (replacing the song or adding its tracks), export with the audio, and the
// "What wasn't imported" report.
import { create } from 'zustand';
import type { Project } from '../../types';
import { useStore } from '../../store';
import { ensureSamples, getStoredSample, importSample, useSamples } from '../../audio/samples';
import { captureWamStates, nativePlugins } from '../../plugins';
import { autoVersion } from '../../versioning';
import { exportName } from '../../journal';
import { download } from '../../audio/render';
import { dawprojectToProject } from './import';
import { projectToDawproject, type ExportSample } from './export';
import { reportLine, type ImportReport, type ReportItem } from './report';

export { dawprojectToProject, projectToDawproject };

declare const __APP_VERSION__: string;
const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
const st = () => useStore.getState();

/** The report of the last import or export, shown by the dialog (null = closed). */
export const useDawReport = create<{ open: boolean; kind: 'import' | 'export'; items: ReportItem[]; application: string | null; lossless: boolean; file: string }>(() => ({ open: false, kind: 'import', items: [], application: null, lossless: false, file: '' }));

const typeOf = (name: string) => (/\.mp3$/i.test(name) ? 'audio/mpeg' : /\.ogg$/i.test(name) ? 'audio/ogg' : /\.flac$/i.test(name) ? 'audio/flac' : /\.aiff?$/i.test(name) ? 'audio/aiff' : 'audio/wav');

/** Import a .dawproject: replace the song (default; a version of the old one is saved first) or add its tracks. */
export async function importDawproject(bytes: Uint8Array, filename: string, replace = true, author: 'user' | 'ai' = 'user', showReport = false) {
  // In the desktop app, VST3 / CLAP / AU devices installed on this computer load with their state (G8.9).
  const installed = (await nativePlugins().catch(() => ({ plugins: [] }))).plugins;
  const { project, samples, report } = dawprojectToProject(bytes, installed);
  // Store the audio files and point the regions at them.
  const ids = new Map<string, string>();
  for (const s of samples) {
    try {
      const info = await importSample(s.data.slice().buffer, s.name, typeOf(s.name));
      ids.set(s.ref, info.id);
    } catch (e) {
      report.items.push({ code: 'audio_missing', detail: `${s.name}: ${(e as Error).message}` });
    }
  }
  for (const r of project.regions) if (r.audio) r.audio.sampleId = ids.get(r.audio.sampleId) ?? r.audio.sampleId;
  if (replace) {
    void autoVersion('import DAWproject', st().project, author);
    st().loadProject(project);
  } else {
    if (project.bpm !== st().project.bpm) report.items.push({ code: 'tempo_changes', detail: `the file is at ${project.bpm} BPM, the song stays at ${st().project.bpm}` });
    add(project);
  }
  useDawReport.setState({ open: showReport && (report.items.length > 0 || !replace), kind: 'import', items: report.items, application: report.application, lossless: report.lossless, file: filename });
  return { tracks: project.tracks.map((t) => ({ track_id: t.id, name: t.name, kind: t.kind, instrument: t.instrument })), regions: project.regions.length, sections: project.sections?.length ?? 0, from: report.application, lossless: report.lossless, report: report.items.map(reportLine) };
}

/** Add an imported song's tracks (and what they need) to the open one, as one step. */
function add(p: Project) {
  st().commit((d) => {
    d.tracks.push(...p.tracks);
    d.regions.push(...p.regions);
    if (p.instruments?.length) d.instruments = [...(d.instruments ?? []), ...p.instruments.filter((i) => !d.instruments?.some((x) => x.id === i.id))];
    if (p.sections?.length && !d.sections?.length) d.sections = p.sections;
  }, { label: 'Import DAWproject' });
}

/** The song as a .dawproject with its audio; downloaded or returned as data. */
export async function exportDawproject(returnData = false) {
  await captureWamStates();
  const p = st().project;
  const ids = [...new Set(p.regions.flatMap((r) => (r.audio ? [r.audio.sampleId] : [])))];
  await ensureSamples(ids);
  const samples: Record<string, ExportSample> = {};
  for (const id of ids) {
    const raw = getStoredSample(id);
    const info = useSamples.getState().info[id];
    if (raw && info) samples[id] = { name: raw.name, data: new Uint8Array(raw.data), channels: info.channels, sampleRate: info.sampleRate, duration: info.duration };
  }
  const { zip, report } = projectToDawproject(p, samples, { name: 'OpenBand', version: APP_VERSION });
  const safe = p.name.replace(/[^\w\- ]+/g, '').trim() || 'openband';
  const filename = returnData ? `${safe}.dawproject` : exportName(safe, '.dawproject');
  if (returnData) {
    let bin = '';
    for (let i = 0; i < zip.length; i += 0x8000) bin += String.fromCharCode(...zip.subarray(i, i + 0x8000));
    return { filename, bytes: zip.length, data_base64: btoa(bin), report: report.map(reportLine) };
  }
  download(new Blob([zip], { type: 'application/x-dawproject' }), filename);
  return { exported: true, filename, bytes: zip.length, report: report.map(reportLine), note: 'The .dawproject file was downloaded by the browser.' };
}

export type { ImportReport };
