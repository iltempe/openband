// What a release says about itself: its section of the CHANGELOG, or a notes file written for people. Pure.
const REPO = 'https://github.com/iltempe/openband';

export const releaseUrl = (version) => `${REPO}/releases/tag/v${version}`;

export function changelogSection(text, version) {
  const start = text.indexOf(`## v${version} `);
  if (start < 0) return null;
  const end = text.indexOf('\n## v', start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

const plain = (s) => s.replace(/\*\*/g, '').replace(/`/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim();

/** The title and the first bullets that say what people get: what's missing and how it was tested stay out. */
export function fromChangelog(text, version) {
  const section = changelogSection(text, version);
  if (!section) throw new Error(`No CHANGELOG section for v${version}`);
  const title = /^## v\S+ "(.+)"/.exec(section)?.[1] ?? `v${version}`;
  const skip = /^(tests?:|deviations?|not (done|tested|tried|checked)|fixed|mcp:|new dependency|v0\.\d+\.\d+ below)/i;
  const points = section
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => plain(l.slice(2)))
    .filter((l) => !skip.test(l))
    .slice(0, 4);
  return { title, points };
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Telegram HTML, inside its limit of 4096 characters. */
export function telegramMessage({ version, title, points }) {
  const body = points.map((p) => `• ${esc(p)}`).join('\n');
  const head = `<b>OpenBand v${esc(version)}</b>\n${esc(title)}\n\n`;
  const foot = `\n\n<a href="${releaseUrl(version)}">Download su GitHub</a>`;
  const room = 4096 - head.length - foot.length;
  return head + (body.length > room ? `${body.slice(0, room - 1)}…` : body) + foot;
}

/** A point cut for a screen: one or two short lines. */
export function shortPoint(p, max = 110) {
  const first = p.split(/(?<=[.:;])\s/)[0].replace(/[.:;]$/, '');
  return first.length <= max ? first : `${first.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
}
