// Song tests (C2), at the top of the Problems panel: one line of text per test, green or red.
import { useState } from 'react';
import { useT } from '../i18n';
import { useStore } from '../store';
import { runCommand } from '../commands';
import { runTests } from '../tests/engine';
import { SUITES } from '../tests/suites';
import type { TestRun } from '../tests/types';

const notify = (e: unknown) => useStore.getState().notify((e as Error).message);

export function SongTests() {
  const t = useT();
  const project = useStore((s) => s.project);
  const [text, setText] = useState('');
  const [, setRun] = useState<TestRun | null>(null);
  const run = project.testRun;
  const [busy, setBusy] = useState(false);
  const tests = project.tests ?? [];
  // Symbolic tests are instant; audio results stay from the last run.
  const live = runTests(project);
  const resultOf = (id: string) => {
    const own = [...(run?.results ?? []), ...live.results].filter((r) => r.testId === id);
    return own.find((r) => !r.skipped && !r.pass) ?? own.find((r) => !r.skipped) ?? own[0];
  };
  const add = () => void Promise.resolve(runCommand('add_test', { text }, 'ui')).then(() => setText('')).catch(notify);
  const runAll = async () => {
    setBusy(true);
    await Promise.resolve(runCommand('run_tests', {}, 'ui')).then((r) => setRun(r as TestRun)).catch(notify);
    setBusy(false);
  };
  return (
    <section className="st-box">
      <div className="st-head">
        <h4>{t('st2.title')}</h4>
        <button className="btn" disabled={!tests.length || busy} onClick={() => void runAll()}>{busy ? t('st2.running') : t('st2.run')}</button>
      </div>
      {tests.map((x) => {
        const r = resultOf(x.id);
        const mark = !r || r.skipped ? '–' : r.pass ? '✓' : '✗';
        return (
          <div key={x.id} className={`st-row ${r && !r.pass ? 'st-bad' : ''}`}>
            <span aria-label={mark === '✓' ? t('st2.pass') : mark === '✗' ? t('st2.fail') : t('st2.notRun')}>{mark}</span>
            <span className="st-text">{x.source ?? x.name}</span>
            {r && !r.pass && r.value !== undefined && <span className="st-value">{+r.value.toFixed(2)} ({r.expected})</span>}
            <button className="btn" aria-label={t('st2.remove')} onClick={() => void Promise.resolve(runCommand('remove_test', { id: x.id }, 'ui')).catch(notify)}>×</button>
          </div>
        );
      })}
      <div className="pj-actions">
        {Object.keys(SUITES).map((id) => (
          <button key={id} className="btn" onClick={() => void Promise.resolve(runCommand('add_test_suite', { name: id }, 'ui')).catch(notify)}>
            + {t(`st2.suite.${id}` as never)}
          </button>
        ))}
        <button className="btn" onClick={() => void Promise.resolve(runCommand('set_baseline', {}, 'ui')).catch(notify)}>{t('st2.approve')}</button>
      </div>
      <form
        className="st-add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input className="pj-input" aria-label={t('st2.add')} placeholder={t('st2.placeholder')} value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn" disabled={!text.trim()}>{t('st2.add')}</button>
      </form>
    </section>
  );
}
