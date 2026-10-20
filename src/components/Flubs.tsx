// "To fix" panel (F18): the marks left while recording, with a jump to each one (2-bar loop),
// the best-take fix, and the MIDI pedal setting. Flags on the ruler come from here too.
import { useState } from 'react';
import { useStore } from '../store';
import { commands } from '../commands';
import { BEATS_PER_BAR } from '../music';
import { takeOf } from '../flubs';
import { goToFlub, learnPedal, useFlubLive, usePedal } from '../flubLive';
import { useT } from '../i18n';
import type { Region } from '../types';
import * as I from './Icons';

const barBeat = (beat: number) => `${Math.floor(beat / BEATS_PER_BAR) + 1}.${Math.floor(beat % BEATS_PER_BAR) + 1}`;

/** Red (mistake), green (good) and grey (note) flags on the ruler; marks of the take being recorded too. */
export function RulerFlags({ zoom }: { zoom: number }) {
  const flubs = useStore((s) => s.project.flubs);
  const pending = useFlubLive((s) => s.pending);
  const t = useT();
  const all = [...(flubs ?? []).filter((f) => !f.resolved), ...pending.map((p) => p.flub)];
  if (!all.length) return null;
  return (
    <>
      {all.map((f) => (
        <button
          key={f.id}
          className={`ruler-flag ${f.kind}`}
          style={{ left: f.beat * zoom }}
          title={`${t(`fl.kind.${f.kind}`)} · ${barBeat(f.beat)}${f.text ? ` — ${f.text}` : ''}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => {
            goToFlub(f);
            useStore.getState().set({ bottom: 'flubs' });
          }}
        >
          <I.Flag width={11} height={11} />
        </button>
      ))}
    </>
  );
}

/** Flags inside a region for the marks on the take that is playing. */
export function RegionFlags({ region, zoom }: { region: Region; zoom: number }) {
  const flubs = useStore((s) => s.project.flubs);
  const active = region.activeTakeId ?? region.takes?.[0]?.id;
  const mine = (flubs ?? []).filter((f) => f.regionId === region.id && !f.resolved && (!region.takes?.length || takeOf(f, region) === active));
  if (!mine.length) return null;
  return (
    <>
      {mine.map((f) => (
        <span key={f.id} className={`region-flag ${f.kind}`} style={{ left: (f.beat - region.start) * zoom }} />
      ))}
    </>
  );
}

export function FlubsPanel() {
  const t = useT();
  const p = useStore((s) => s.project);
  const notify = useStore((s) => s.notify);
  const pedal = usePedal();
  const [showResolved, setShowResolved] = useState(false);
  const flubs = [...(p.flubs ?? [])].filter((f) => showResolved || !f.resolved).sort((a, b) => a.beat - b.beat);
  const run = (fn: () => unknown) => {
    try {
      return fn();
    } catch (e) {
      notify((e as Error).message);
    }
  };
  return (
    <div className="flubs-panel">
      <div className="fl-head">
        <span className="fl-hint">{t('fl.hint')}</span>
        <label className="fl-check">
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> {t('fl.showResolved')}
        </label>
        <div className="eb-spacer" />
        <span className="fl-pedal">{pedal.learning ? t('fl.learning') : t('fl.pedal', { cc: pedal.cc })}</span>
        <button className="mini" onClick={learnPedal} disabled={pedal.learning}>
          {t('fl.learn')}
        </button>
      </div>
      {!flubs.length ? (
        <div className="fl-empty">{t('fl.empty')}</div>
      ) : (
        <ul className="fl-list">
          {flubs.map((f) => {
            const r = f.regionId ? p.regions.find((x) => x.id === f.regionId) : undefined;
            const track = p.tracks.find((x) => x.id === f.trackId);
            const take = r?.takes?.find((x) => x.id === (f.takeId ?? r.takes?.[0]?.id));
            return (
              <li key={f.id} className={`fl-row ${f.kind} ${f.resolved ? 'resolved' : ''}`}>
                <I.Flag width={13} height={13} className="fl-icon" />
                <button className="fl-pos" onClick={() => goToFlub(f)} title={t('fl.go')}>
                  {barBeat(f.beat)}
                </button>
                <span className="fl-what">
                  {t(`fl.kind.${f.kind}`)}
                  {track && <> · {track.name}</>}
                  {take && <> · {take.name}</>}
                  {f.text && <> — {f.text}</>}
                </span>
                <div className="eb-spacer" />
                {f.kind === 'flub' && !f.resolved && (r?.takes?.length ?? 0) > 1 && (
                  <button
                    className="mini"
                    title={t('fl.bestTitle')}
                    onClick={() =>
                      run(() => {
                        const res = commands.replace_with_best_take({ flub_id: f.id }) as { from_take?: string; take?: string };
                        notify(t('fl.fixed', { take: res.from_take ?? res.take ?? '' }));
                      })
                    }
                  >
                    {t('fl.best')}
                  </button>
                )}
                <button className="mini" onClick={() => run(() => commands.resolve_flub({ flub_id: f.id, resolved: !f.resolved }))}>
                  {f.resolved ? t('fl.reopen') : t('fl.resolve')}
                </button>
                <button className="mini" onClick={() => run(() => commands.delete_flub({ flub_id: f.id }))} title={t('fl.delete')}>
                  <I.Close width={12} height={12} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
