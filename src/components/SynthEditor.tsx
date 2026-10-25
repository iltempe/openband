// The synth's own parameters (G5) under Smart Controls: envelopes, filter, FM, unison, by group, as knobs
// (log parameters turn on a log scale), a reset, and a sound described in words.
import { useState } from 'react';
import type { Track } from '../types';
import { useStore } from '../store';
import { useT, type MessageKey } from '../i18n';
import { changedParams, fromUnit, paramValue, synthSchema, toUnit, type ParamDef } from '../audio/synthParams';
import { runCommand } from '../commands';
import { Knob } from './Knob';
import { MatchSound } from './MatchSound';

const GROUPS: { id: ParamDef['group']; label: MessageKey }[] = [
  { id: 'amp', label: 'syn.amp' },
  { id: 'filter', label: 'syn.filter' },
  { id: 'fm', label: 'syn.fm' },
  { id: 'osc', label: 'syn.osc' },
  { id: 'level', label: 'syn.level' },
];

function show(d: ParamDef, v: number) {
  if (d.options) return d.options[Math.round(v)];
  if (d.unit === 's') return v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`;
  if (d.unit === 'Hz') return v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`;
  if (d.unit === 'dB') return `${v.toFixed(1)} dB`;
  if (d.unit === 'oct') return `${v.toFixed(1)} oct`;
  if (d.unit === 'cents') return `${Math.round(v)} ct`;
  return d.scale === 'int' ? String(Math.round(v)) : v.toFixed(2);
}

export function SynthEditor({ track }: { track: Track }) {
  const t = useT();
  const schema = synthSchema(track.instrument);
  const checkpoint = useStore((s) => s.checkpoint);
  const [words, setWords] = useState('');
  const [why, setWhy] = useState<string | null>(null);
  if (!schema) return null;
  const set = (id: string, v: number) =>
    useStore.getState().commit(
      (d) => {
        const x = d.tracks.find((y) => y.id === track.id)!;
        const next = changedParams(track.instrument, { ...x.synthParams, [id]: v });
        if (Object.keys(next).length) x.synthParams = next;
        else delete x.synthParams;
      },
      { history: false },
    );
  const describe = async () => {
    if (!words.trim()) return;
    try {
      const w = (await runCommand('sound_from_words', { description: words }, 'ui')) as { candidate_id: string; why: string[] };
      await runCommand('apply_patch', { candidate_id: w.candidate_id, track_id: track.id }, 'ui');
      setWhy(w.why.join(' · '));
    } catch (e) {
      setWhy((e as Error).message);
    }
  };
  return (
    <div className="synth-editor">
      <div className="inst-head">
        <span className="smart-kicker">{t('syn.title')}</span>
        {track.synthParams && (
          <button className="mini" onClick={() => void runCommand('set_synth_params', { track_id: track.id, reset: true }, 'ui')}>
            {t('syn.reset')}
          </button>
        )}
      </div>
      <div className="syn-groups">
        {GROUPS.map((g) => {
          const ps = schema.filter((d) => d.group === g.id);
          if (!ps.length) return null;
          return (
            <div key={g.id} className="syn-group">
              <div className="syn-label">{t(g.label)}</div>
              <div className="syn-knobs">
                {ps.map((d) => (
                  <Knob
                    key={d.id}
                    label={t(`syn.p.${d.id}` as MessageKey)}
                    value={toUnit(d, paramValue(d, track.synthParams))}
                    defaultValue={toUnit(d, d.default)}
                    onStart={checkpoint}
                    onChange={(u) => set(d.id, fromUnit(d, u))}
                    format={(u) => show(d, fromUnit(d, u))}
                    size={40}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="row syn-words">
        <input placeholder={t('syn.wordsHint')} value={words} onChange={(e) => setWords(e.target.value)} onKeyDown={(e) => (e.stopPropagation(), e.key === 'Enter' && void describe())} />
        <button className="btn" onClick={() => void describe()}>
          {t('syn.words')}
        </button>
      </div>
      {why && <div className="inst-note">{why}</div>}
      <MatchSound track={track} />
    </div>
  );
}
