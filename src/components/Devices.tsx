// Devices panel (R3.4): what is connected, its controls live, and what they drive.
import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { useStore } from '../store';
import { runCommand } from '../commands';
import { AUTO_PARAMS } from '../automation';
import { connectUsb, refreshDevices, useDevices } from '../devices';
import { serialSupported } from '../devices/serial';

const notify = (e: unknown) => useStore.getState().notify((e as Error).message);
const run = (m: string, a: Record<string, unknown> = {}) => Promise.resolve(runCommand(m, a, 'ui'));

export function DevicesPanel() {
  const t = useT();
  const { list, values, ask } = useDevices();
  const tracks = useStore((s) => s.project.tracks);
  const mappings = useStore((s) => s.project.deviceMappings) ?? [];
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [track, setTrack] = useState('');
  const [target, setTarget] = useState('tone');
  useEffect(() => void refreshDevices().catch(() => null), []);
  const plugSerial = async () => {
    if (!serialSupported()) throw new Error(t('dv.noSerial'));
    await connectUsb();
  };
  return (
    <div className="pj-panel">
      <section className="pj-link">
        <h4>{t('dv.tab')}</h4>
        <p className="pj-meta">{t('dv.intro')}</p>
        <input className="pj-input" aria-label={t('dv.url')} placeholder="http://192.168.1.20:7788/" value={url} onChange={(e) => setUrl(e.target.value)} />
        <input className="pj-input" type="password" aria-label={t('dv.token')} placeholder={t('dv.token')} value={token} onChange={(e) => setToken(e.target.value)} />
        <button className="btn" disabled={!url} onClick={() => void run('connect_device', { url, token: token || undefined }).catch(notify)}>{t('dv.connect')}</button>
        <button className="btn" onClick={() => void plugSerial().catch(notify)}>{t('dv.usb')}</button>
        {ask && (
          <div className="pj-alert" role="alertdialog">
            <p>{t('dv.confirm', { name: ask.name })}</p>
            <button className="btn" onClick={() => ask.resolve(true)}>{t('dv.yes')}</button>
            <button className="btn" onClick={() => ask.resolve(false)}>{t('pr.cancel')}</button>
          </div>
        )}
      </section>
      <section style={{ gridColumn: 'span 2' }}>
        {!list.length && <p className="pj-meta">{t('dv.none')}</p>}
        {list.map((d) => (
          <div className="pj-row" key={d.id}>
            <div className="pj-name">
              <b>{d.name}</b>
              <span className="pj-badge">{d.hardware}</span>
              {d.latency_ms !== null && <span className="pj-badge">{d.latency_ms} ms</span>}
            </div>
            {d.controls.map((c) => (
              <div className="pj-meta dv-control" key={c.id}>
                <span>{c.label}</span>
                <div className="bx-meter" role="meter" aria-label={c.label} aria-valuenow={values[d.id]?.[c.id] ?? 0} aria-valuemin={0} aria-valuemax={1}>
                  <span style={{ width: `${(values[d.id]?.[c.id] ?? 0) * 100}%` }} />
                </div>
                <button className="btn" disabled={!track} onClick={() => void run('map_control', { device: d.id, control: c.id, track_id: track, target }).catch(notify)}>{t('dv.map')}</button>
              </div>
            ))}
          </div>
        ))}
        <div className="pj-actions">
          <select aria-label={t('dv.track')} value={track} onChange={(e) => setTrack(e.target.value)}>
            <option value="">{t('dv.track')}</option>
            {tracks.map((x) => (
              <option key={x.id} value={x.id}>{x.name}</option>
            ))}
          </select>
          <select aria-label={t('dv.target')} value={target} onChange={(e) => setTarget(e.target.value)}>
            {AUTO_PARAMS.map((p) => (
              <option key={p.id} value={p.id}>{p.id}</option>
            ))}
          </select>
        </div>
        {mappings.map((m) => (
          <p className="pj-meta" key={`${m.deviceId}${m.control}${m.trackId}${m.target}`}>
            {m.control} → {tracks.find((x) => x.id === m.trackId)?.name} · {m.target}{' '}
            <label>
              <input type="checkbox" checked={!!m.write} onChange={(e) => void run('map_control', { device: m.deviceId, control: m.control, track_id: m.trackId, target: m.target, curve: m.curve, range: [m.min, m.max], smooth_ms: m.smoothMs, write: e.target.checked }).catch(notify)} /> {t('dv.write')}
            </label>{' '}
            <button className="btn" onClick={() => void run('unmap_control', { device: m.deviceId, control: m.control }).catch(notify)}>×</button>
          </p>
        ))}
        <p className="pj-meta">{t('dv.record')}</p>
      </section>
    </div>
  );
}
