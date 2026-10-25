// "Your engines" (SPEC v0.6 §7): what blind tests taught the router — per capability, each engine's score
// with its comparisons and an interval, so a preference from two listens isn't taken as certain.
import { useT } from '../i18n';
import { resetTaste, tasteByCapability, useTaste } from '../ensemble/taste';

export function YourEngines({ names }: { names: Record<string, string> }) {
  const t = useT();
  useTaste((s) => s.version);
  const all = tasteByCapability();
  return (
    <section className="en-taste">
      <h4>{t('ta.title')}</h4>
      {!all.length ? (
        <p className="ca-note">{t('ta.empty')}</p>
      ) : (
        <>
          {all.map(({ capability, ranking }) => (
            <div key={capability} className="ta-cap">
              <div className="syn-label">{capability}</div>
              <ul className="en-engines">
                {ranking.map((r) => (
                  <li key={r.engine}>
                    <b>{names[r.engine] ?? r.engine}</b>{' '}
                    <span className="en-badge">
                      {Math.round(r.score * 100)} % ± {Math.round(r.interval * 100)}
                    </span>{' '}
                    <span className="ca-note">{t('ta.count', { n: r.comparisons, wins: r.wins })}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <button className="mini" onClick={() => resetTaste()}>
            {t('ta.reset')}
          </button>
        </>
      )}
    </section>
  );
}
