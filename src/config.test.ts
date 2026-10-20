import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, connectTabs, parseConfig } from './config';

describe('instance config', () => {
  it('falls back to the defaults for anything missing or malformed', () => {
    expect(parseConfig(null)).toEqual(DEFAULT_CONFIG);
    expect(parseConfig({ features: { byoKey: 'no' }, defaultLanguage: 'fr', instanceName: '  ' })).toEqual(DEFAULT_CONFIG);
  });

  it('features.byoKey=false hides the API key option', () => {
    const c = parseConfig({ instanceName: 'Liceo Musicale', defaultLanguage: 'it', features: { byoKey: false }, collabServer: { relay: 'wss://music.school/collab', signaling: ['wss://music.school/signal', 3] } });
    expect(connectTabs(c.features)).toEqual(['desktop', 'cli']);
    expect(connectTabs(DEFAULT_CONFIG.features)).toEqual(['desktop', 'cli', 'key']);
    expect(connectTabs(DEFAULT_CONFIG.features, true)).toEqual(['remote', 'desktop', 'cli', 'key']);
    expect(parseConfig({ remoteMcp: true }).remoteMcp).toBe(true);
    expect(parseConfig({ remoteMcp: 'yes' }).remoteMcp).toBe(false);
    expect(c).toMatchObject({ instanceName: 'Liceo Musicale', defaultLanguage: 'it', collabServer: { relay: 'wss://music.school/collab', signaling: ['wss://music.school/signal'] } });
  });
});
