// Diagnostics: what the app knows about the browser, audio, bridge, permissions, storage, plugins and
// recent errors — for the Diagnostics page and the "Report a problem" issue. Never the song (names,
// notes, lyrics) and never keys.
import * as Tone from 'tone';
import { useStore } from './store';
import { useBridge } from './bridge';
import { liveWams, wamErrors } from './audio/wam';
import { useMetrics } from './firstRun';

declare const __APP_VERSION__: string;
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
export const REPO = 'iltempe/openband';

// ---------------------------------------------------------------- error log

export interface LoggedError {
  at: number;
  message: string;
}
const errors: LoggedError[] = [];
/** Keep at most the last 50, one line each, without long payloads. */
export function logError(message: unknown) {
  const text = String(message instanceof Error ? `${message.name}: ${message.message}` : message).split('\n')[0].slice(0, 300);
  errors.push({ at: Date.now(), message: text });
  if (errors.length > 50) errors.splice(0, errors.length - 50);
}
export const recentErrors = () => [...errors];

export function initDiagnostics() {
  window.addEventListener('error', (e) => logError(e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => logError(e.reason));
}

// ---------------------------------------------------------------- collect

export interface Diagnostics {
  app: string;
  browser: string;
  platform: string;
  audio: { state: string; sampleRate: number | null; baseLatencyMs: number | null; outputLatencyMs: number | null };
  bridge: { status: string; port: number; remote: boolean; serverVersion: string | null; problem: string | null };
  permissions: Record<string, string>;
  storage: { usedMb: number | null; quotaMb: number | null };
  plugins: { loaded: string[]; failed: string[] };
  metrics: { firstSoundMs: number | null; firstExportMs: number | null };
  errors: LoggedError[];
}

function browserName(ua: string) {
  const m = ua.match(/(Edg|OPR|Firefox|Chrome|Version)\/([\d.]+)/g) ?? [];
  const pick = (k: string) => m.find((x) => x.startsWith(k));
  const raw = pick('Edg') ?? pick('OPR') ?? pick('Firefox') ?? (/Safari/.test(ua) && !/Chrome/.test(ua) ? `Safari/${pick('Version')?.split('/')[1]}` : pick('Chrome')) ?? ua.slice(0, 60);
  return raw.replace('Edg', 'Edge').replace('OPR', 'Opera').replace('/', ' ');
}

const ms = (s: number | undefined) => (typeof s === 'number' && Number.isFinite(s) ? Math.round(s * 1000) : null);

export async function collectDiagnostics(): Promise<Diagnostics> {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : 'node';
  let audio: Diagnostics['audio'] = { state: 'unknown', sampleRate: null, baseLatencyMs: null, outputLatencyMs: null };
  try {
    const c = Tone.getContext().rawContext as unknown as AudioContext;
    audio = { state: c.state, sampleRate: c.sampleRate, baseLatencyMs: ms(c.baseLatency), outputLatencyMs: ms(c.outputLatency) };
  } catch {
    // no audio context
  }
  const permissions: Record<string, string> = {};
  for (const name of ['microphone', 'midi', 'local-network-access']) {
    try {
      permissions[name] = (await navigator.permissions.query({ name: name as PermissionName })).state;
    } catch {
      permissions[name] = 'unsupported';
    }
  }
  let storage: Diagnostics['storage'] = { usedMb: null, quotaMb: null };
  try {
    const e = await navigator.storage.estimate();
    storage = { usedMb: e.usage !== undefined ? +(e.usage / 1e6).toFixed(1) : null, quotaMb: e.quota !== undefined ? Math.round(e.quota / 1e6) : null };
  } catch {
    // unknown
  }
  const b = useBridge.getState();
  const m = useMetrics.getState().current;
  return {
    app: APP_VERSION,
    browser: browserName(ua),
    platform: (typeof navigator !== 'undefined' && (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform) || (typeof navigator !== 'undefined' ? navigator.platform : process.platform),
    audio,
    bridge: { status: useStore.getState().bridgeStatus, port: b.port, remote: b.remote, serverVersion: b.serverVersion, problem: b.problem?.kind ?? null },
    permissions,
    storage,
    // Plugin names come from the plugins themselves (not from the song).
    plugins: {
      loaded: [...liveWams.values()].map((w) => (w as unknown as { descriptor?: { name?: string } }).descriptor?.name ?? 'plugin'),
      failed: [...wamErrors.values()].map((e) => e.slice(0, 160)),
    },
    metrics: { firstSoundMs: m.firstSoundMs, firstExportMs: m.firstExportMs },
    errors: recentErrors(),
  };
}

// ---------------------------------------------------------------- report

export function diagnosticsText(d: Diagnostics): string {
  const lines = [
    `OpenBand ${d.app} · ${d.browser} · ${d.platform}`,
    `Audio: ${d.audio.state}, ${d.audio.sampleRate ?? '?'} Hz, latency base ${d.audio.baseLatencyMs ?? '?'} ms / output ${d.audio.outputLatencyMs ?? '?'} ms`,
    `Bridge: ${d.bridge.status} (port ${d.bridge.port}${d.bridge.remote ? ', online demo' : ''}${d.bridge.serverVersion ? `, server ${d.bridge.serverVersion}` : ''}${d.bridge.problem ? `, problem: ${d.bridge.problem}` : ''})`,
    `Permissions: ${Object.entries(d.permissions).map(([k, v]) => `${k} ${v}`).join(', ')}`,
    `Storage: ${d.storage.usedMb ?? '?'} MB used of ${d.storage.quotaMb ?? '?'} MB`,
    `Plugins: ${d.plugins.loaded.length} loaded${d.plugins.loaded.length ? ` (${d.plugins.loaded.join(', ')})` : ''}, ${d.plugins.failed.length} failed${d.plugins.failed.length ? `: ${d.plugins.failed.join(' | ')}` : ''}`,
    `First sound: ${d.metrics.firstSoundMs ?? '-'} ms after load · first export: ${d.metrics.firstExportMs ?? '-'} ms`,
    `Recent errors (${d.errors.length}):`,
    ...d.errors.slice(-20).map((e) => `  ${new Date(e.at).toISOString().slice(11, 19)} ${e.message}`),
  ];
  return lines.join('\n');
}

/** A pre-filled GitHub issue: the diagnostics in a <details> block, nothing from the song. */
export function bugReportUrl(d: Diagnostics, title = ''): { url: string; body: string } {
  let text = diagnosticsText(d);
  // Keep the URL under what browsers and GitHub accept.
  if (text.length > 5000) text = text.slice(0, 5000) + '\n…';
  const body = `<details><summary>Diagnostics</summary>\n\n\`\`\`\n${text}\n\`\`\`\n</details>`;
  const q = new URLSearchParams({ template: 'bug.yml', title: title || '[bug] ', diagnostics: body });
  return { url: `https://github.com/${REPO}/issues/new?${q}`, body };
}
