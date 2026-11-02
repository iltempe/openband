// Reachable from the internet with a tunnel the musician chose and set up: cloudflared or Tailscale Funnel.
// OpenBand offers no infrastructure of its own.
import { spawn } from 'node:child_process';

export const tunnelCommand = (kind, port) => (kind === 'tailscale' ? { cmd: 'tailscale', args: ['funnel', String(port)] } : { cmd: 'cloudflared', args: ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`] });

export const tunnelUrl = (text) => /https:\/\/[\w.-]+\.(trycloudflare\.com|ts\.net|cfargotunnel\.com)\S*/.exec(text)?.[0] ?? null;

export function startTunnel(kind, port, { onUrl, onError = () => {}, spawnFn = spawn }) {
  if (!['cloudflared', 'tailscale'].includes(kind)) throw new Error('--tunnel: cloudflared or tailscale');
  const { cmd, args } = tunnelCommand(kind, port);
  const child = spawnFn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', () => onError(`${cmd} is not installed`));
  const read = (d) => {
    const url = tunnelUrl(String(d));
    if (url) onUrl(url);
  };
  child.stdout.on('data', read);
  child.stderr.on('data', read);
  return () => child.kill();
}
