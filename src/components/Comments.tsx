// Annotations UI: comment pins, the "Explain" menu, and the Comments panel with threads.
import { Fragment, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import type { Annotation, AnnotationTarget, Project } from '../types';
import { useStore } from '../store';
import { runCommand } from '../commands';
import { BEATS_PER_BAR } from '../music';
import { askExplain, setTeachMode, useTeachMode } from '../events';
import { threads, threadKey, type Thread } from '../annotations';
import { t as tr, useT } from '../i18n';

export const useComments = create<{ focus: string | null; menu: { x: number; y: number; target: AnnotationTarget } | null }>(() => ({ focus: null, menu: null }));

const run = (m: string, a: Record<string, unknown>) => runCommand(m, a, 'ui').catch((e) => useStore.getState().notify((e as Error).message));

export function openComments(target?: AnnotationTarget) {
  useComments.setState({ focus: target ? threadKey(target) : null, menu: null });
  useStore.getState().set({ bottom: 'comments' });
}

/** Ask the connected AI to explain a part of the song (it answers with annotate). */
export function explain(target: AnnotationTarget) {
  useComments.setState({ menu: null });
  const ctx =
    target.type === 'region'
      ? { region_id: target.id }
      : target.type === 'section'
        ? { section_id: target.id }
        : target.type === 'notes'
          ? { region_id: target.id, note_ids: target.note_ids }
          : target.type === 'track'
            ? { track_id: target.id }
            : {};
  askExplain(tr('cm.explainAsk', { what: describe(useStore.getState().project, target) }), ctx);
  const s = useStore.getState();
  s.notify(s.bridgeStatus === 'connected' ? tr('cm.explainSent') : tr('cm.noAi'));
}

/** Open (unresolved) annotations about a region, including those on its notes. */
export const openFor = (p: Project, pred: (a: Annotation) => boolean) => (p.annotations ?? []).filter((a) => !a.resolved && pred(a));

export function describe(p: Project, t: AnnotationTarget): string {
  const bar = (b: number) => Math.floor(b / BEATS_PER_BAR) + 1;
  switch (t.type) {
    case 'project':
      return tr('cm.t.project');
    case 'track':
      return p.tracks.find((x) => x.id === t.id)?.name ?? tr('cm.t.track');
    case 'region': {
      const r = p.regions.find((x) => x.id === t.id);
      return r ? `${r.name} · ${tr('cm.bar', { n: bar(r.start) })}` : tr('cm.t.region');
    }
    case 'section':
      return p.sections?.find((x) => x.id === t.id)?.name ?? tr('cm.t.section');
    case 'notes': {
      const r = p.regions.find((x) => x.id === t.id);
      return tr('cm.t.notes', { n: t.note_ids?.length ?? 0, region: r?.name ?? '' });
    }
    case 'range':
      return tr('cm.t.range', { from: bar(t.from_beat ?? 0), to: Math.max(bar(t.from_beat ?? 0), Math.ceil((t.to_beat ?? 0) / BEATS_PER_BAR)) });
  }
}

/** Tiny, safe markdown: **bold**, *italic*, `code`, line breaks. */
export function Markdown({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <>
      {lines.map((line, i) => {
        const parts: ReactNode[] = [];
        const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
        let last = 0;
        for (const m of line.matchAll(re)) {
          if (m.index! > last) parts.push(line.slice(last, m.index));
          const s = m[0];
          parts.push(s.startsWith('**') ? <b key={m.index}>{s.slice(2, -2)}</b> : s.startsWith('`') ? <code key={m.index}>{s.slice(1, -1)}</code> : <i key={m.index}>{s.slice(1, -1)}</i>);
          last = m.index! + s.length;
        }
        parts.push(line.slice(last));
        return (
          <Fragment key={i}>
            {i > 0 && <br />}
            {parts}
          </Fragment>
        );
      })}
    </>
  );
}

export function CommentPin({ list, target, className = '' }: { list: Annotation[]; target: AnnotationTarget; className?: string }) {
  if (!list.length) return null;
  const ai = list.some((a) => a.author.kind === 'ai');
  return (
    <button
      className={`cm-pin ${ai ? 'ai' : ''} ${className}`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        openComments(target);
      }}
      title={list[list.length - 1].text.slice(0, 140)}
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
        <path d="M4 4h16v12H8l-4 4z" />
      </svg>
      {list.length > 1 && list.length}
    </button>
  );
}

/** Right-click menu on regions: Explain / Comments. */
export function ExplainMenu() {
  const menu = useComments((s) => s.menu);
  const t = useT();
  if (!menu) return null;
  return (
    <>
      <div className="menu-scrim" onPointerDown={() => useComments.setState({ menu: null })} onContextMenu={(e) => (e.preventDefault(), useComments.setState({ menu: null }))} />
      <div className="menu cm-menu" style={{ left: menu.x, top: menu.y }}>
        <button onClick={() => explain(menu.target)}>{t('cm.explain')}</button>
        <button onClick={() => openComments(menu.target)}>{t('cm.comment')}</button>
      </div>
    </>
  );
}

function ThreadView({ th, project }: { th: Thread; project: Project }) {
  const [reply, setReply] = useState('');
  const focus = useComments((s) => s.focus);
  const t = useT();
  const select = () => {
    const s = useStore.getState();
    const tg = th.target;
    if (tg.type === 'region' || tg.type === 'notes') {
      const r = project.regions.find((x) => x.id === tg.id);
      if (r) s.selectRegion(r);
      if (tg.type === 'notes') s.set({ selectedNoteIds: tg.note_ids ?? [] });
    } else if (tg.type === 'track' && tg.id) s.set({ selectedTrackId: tg.id });
  };
  return (
    <div className={`cm-thread ${th.resolved ? 'resolved' : ''} ${focus === th.key ? 'focus' : ''}`}>
      <button className="cm-target" onClick={select}>
        {describe(project, th.target)}
        {th.orphaned && <span className="cm-orphan">{t('cm.orphan')}</span>}
      </button>
      {th.items.map((a) => (
        <div key={a.id} className={`cm-item ${a.author.kind} ${a.replyTo ? 'reply' : ''}`}>
          <div className="cm-meta">
            <b>{a.author.kind === 'user' && a.author.name === 'You' ? t('cm.you') : a.author.name}</b>
            <span>{new Date(a.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            <span className="eb-spacer" />
            <button className="mini" onClick={() => run('resolve_annotation', { annotation_id: a.id, resolved: !a.resolved })}>
              {a.resolved ? t('cm.reopen') : t('cm.resolve')}
            </button>
            <button className="mini" onClick={() => run('delete_annotation', { annotation_id: a.id })} title={t('cm.delete')}>
              ×
            </button>
          </div>
          <div className="cm-text">
            <Markdown text={a.text} />
          </div>
        </div>
      ))}
      {!th.orphaned && (
        <form
          className="cm-reply"
          onSubmit={(e) => {
            e.preventDefault();
            if (!reply.trim()) return;
            const last = th.items[th.items.length - 1];
            void run('annotate', { target: th.target, text: reply.trim().slice(0, 500), ...(last ? { reply_to: last.id } : {}) });
            setReply('');
          }}
        >
          <input value={reply} maxLength={500} placeholder={t('cm.reply')} onChange={(e) => setReply(e.target.value)} />
          <button className="mini" type="button" onClick={() => explain(th.target)} title={t('cm.explainHint')}>
            {t('cm.explain')}
          </button>
        </form>
      )}
    </div>
  );
}

export function CommentsPanel() {
  const project = useStore((s) => s.project);
  const teach = useTeachMode((s) => s.on);
  const [showResolved, setShowResolved] = useState(false);
  const [draft, setDraft] = useState('');
  const t = useT();
  const all = threads(project.annotations ?? []);
  const list = all.filter((th) => showResolved || !th.resolved);
  return (
    <div className="comments">
      <div className="analysis-bar">
        <label className="ai-share cm-teach" title={t('cm.teachHint')}>
          <input type="checkbox" checked={teach} onChange={(e) => setTeachMode(e.target.checked)} />
          <span>{t('cm.teach')}</span>
        </label>
        <label className="ref-match">
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
          {t('cm.showResolved')}
        </label>
        <span className="eb-spacer" />
        <form
          className="cm-reply cm-new"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.trim()) return;
            const s = useStore.getState();
            const target: AnnotationTarget = s.selectedNoteIds.length && s.selectedRegionId ? { type: 'notes', id: s.selectedRegionId, note_ids: s.selectedNoteIds } : s.selectedRegionId ? { type: 'region', id: s.selectedRegionId } : { type: 'project' };
            void run('annotate', { target, text: draft.trim().slice(0, 500) });
            setDraft('');
          }}
        >
          <input value={draft} maxLength={500} placeholder={t('cm.new')} onChange={(e) => setDraft(e.target.value)} />
        </form>
      </div>
      <div className="cm-list">
        {!list.length && <div className="panel-empty"><p>{t('cm.empty')}</p></div>}
        {list.map((th) => (
          <ThreadView key={th.key} th={th} project={project} />
        ))}
      </div>
    </div>
  );
}
