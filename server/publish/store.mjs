// The user's publishing keys and tokens (SPEC v0.6 G6), on this computer only: ~/.openband/publish.json,
// readable by the user alone (0600). They never reach the page: it only learns what is set up.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const defaultPublishFile = () => process.env.OPENBAND_PUBLISH || path.join(os.homedir(), '.openband', 'publish.json');

export class PublishStore {
  constructor(file = defaultPublishFile()) {
    this.file = file;
  }
  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }
  write(all) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  get(platform) {
    return this.read()[platform] ?? {};
  }
  /** Merge into a platform's entry (null removes a key). */
  set(platform, patch) {
    const all = this.read();
    const next = { ...(all[platform] ?? {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined || v === '') delete next[k];
      else next[k] = v;
    }
    all[platform] = next;
    this.write(all);
    return next;
  }
  forget(platform) {
    const all = this.read();
    delete all[platform];
    this.write(all);
  }
}
