// Freezing the tracks that play native plugins (G8.4): each one rendered on its own — with its plugins,
// in their offline mode, before its fader — and kept as a sample of the song. Only in the desktop app
// (where the plugins run), and only the tracks that changed since their last freeze.
import { useStore } from './store';
import { renderBuffer, encodePcm } from './audio/render';
import { importSample, getStoredSample } from './audio/samples';
import { desktopNative } from './audio/native';
import { freezeView, nativePluginsOf, trackHash } from './audio/freeze';

const SR = 48000;

export async function freezeNativeTracks(o: { force?: boolean } = {}) {
  if (!desktopNative()) return { frozen: [] as string[], unchanged: [] as string[], note: 'Native plugins are frozen in the desktop app' };
  const p = useStore.getState().project;
  const frozen: string[] = [];
  const unchanged: string[] = [];
  const updates = new Map<string, NonNullable<(typeof p.tracks)[number]['frozen']>>();
  for (const t of p.tracks) {
    const plugins = nativePluginsOf(p, t);
    if (!plugins.length) continue;
    const hash = trackHash(p, t);
    if (!o.force && t.frozen?.hash === hash && getStoredSample(t.frozen.sampleId)) {
      unchanged.push(t.name);
      continue;
    }
    const buf = await renderBuffer(freezeView(p, t.id), { tracks: [t.id], tap: t.id, includeMaster: false, sampleRate: SR, tailSeconds: 2 });
    const chans = [buf.getChannelData(0), buf.getChannelData(Math.min(1, buf.numberOfChannels - 1))];
    const wav = encodePcm(chans, SR, 16);
    const info = await importSample(wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer, `${t.name} (frozen)`, 'audio/wav');
    updates.set(t.id, { sampleId: info.id, hash, plugins, seconds: +(buf.length / SR).toFixed(2) });
    frozen.push(t.name);
  }
  if (updates.size)
    useStore.getState().commit((d) => {
      for (const t of d.tracks) if (updates.has(t.id)) t.frozen = updates.get(t.id);
    }, { history: false });
  return { frozen, unchanged };
}
