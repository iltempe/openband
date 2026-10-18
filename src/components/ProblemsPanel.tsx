// Problems panel: the musical linter's findings, with one-click fixes.
import { useStore } from '../store';
import { runCommand } from '../commands';
import { useLint } from '../lintLive';
import type { LintIssue } from '../lint/types';
import { useT, type MessageKey } from '../i18n';
import * as I from './Icons';

export function ProblemsPanel() {
  const { issues, counts } = useLint();
  const set = useStore((s) => s.set);
  const t = useT();

  const show = (i: LintIssue) => {
    const s = useStore.getState();
    const region = i.target.region_id ? s.project.regions.find((r) => r.id === i.target.region_id) : undefined;
    if (region) {
      s.selectRegion(region);
      set({ selectedNoteIds: i.target.note_ids ?? [], bottom: i.target.note_ids?.length ? 'editor' : 'problems' });
    } else if (i.target.track_id) set({ selectedTrackId: i.target.track_id });
  };
  const run = (method: string, params: Record<string, unknown>) => runCommand(method, params, 'ui').catch((e) => useStore.getState().notify((e as Error).message));
  const label = (i: LintIssue) => {
    const k = `lint.${i.rule}` as MessageKey;
    const msg = t(k, i.params);
    return msg === k ? i.message : msg;
  };

  return (
    <div className="problems">
      <div className="analysis-bar">
        <span className="pb-counts">
          <span className="pb-dot error" /> {counts.error} <span className="pb-dot warn" /> {counts.warn} <span className="pb-dot info" /> {counts.info}
        </span>
        <span className="analysis-range">{t('lint.hint')}</span>
      </div>
      {!issues.length ? (
        <div className="panel-empty">
          <I.Sparkles width={28} height={28} />
          <p>{t('lint.clean')}</p>
        </div>
      ) : (
        <div className="pb-list">
          {issues.map((i) => (
            <div key={i.id} className={`pb-item ${i.severity}`}>
              <span className="an-sev" />
              <button className="pb-text" onClick={() => show(i)}>
                <strong>{label(i)}</strong>
                <small>
                  {t(`lint.cat.${i.category}` as MessageKey)} · {i.rule}
                </small>
              </button>
              {i.fix && (
                <button className="mini" onClick={() => run('apply_fix', { issue_id: i.id })} title={i.fix.label}>
                  {t('lint.fix')}
                </button>
              )}
              <button className="mini" onClick={() => run('ignore_issue', { issue_id: i.id })}>
                {t('lint.ignore')}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
