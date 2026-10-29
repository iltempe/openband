// Why a native plugin didn't answer in time (or didn't load): looked at before its host process is killed,
// so the user gets a reason and something to do instead of "did not answer". Big instruments (Arturia's
// Analog Lab, Kontakt libraries…) can take long the first time, wait on an activation window, or be built
// for the other CPU; each looks different from outside:
//   busy   the process was working (CPU) when the limit ran out → give it more time
//   idle   alive but doing nothing → it is waiting: a licence/activation window, a dialog, the network
//   arch   its binary has no slice for this computer's CPU → it can never load here
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

/** CPU (%) and memory (MB) of a process, sampled twice ~0.8 s apart (null where `ps` isn't there). */
export async function sampleProcess(pid, { waitMs = 800 } = {}) {
  if (!pid || process.platform === 'win32') return null;
  const once = () =>
    new Promise((ok) =>
      execFile('ps', ['-o', '%cpu=,rss=', '-p', String(pid)], { timeout: 2000 }, (err, out) => {
        const [cpu, rss] = String(out ?? '').trim().split(/\s+/).map(Number);
        ok(err || !Number.isFinite(cpu) ? null : { cpu, memMb: Math.round((rss || 0) / 1024) });
      }),
    );
  const a = await once();
  if (!a) return null;
  await new Promise((ok) => setTimeout(ok, waitMs));
  const b = await once();
  return b ? { cpu: Math.max(a.cpu, b.cpu), memMb: b.memMb } : a;
}

const CPU = { 0x01000007: 'x86_64', 0x0100000c: 'arm64', 7: 'i386', 12: 'arm' };
/** The CPU architectures of a Mach-O file (thin or universal); [] when it isn't one. */
export function machoArchs(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const h = Buffer.alloc(8 + 20 * 8);
    const n = fs.readSync(fd, h, 0, h.length, 0);
    if (n < 8) return [];
    const be = h.readUInt32BE(0);
    if (be === 0xcafebabe || be === 0xcafebabf) {
      const count = Math.min(h.readUInt32BE(4), 8);
      const step = be === 0xcafebabf ? 32 : 20;
      const out = [];
      for (let i = 0; i < count && 8 + i * step + 4 <= n; i++) out.push(CPU[h.readUInt32BE(8 + i * step)] ?? 'other');
      return out;
    }
    const le = h.readUInt32LE(0);
    if (le === 0xfeedfacf || le === 0xfeedface) return [CPU[h.readUInt32LE(4)] ?? 'other'];
    return [];
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The bundle's Info.plist (XML ones; binary plists give {}): identifier, executable, name. */
function infoOf(bundle) {
  try {
    const xml = fs.readFileSync(path.join(bundle, 'Contents', 'Info.plist'), 'utf8');
    const key = (k) => new RegExp(`<key>${k}</key>\\s*<string>([^<]*)</string>`).exec(xml)?.[1];
    return { id: key('CFBundleIdentifier'), exe: key('CFBundleExecutable'), name: key('CFBundleName') };
  } catch {
    return {};
  }
}

/** The binary inside a macOS bundle (.vst3/.clap/.component), or the file itself. */
export function bundleBinary(bundle) {
  try {
    if (!fs.statSync(bundle).isDirectory()) return bundle;
    const dir = path.join(bundle, 'Contents', 'MacOS');
    const exe = infoOf(bundle).exe;
    if (exe && fs.existsSync(path.join(dir, exe))) return path.join(dir, exe);
    const first = fs.readdirSync(dir).find((f) => !f.startsWith('.'));
    return first ? path.join(dir, first) : null;
  } catch {
    return null;
  }
}

/** Vendors whose plugins need their own app to activate them, and what to do. */
const VENDORS = [
  { re: /arturia/i, vendor: 'Arturia', manager: 'Arturia Software Center', hint: 'Open Arturia Software Center, check the instrument is activated on this computer, and start it once on its own (the standalone app) so it finishes its first setup.' },
  { re: /native[- ]?instruments|\bni\b|kontakt|massive|komplete/i, vendor: 'Native Instruments', manager: 'Native Access', hint: 'Open Native Access and check the product is activated and its library is installed and located.' },
  { re: /waves/i, vendor: 'Waves', manager: 'Waves Central', hint: 'Open Waves Central and check the licence is on this computer (or on a connected USB drive).' },
  { re: /izotope/i, vendor: 'iZotope', manager: 'Native Access / iZotope Product Portal', hint: 'Authorize it in Native Access (or the iZotope Product Portal).' },
  { re: /spectrasonics|omnisphere|keyscape/i, vendor: 'Spectrasonics', manager: 'its authorization window', hint: 'Open it once in another host or standalone to complete the authorization, and check its STEAM library folder is found.' },
  { re: /pace|ilok|avid/i, vendor: 'iLok-protected', manager: 'iLok License Manager', hint: 'Open iLok License Manager and check the licence is on this computer or a connected iLok.' },
  { re: /ujam|toontrack|superior|ezdrummer|ezkeys/i, vendor: 'Toontrack/UJAM', manager: 'its product manager', hint: 'Check the product is authorized in its own manager and its sound library is installed.' },
];

export function vendorOf(bundle) {
  const info = infoOf(bundle);
  const text = `${info.id ?? ''} ${info.name ?? ''} ${bundle}`;
  const v = VENDORS.find((x) => x.re.test(text));
  return v ? { vendor: v.vendor, manager: v.manager, hint: v.hint, id: info.id } : { id: info.id };
}

/** The architecture this computer's plugin host runs as. */
export const hostArch = () => (process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x86_64' : process.arch);

/** A plugin built without a slice for this CPU: why it can't load, or null. */
export function archMismatch(bundle, arch = hostArch()) {
  if (process.platform !== 'darwin' && !process.env.OPENBAND_DIAG_FORCE_MACHO) return null;
  const bin = bundleBinary(bundle);
  const archs = bin ? machoArchs(bin) : [];
  if (!archs.length || archs.includes(arch)) return null;
  const name = { x86_64: 'Intel (x86_64)', arm64: 'Apple Silicon (arm64)' };
  return {
    archs,
    text: `it is built for ${archs.map((a) => name[a] ?? a).join(' and ')} only, and OpenBand's plugin host runs as ${name[arch] ?? arch} — the two can't share a process (Rosetta translates whole apps, not plugins inside one)`,
    hint: `Install the ${name[arch] ?? arch} (or Universal) version from the vendor; most current plugins have one.`,
  };
}

/**
 * Look at a stalled plugin host before it is killed. phase: what it was doing ("scanning", "loading",
 * "opening its window"…); limitMs: the time it had. Returns { state, text, hints, cpu, memMb, vendor }.
 */
export async function diagnoseStall({ pid, bundle, phase = 'loading', limitMs, stderr = '' } = {}) {
  const secs = Math.round(limitMs / 1000);
  const arch = bundle ? archMismatch(bundle) : null;
  const v = bundle ? vendorOf(bundle) : {};
  const s = await sampleProcess(pid);
  const tail = String(stderr).trim().split('\n').filter(Boolean).slice(-2).join(' · ').slice(0, 300);
  const hints = [];
  let state;
  let text;
  if (arch) {
    state = 'arch';
    text = `It can't load on this computer: ${arch.text}.`;
    hints.push(arch.hint);
  } else if (!s) {
    state = 'unknown';
    text = `It did not answer in ${secs} s while ${phase}.`;
    if (v.hint) hints.push(v.hint);
    hints.push('Retry gives it three times as long. If it never answers, start it once in its own app or another host, then retry.');
  } else if (s.cpu >= 10) {
    state = 'busy';
    text = `It did not finish ${phase} in ${secs} s, but it was still working (CPU ${Math.round(s.cpu)}%, ${s.memMb} MB): big instruments load their sound library or build a cache the first time.`;
    hints.push('Retry: it gets three times as long, and the next starts are usually much faster.');
    if (v.hint) hints.push(v.hint);
  } else {
    state = 'idle';
    text = `It stopped ${phase} and waited for ${secs} s doing nothing (CPU ${Math.round(s.cpu)}%): it is waiting for something — usually an activation or licence window${v.manager ? ` (${v.manager})` : ''}, a dialog hidden behind other windows, or a network check.`;
    hints.push(v.hint ?? 'Look for a window of the plugin or its vendor behind the others; check the plugin is activated in its vendor\'s app.');
    hints.push('Then Retry (with three times as long).');
  }
  if (tail) text += ` Last message from it: “${tail}”.`;
  return { state, text, hints, ...(s ?? {}), ...(v.vendor ? { vendor: v.vendor } : {}) };
}
