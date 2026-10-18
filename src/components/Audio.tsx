// Audio clips: waveform drawing and the clip editor shown in the bottom dock.
import { useEffect, useRef, type CSSProperties } from 'react';
import type { Region, Track } from '../types';
import { useStore } from '../store';
import { BEATS_PER_BAR } from '../music';
import { getPeaks, useSamples } from '../audio/samples';
import { commands } from '../commands';
import { useT } from '../i18n';
import * as I from './Icons';

/** Draws the part [offset, offset + seconds] of a sample, filling the element's size. */
export function Waveform({ sampleId, offset, seconds, gain = 1, className }: { sampleId: string; offset: number; seconds: number; gain?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const loaded = useSamples((s) => !!s.info[sampleId]);
  const missing = useSamples((s) => !!s.missing[sampleId]);
  const t = useT();

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !loaded) return;
    const draw = () => {
      const data = getPeaks(sampleId);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!data || !w || !h) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const g = canvas.getContext('2d')!;
      g.scale(dpr, dpr);
      g.clearRect(0, 0, w, h);
      g.fillStyle = getComputedStyle(canvas).color;
      const { peaks, secondsPerPeak } = data;
      const mid = h / 2;
      for (let x = 0; x < w; x++) {
        const a = Math.floor((offset + (x / w) * seconds) / secondsPerPeak);
        const b = Math.max(a + 1, Math.floor((offset + ((x + 1) / w) * seconds) / secondsPerPeak));
        if (a >= peaks.length) break;
        let m = 0;
        for (let i = a; i < b && i < peaks.length; i++) if (peaks[i] > m) m = peaks[i];
        const amp = Math.min(1, m * gain) * (mid - 1);
        g.fillRect(x, mid - amp, 1, Math.max(1, amp * 2));
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [sampleId, offset, seconds, gain, loaded]);

  if (missing) return <div className={`wave-missing ${className ?? ''}`}>{t('audio.missing')}</div>;
  return <canvas ref={ref} className={`waveform ${className ?? ''}`} />;
}

export function AudioClipEditor({ region, track }: { region: Region; track: Track }) {
  const clip = region.audio!;
  const bpm = useStore((s) => s.project.bpm);
  const commit = useStore((s) => s.commit);
  const checkpoint = useStore((s) => s.checkpoint);
  const info = useSamples((s) => s.info[clip.sampleId]);
  const t = useT();
  const seconds = (region.length * 60) / bpm;
  const update = (fn: (r: Region) => void, history = false) => commit((d) => fn(d.regions.find((r) => r.id === region.id)!), { history });
  const remaining = info ? Math.max(0, info.duration - clip.offset) : 0;

  return (
    <div className="editor audio-editor" style={{ '--track': track.color } as CSSProperties}>
      <div className="editor-bar">
        <div className="eb-title">
          <span className="eb-dot" />
          <input
            key={region.id}
            className="eb-name"
            defaultValue={region.name}
            onBlur={(e) => update((r) => void (r.name = e.target.value || r.name), true)}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          <span className="eb-sub">{info ? `${info.name} · ${info.duration.toFixed(2)} s` : track.name}</span>
        </div>
        <div className="eb-group">
          <label>{t('audio.gain')}</label>
          <input
            type="range"
            min={0}
            max={2}
            step={0.01}
            value={clip.gain}
            onPointerDown={checkpoint}
            onChange={(e) => update((r) => void (r.audio!.gain = Number(e.target.value)))}
          />
          <span className="eb-val">{clip.gain > 0 ? `${(20 * Math.log10(clip.gain)).toFixed(1)} dB` : '−∞'}</span>
        </div>
        <div className="eb-group">
          <label>{t('audio.start')}</label>
          <input
            type="range"
            min={0}
            max={info ? Math.max(0, info.duration - 0.05) : 0}
            step={0.001}
            value={clip.offset}
            onPointerDown={checkpoint}
            onChange={(e) => update((r) => void (r.audio!.offset = Number(e.target.value)))}
          />
          <span className="eb-val">{clip.offset.toFixed(2)} s</span>
        </div>
        <button className="mini" disabled={!info} onClick={() => update((r) => void (r.length = Math.max(0.25, (remaining * bpm) / 60)), true)} title={t('audio.fitHint')}>
          {t('audio.fit')}
        </button>
        <div className="eb-spacer" />
        <button className="mini" onClick={() => commands.duplicate_region({ region_id: region.id })} title={t('ed.duplicateHint')}>
          <I.Copy width={14} height={14} /> {t('ed.duplicate')}
        </button>
        <button className="mini danger" onClick={() => commands.delete_region({ region_id: region.id })} title={t('ed.deleteRegion')}>
          <I.Trash width={14} height={14} />
        </button>
      </div>
      <div className="audio-editor-body">
        <Waveform sampleId={clip.sampleId} offset={clip.offset} seconds={seconds} gain={clip.gain} className="big" />
        <div className="audio-editor-info">
          {t('audio.clipInfo', { bars: (region.length / BEATS_PER_BAR).toFixed(2), seconds: seconds.toFixed(2), bpm: Math.round(bpm) })}
        </div>
      </div>
    </div>
  );
}
