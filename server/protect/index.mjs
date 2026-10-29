// Timestamps from the local OpenBand (SPEC v0.6 G7): the page sends a manifest's SHA-256 (32 bytes) and gets
// back the .ots proof; later it asks to upgrade or verify it. The calendars don't accept requests from web
// pages (no CORS), so this runs here. Calendars and block explorer can be changed (tests, a private node):
// OPENBAND_OTS_CALENDARS (comma-separated), OPENBAND_OTS_EXPLORER (an Esplora API).
import { DEFAULT_CALENDARS, parseOts, serializeOts, stamp, summarize, upgrade, verifyBitcoin } from './ots.mjs';

export class ProtectHost {
  constructor({ env = process.env, fetchImpl = fetch } = {}) {
    this.calendars = env.OPENBAND_OTS_CALENDARS ? env.OPENBAND_OTS_CALENDARS.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_CALENDARS;
    this.explorer = env.OPENBAND_OTS_EXPLORER || 'https://blockstream.info/api';
    this.fetch = fetchImpl;
  }

  async handle(msg) {
    switch (msg.op) {
      case 'stamp': {
        const digest = Buffer.from(String(msg.digest ?? ''), 'hex');
        if (digest.length !== 32) throw new Error('Send the SHA-256 of the manifest (32 bytes, hex)');
        const r = await stamp(digest, { calendars: this.calendars, fetchImpl: this.fetch });
        return { ots: serializeOts(r.timestamp).toString('base64'), ...summarize(r.timestamp), answered: r.calendars };
      }
      case 'upgrade': {
        const t = parseOts(Buffer.from(String(msg.ots ?? ''), 'base64'));
        const changed = await upgrade(t, { fetchImpl: this.fetch });
        return { ots: serializeOts(t).toString('base64'), changed, ...summarize(t) };
      }
      case 'verify': {
        const t = parseOts(Buffer.from(String(msg.ots ?? ''), 'base64'));
        if (msg.digest && t.msg.toString('hex') !== String(msg.digest).toLowerCase()) return { verified: false, reason: 'This proof is for another file: its SHA-256 differs', proofDigest: t.msg.toString('hex') };
        // A pending proof may have been confirmed since: try once before answering.
        if (summarize(t).state === 'pending') await upgrade(t, { fetchImpl: this.fetch }).catch(() => false);
        const v = await verifyBitcoin(t, { explorer: this.explorer, fetchImpl: this.fetch });
        return { ...v, digest: t.msg.toString('hex'), ots: serializeOts(t).toString('base64') };
      }
      default:
        throw new Error(`Unknown protect op "${msg.op}"`);
    }
  }
}
