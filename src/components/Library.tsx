import { useState } from 'react';
import { getTrack, useStore } from '../store';
import { LoopBrowser } from './Loops';
import { useConfig } from '../config';
import { PRESETS, findInstrument, type InstrumentPreset } from '../audio/instruments';
import { commands } from '../commands';
import { engine } from '../audio/engine';
import * as I from './Icons';
import { importAudioFlow, importSamplerFlow, importSoundFontFlow } from './ImportUI';
import { openPluginBrowser } from './Plugins';
import { categoryLabel, presetDescription, useT } from '../i18n';

const CATEGORY_HUE: Record<string, string> = {
  Keys: '#34d399',
  Synth: '#60a5fa',
  Bass: '#f472b6',
  'Pads & Strings': '#a78bfa',
  Drums: '#fbbf24',
  Imported: '#e879f9',
  Plugins: '#22d3ee',
};

export function Library() {
  const project = useStore((s) => s.project);
  const pluginsOn = useConfig((c) => c.features.plugins);
  const selected = getTrack(project, useStore((s) => s.selectedTrackId));
  const t = useT();
  const [view, setView] = useState<'sounds' | 'loops'>('sounds');
  const imported: InstrumentPreset[] = (project.instruments ?? []).map((c) => findInstrument(c.id)!).filter(Boolean);
  const all = [...imported, ...PRESETS];
  const categories = [...new Set(all.map((p) => p.category))];

  const choose = (p: InstrumentPreset) => {
    if (selected && selected.kind === p.kind) {
      commands.update_track({ track_id: selected.id, instrument: p.id });
      setTimeout(() => engine.preview(selected.id, p.kind === 'drums' ? 36 : 60, 0.8, 0.6), 60);
    } else {
      const { track_id } = commands.add_track({ instrument: p.id }) as { track_id: string };
      useStore.getState().notify(t('lib.newTrack', { name: p.name }));
      setTimeout(() => engine.preview(track_id, p.kind === 'drums' ? 36 : 60, 0.8, 0.6), 60);
    }
  };

  return (
    <aside className="library">
      <div className="lib-head">
        <div className="lib-title">{t('lib.title')}</div>
        <div className="lib-sub">{selected ? t('lib.track', { name: selected.name }) : t('lib.clickToCreate')}</div>
        <div className="lib-tabs" role="tablist">
          <button role="tab" aria-selected={view === 'sounds'} className={view === 'sounds' ? 'on' : ''} onClick={() => setView('sounds')}>
            {t('loops.tabSounds')}
          </button>
          <button role="tab" aria-selected={view === 'loops'} className={view === 'loops' ? 'on' : ''} onClick={() => setView('loops')}>
            {t('loops.tab')}
          </button>
        </div>
      </div>
      {view === 'loops' ? (
        <div className="lib-scroll">
          <LoopBrowser />
        </div>
      ) : (
        <>
      <div className="lib-import">
        <div className="lib-cat-name">{t('imp.title')}</div>
        <div className="lib-import-grid">
          <button className="mini" onClick={() => importSamplerFlow('instrument')} title={t('imp.samplerHint')}>
            <I.KeysIcon width={13} height={13} /> {t('imp.sampler')}
          </button>
          <button className="mini" onClick={() => importSamplerFlow('drums')} title={t('imp.kitHint')}>
            <I.DrumIcon width={13} height={13} /> {t('imp.kit')}
          </button>
          <button className="mini" onClick={() => importSoundFontFlow()} title={t('imp.sfHint')}>
            <I.Library width={13} height={13} /> SoundFont
          </button>
          <button className="mini" onClick={() => importAudioFlow()} title={t('imp.audioHint')}>
            <I.Wave width={13} height={13} /> {t('imp.audio')}
          </button>
          {pluginsOn && (
            <button className="mini plug-btn" onClick={() => openPluginBrowser('any')} title={t('plug.libHint')}>
            <I.Fx width={13} height={13} /> {t('plug.button')}
          </button>
          )}
        </div>
      </div>
      <div className="lib-scroll">
        {categories.map((cat) => (
          <div key={cat} className="lib-cat">
            <div className="lib-cat-name" style={{ color: CATEGORY_HUE[cat] }}>
              {cat === 'Drums' ? <I.DrumIcon width={14} height={14} /> : <I.KeysIcon width={14} height={14} />}
              {categoryLabel(cat)}
            </div>
            {all.filter((p) => p.category === cat).map((p) => {
              const active = selected?.instrument === p.id;
              return (
                <button key={p.id} className={`lib-item ${active ? 'active' : ''}`} onClick={() => choose(p)} style={{ '--hue': CATEGORY_HUE[cat] } as React.CSSProperties}>
                  <span className="lib-swatch" />
                  <span className="lib-text">
                    <span className="lib-name">{p.name}</span>
                    <span className="lib-desc">{p.category === 'Plugins' ? p.description : p.category === 'Imported' ? `${p.description} · ${p.kind === 'drums' ? t('cat.Drums') : t('imp.instrument')}` : presetDescription(p)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {selected && <div className="lib-foot">{findInstrument(selected.instrument)?.name}</div>}
        </>
      )}
    </aside>
  );
}
