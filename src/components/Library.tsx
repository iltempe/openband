import { getTrack, useStore } from '../store';
import { PRESETS, presetById, type InstrumentPreset } from '../audio/instruments';
import { commands } from '../commands';
import { engine } from '../audio/engine';
import * as I from './Icons';
import { categoryLabel, presetDescription, useT } from '../i18n';

const CATEGORY_HUE: Record<string, string> = {
  Keys: '#34d399',
  Synth: '#60a5fa',
  Bass: '#f472b6',
  'Pads & Strings': '#a78bfa',
  Drums: '#fbbf24',
};

export function Library() {
  const project = useStore((s) => s.project);
  const selected = getTrack(project, useStore((s) => s.selectedTrackId));
  const t = useT();
  const categories = [...new Set(PRESETS.map((p) => p.category))];

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
      </div>
      <div className="lib-scroll">
        {categories.map((cat) => (
          <div key={cat} className="lib-cat">
            <div className="lib-cat-name" style={{ color: CATEGORY_HUE[cat] }}>
              {cat === 'Drums' ? <I.DrumIcon width={14} height={14} /> : <I.KeysIcon width={14} height={14} />}
              {categoryLabel(cat)}
            </div>
            {PRESETS.filter((p) => p.category === cat).map((p) => {
              const active = selected?.instrument === p.id;
              return (
                <button key={p.id} className={`lib-item ${active ? 'active' : ''}`} onClick={() => choose(p)} style={{ '--hue': CATEGORY_HUE[cat] } as React.CSSProperties}>
                  <span className="lib-swatch" />
                  <span className="lib-text">
                    <span className="lib-name">{p.name}</span>
                    <span className="lib-desc">{presetDescription(p)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {selected && <div className="lib-foot">{presetById(selected.instrument)?.name}</div>}
    </aside>
  );
}
