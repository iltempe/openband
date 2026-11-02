import { describe, expect, it, vi } from 'vitest';
import { changelogSection, fromChangelog, releaseUrl, shortPoint, telegramMessage } from './notes.mjs';
import { readConfig, sendMessage } from './telegram.mjs';

const LOG = `# Changelog

## v1.2.0 "A <big> one"

- **Songs** on your disk.
- Tests: 19 on the store.
- Deviations from the spec:
  - inner
- Not done yet: the panel.
- A [link](http://x) and \`code\`.

## v1.1.0 "Older"

- Old.
`;

describe('what a release says', () => {
  it('finds its section and only that', () => {
    expect(changelogSection(LOG, '1.2.0')).not.toContain('Old.');
    expect(changelogSection(LOG, '9.9.9')).toBeNull();
  });
  it('keeps what people get, not how it was tested', () => {
    expect(fromChangelog(LOG, '1.2.0')).toEqual({ title: 'A <big> one', points: ['Songs on your disk.', 'A link and code.'] });
  });
  it('links the release and escapes the text', () => {
    const m = telegramMessage({ version: '1.2.0', title: 'A <big> one', points: ['a & b'] });
    expect(m).toContain('A &lt;big&gt; one');
    expect(m).toContain('• a &amp; b');
    expect(m).toContain(`href="${releaseUrl('1.2.0')}"`);
    expect(releaseUrl('1.2.0')).toBe('https://github.com/iltempe/openband/releases/tag/v1.2.0');
  });
  it('stays inside Telegram\'s limit', () => expect(telegramMessage({ version: '1', title: 't', points: ['x'.repeat(9000)] }).length).toBeLessThanOrEqual(4096));
  it('cuts a point for the screen', () => {
    expect(shortPoint('Burn a cassette: sides and all. More after.')).toBe('Burn a cassette');
    expect(shortPoint(`${"word ".repeat(40)}`).length).toBeLessThanOrEqual(110);
  });
});

describe('Telegram', () => {
  it('reads the settings, or says there are none', () => {
    expect(readConfig({ OPENBAND_TELEGRAM_TOKEN: 't', OPENBAND_TELEGRAM_CHAT: '1' })).toEqual({ token: 't', chat: '1' });
    expect(readConfig({}, '/nonexistent')).toBeNull();
  });
  it('never puts the token in an error', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: false, description: 'chat not found' })));
    await expect(sendMessage({ token: 'SECRET', chat: '1' }, 'hi', fetcher as never)).rejects.toThrow('Telegram sendMessage: chat not found');
    await expect(sendMessage({ token: 'SECRET', chat: '1' }, 'hi', fetcher as never)).rejects.not.toThrow('SECRET');
  });
});
