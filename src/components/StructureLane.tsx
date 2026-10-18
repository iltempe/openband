// Structure lane above the ruler: song sections as coloured blocks.
import { useState } from 'react';
import type { Section, SectionKind } from '../types';
import { useStore } from '../store';
import { runCommand } from '../commands';
import { proposeSections } from '../structure';
import { useT, type MessageKey } from '../i18n';

const KINDS: SectionKind[] = ['intro', 'verse', 'prechorus', 'chorus', 'bridge', 'solo', 'breakdown', 'outro', 'custom'];
const run = (method: string, params: Record<string, unknown>) => runCommand(method, params, 'ui').catch((e) => useStore.getState().notify((e as Error).message));

export function StructureCorner() {
  const has = useStore((s) => !!s.project.sections?.length);
  const t = useT();
  const suggest = async () => {
    const proposal = proposeSections(useStore.getState().project);
    if (!proposal.length) return useStore.getState().notify(t('sec.nothing'));
    const s = useStore.getState();
    const tx = s.beginTransaction(t('sec.suggestLabel'), 'ui');
    try {
      for (const p of proposal) await runCommand('add_section', { name: p.name, kind: p.kind, start_bar: p.start / 4 + 1, length_bars: p.length / 4 }, 'ui');
    } finally {
      useStore.getState().endTransaction(tx);
    }
  };
  return (
    <div className="struct-corner">
      <span>{t('sec.lane')}</span>
      {!has && (
        <button className="mini" onClick={suggest} title={t('sec.suggestHint')}>
          {t('sec.suggest')}
        </button>
      )}
    </div>
  );
}

export function StructureLane() {
  const sections = useStore((s) => s.project.sections ?? []);
  const zoom = useStore((s) => s.zoom);
  const commit = useStore((s) => s.commit);
  const [drag, setDrag] = useState<{ id: string; dx: number } | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const t = useT();
  const kindLabel = (k: SectionKind) => t(`sec.kind.${k}` as MessageKey);

  const addAt = (bar: number) => {
    const sorted = [...sections].sort((a, b) => a.start - b.start);
    const start = (bar - 1) * 4;
    if (sorted.some((s) => start >= s.start && start < s.start + s.length)) return;
    const next = sorted.find((s) => s.start > start);
    const bars = Math.max(1, Math.min(4, next ? (next.start - start) / 4 : 4));
    const n = sections.filter((s) => s.kind === 'verse').length + 1;
    void run('add_section', { name: `${kindLabel('verse')} ${n}`, kind: 'verse', start_bar: bar, length_bars: bars });
  };

  const onDown = (e: React.PointerEvent, s: Section) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const x0 = e.clientX;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - x0) > 3) moved = true;
      if (moved) setDrag({ id: s.id, dx: ev.clientX - x0 });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      if (!moved) {
        // Click: loop the section.
        commit((d) => void (d.loop = { enabled: true, start: s.start, end: s.start + s.length }), { label: t('sec.loop') });
        return;
      }
      const bars = Math.round((ev.clientX - x0) / zoom / 4);
      if (!bars) return;
      const target = Math.max(1, s.start / 4 + 1 + bars);
      // Dropping later lands after the block under the cursor (timeline without the section).
      const toBar = bars > 0 && ev.altKey ? target + s.length / 4 : target;
      void run('move_section', { section_id: s.id, to_bar: toBar, ripple: ev.altKey });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      className="struct-lane"
      onDoubleClick={(e) => {
        if (e.target !== e.currentTarget) return;
        const r = e.currentTarget.getBoundingClientRect();
        addAt(Math.floor((e.clientX - r.left) / zoom / 4) + 1);
      }}
      onPointerDown={() => setMenu(null)}
      title={t('sec.laneHint')}
    >
      {sections.map((s) => (
        <div
          key={s.id}
          className={`struct-block ${drag?.id === s.id ? 'dragging' : ''}`}
          style={{ left: s.start * zoom + (drag?.id === s.id ? drag.dx : 0), width: Math.max(8, s.length * zoom - 2), background: s.color }}
          onPointerDown={(e) => onDown(e, s)}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setRenaming(s.id);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ id: s.id, x: s.start * zoom });
          }}
        >
          {renaming === s.id ? (
            <input
              autoFocus
              className="struct-rename"
              defaultValue={s.name}
              onPointerDown={(e) => e.stopPropagation()}
              onBlur={(e) => {
                setRenaming(null);
                if (e.target.value && e.target.value !== s.name) void run('update_section', { section_id: s.id, name: e.target.value });
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          ) : (
            <span>{s.name}</span>
          )}
        </div>
      ))}
      {menu && (
        <div className="struct-menu" style={{ left: menu.x }} onPointerDown={(e) => e.stopPropagation()}>
          <button onClick={() => (setMenu(null), void run('duplicate_section', { section_id: menu.id }))}>{t('sec.duplicate')}</button>
          <select
            value={sections.find((s) => s.id === menu.id)?.kind}
            onChange={(e) => {
              setMenu(null);
              void run('update_section', { section_id: menu.id, kind: e.target.value });
            }}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {kindLabel(k)}
              </option>
            ))}
          </select>
          <button onClick={() => (setMenu(null), void run('delete_section', { section_id: menu.id }))}>{t('sec.delete')}</button>
          <button className="danger" onClick={() => (setMenu(null), void run('delete_section', { section_id: menu.id, delete_content: true }))}>
            {t('sec.deleteContent')}
          </button>
        </div>
      )}
    </div>
  );
}
