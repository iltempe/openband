// Multiplayer UI: the Share button (room, link, people), the join dialog for room links, peer dots
// on tracks and the room's AI activity.
import { useState } from 'react';
import { useStore } from '../store';
import { runCommand } from '../commands';
import { setMyName, useCollab } from '../collab/session';
import { useT } from '../i18n';
import * as I from './Icons';

const notify = (m: string) => useStore.getState().notify(m);
const run = (m: string, a: Record<string, unknown> = {}) => runCommand(m, a, 'ui').catch((e) => notify((e as Error).message));

function Avatar({ name, color, ai, size = 22 }: { name: string; color: string; ai?: boolean; size?: number }) {
  return (
    <span className={`peer-av ${ai ? 'ai' : ''}`} style={{ background: color, width: size, height: size, fontSize: size * 0.45 }} title={ai ? `${name} + AI` : name}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function ShareButton() {
  const c = useCollab();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const t = useT();
  const others = c.peers.filter((p) => !p.me);
  return (
    <div className="menu-wrap">
      <button className={`icon-btn share-btn ${c.status === 'connected' ? 'on' : ''}`} onClick={() => setOpen(!open)} title={t('co.title')}>
        {c.status === 'connected' && others.length ? (
          <span className="peer-stack">
            {others.slice(0, 3).map((p) => (
              <Avatar key={p.clientId} name={p.name} color={p.color} ai={p.ai} size={20} />
            ))}
          </span>
        ) : (
          <I.People />
        )}
      </button>
      {open && (
        <>
          <div className="menu-scrim" onClick={() => setOpen(false)} />
          <div className="menu share-menu">
            <label className="mic-row">
              <span>{t('co.yourName')}</span>
              <input value={c.me.name} onChange={(e) => setMyName(e.target.value.slice(0, 30))} />
            </label>
            <hr />
            {c.status === 'off' ? (
              <>
                <div className="menu-label">{t('co.start')}</div>
                <label className="mic-row">
                  <span>{t('co.password')}</span>
                  <input type="password" value={password} placeholder={t('co.optional')} onChange={(e) => setPassword(e.target.value)} />
                </label>
                <div className="share-actions">
                  <button className="btn primary" disabled={!c.server} title={c.server ? '' : t('co.lanOff')} onClick={() => run('create_room', { via: 'lan', password: password || undefined })}>
                    {t('co.lan')}
                  </button>
                  <button className="btn" onClick={() => run('create_room', { via: 'p2p', password: password || undefined })}>
                    {t('co.p2p')}
                  </button>
                </div>
                <div className="share-hint">{c.server ? t('co.hint') : t('co.lanOff')}</div>
              </>
            ) : (
              <>
                <div className="menu-label">
                  {t('co.room')} <b>{c.room}</b> · {c.via === 'lan' ? 'LAN' : 'P2P'} {c.status === 'connecting' && `· ${t('co.connecting')}`}
                </div>
                {c.link && (
                  <div className="share-link">
                    <input readOnly value={c.link} onFocus={(e) => e.target.select()} />
                    <button className="mini" onClick={() => navigator.clipboard?.writeText(c.link!).then(() => notify(t('co.copied')))}>
                      <I.Copy width={13} height={13} />
                    </button>
                  </div>
                )}
                <div className="peer-list">
                  {c.peers.map((p) => (
                    <div key={p.clientId} className="peer-row">
                      <Avatar name={p.name} color={p.color} ai={p.ai} />
                      <span className="peer-name">
                        {p.name}
                        {p.me && ` (${t('co.you')})`}
                      </span>
                      {p.host && <span className="ver-chip" style={{ background: '#facc15' }}>host</span>}
                      {p.ai && <span className="ver-chip" style={{ background: '#c4b5fd' }}>AI</span>}
                    </div>
                  ))}
                </div>
                {!c.isHost && (
                  <label className="mic-row">
                    <input type="checkbox" checked={c.followHost} onChange={(e) => useCollab.setState({ followHost: e.target.checked })} />
                    <span>{t('co.follow')}</span>
                  </label>
                )}
                <button className="btn" onClick={() => (setOpen(false), run('leave_room'))}>
                  {t('co.leave')}
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Opening a room link asks for your name and the password, then joins. */
export function JoinDialog() {
  const params = new URLSearchParams(location.search);
  const room = params.get('room');
  const c = useCollab();
  const [password, setPassword] = useState('');
  const [dismissed, setDismissed] = useState(false);
  const t = useT();
  if (!room || dismissed || c.status !== 'off') return null;
  return (
    <div className="modal-scrim">
      <form
        className="modal mic-confirm"
        onSubmit={(e) => {
          e.preventDefault();
          setDismissed(true);
          void run('join_room', { room, password: password || undefined, via: params.get('via') ?? undefined });
        }}
      >
        <div className="modal-head">
          <div>
            <div className="lib-title">{t('co.joinTitle', { room })}</div>
            <div className="lib-sub">{t('co.joinSub')}</div>
          </div>
        </div>
        <div className="join-fields">
          <label className="mic-row">
            <span>{t('co.yourName')}</span>
            <input autoFocus value={c.me.name} onChange={(e) => setMyName(e.target.value.slice(0, 30))} />
          </label>
          <label className="mic-row">
            <span>{t('co.password')}</span>
            <input type="password" value={password} placeholder={t('co.ifAny')} onChange={(e) => setPassword(e.target.value)} />
          </label>
        </div>
        <div className="mic-confirm-buttons">
          <button type="button" className="btn" onClick={() => setDismissed(true)}>
            {t('co.notNow')}
          </button>
          <button type="submit" className="btn primary">
            {t('co.join')}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Small avatars on a track header: who else has this track selected. */
export function PeerDots({ trackId }: { trackId: string }) {
  const peers = useCollab((c) => c.peers);
  const here = peers.filter((p) => !p.me && p.trackId === trackId);
  if (!here.length) return null;
  return (
    <span className="peer-dots">
      {here.map((p) => (
        <Avatar key={p.clientId} name={p.name} color={p.color} ai={p.ai} size={16} />
      ))}
    </span>
  );
}

/** In a room, the AI panel also shows what the AIs of the others did, and for whom. */
export function RoomActivity() {
  const c = useCollab();
  const t = useT();
  if (c.status !== 'connected' || !c.activity.length) return null;
  // Only what changed the song (reads like get_project are noise for the others).
  const others = c.activity.filter((a) => a.peer !== c.me.name && !/^(get_|list_|analyze_|detect_|render_|export_|wait_|compare_|check_|lint_)/.test(a.method)).slice(0, 12);
  if (!others.length) return null;
  return (
    <>
      <div className="ai-section">{t('co.roomActivity')}</div>
      <div className="ai-log">
        {others.map((a, i) => (
          <div key={i} className="ai-log-item">
            <span className="ai-log-time">{new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            <span className="ai-log-method">{t('co.forPeer', { name: a.peer })}</span>
            <span className="ai-log-sum">
              {a.method} · {a.summary}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
