// Licences for a release (SPEC v0.6 G6). Creative Commons is not a registry: a licence is declared on the
// work and published where it stays dated and visible. Three questions choose it; each licence says what
// it allows, where it can be published, and whether the material in the song allows it. Pure.

export type LicenseCode = 'all-rights-reserved' | 'CC0-1.0' | 'CC-BY-4.0' | 'CC-BY-SA-4.0' | 'CC-BY-NC-4.0' | 'CC-BY-ND-4.0' | 'CC-BY-NC-SA-4.0' | 'CC-BY-NC-ND-4.0';

export interface LicenseInfo {
  code: LicenseCode;
  name: string;
  url: string | null;
  cc: boolean;
  commercial: boolean;
  derivatives: boolean;
  shareAlike: boolean;
  attribution: boolean;
}

const cc = (code: LicenseCode, name: string, path: string, commercial: boolean, derivatives: boolean, shareAlike: boolean, attribution = true): LicenseInfo => ({ code, name, url: `https://creativecommons.org/${path}`, cc: true, commercial, derivatives, shareAlike, attribution });

export const LICENSES: Record<LicenseCode, LicenseInfo> = {
  'all-rights-reserved': { code: 'all-rights-reserved', name: 'All rights reserved', url: null, cc: false, commercial: false, derivatives: false, shareAlike: false, attribution: true },
  'CC0-1.0': cc('CC0-1.0', 'CC0 1.0 (public domain)', 'publicdomain/zero/1.0/', true, true, false, false),
  'CC-BY-4.0': cc('CC-BY-4.0', 'CC BY 4.0', 'licenses/by/4.0/', true, true, false),
  'CC-BY-SA-4.0': cc('CC-BY-SA-4.0', 'CC BY-SA 4.0', 'licenses/by-sa/4.0/', true, true, true),
  'CC-BY-NC-4.0': cc('CC-BY-NC-4.0', 'CC BY-NC 4.0', 'licenses/by-nc/4.0/', false, true, false),
  'CC-BY-ND-4.0': cc('CC-BY-ND-4.0', 'CC BY-ND 4.0', 'licenses/by-nd/4.0/', true, false, false),
  'CC-BY-NC-SA-4.0': cc('CC-BY-NC-SA-4.0', 'CC BY-NC-SA 4.0', 'licenses/by-nc-sa/4.0/', false, true, true),
  'CC-BY-NC-ND-4.0': cc('CC-BY-NC-ND-4.0', 'CC BY-NC-ND 4.0', 'licenses/by-nc-nd/4.0/', false, false, false),
};

/**
 * The three questions: may others use it commercially? may they change it? must changed versions keep
 * the same licence? (publicDomain: give up every right, CC0.)
 */
export function chooseLicense(a: { commercial: boolean; derivatives: boolean; shareAlike?: boolean; publicDomain?: boolean }): LicenseCode {
  if (a.publicDomain) return 'CC0-1.0';
  if (!a.derivatives) return a.commercial ? 'CC-BY-ND-4.0' : 'CC-BY-NC-ND-4.0';
  if (a.shareAlike) return a.commercial ? 'CC-BY-SA-4.0' : 'CC-BY-NC-SA-4.0';
  return a.commercial ? 'CC-BY-4.0' : 'CC-BY-NC-4.0';
}

/** Plain words, for the chooser and LICENSE.txt. */
export function explain(code: LicenseCode, lang: 'en' | 'it' = 'en'): string {
  const l = LICENSES[code];
  if (!l.cc) return lang === 'it' ? 'Tutti i diritti riservati: nessuno può usare il brano senza il tuo permesso.' : 'All rights reserved: nobody may use the track without your permission.';
  if (code === 'CC0-1.0') return lang === 'it' ? 'Pubblico dominio: chiunque può farne qualunque cosa, anche senza citarti.' : 'Public domain: anyone may do anything with it, even without crediting you.';
  const parts = lang === 'it'
    ? ['Chiunque può copiarlo e condividerlo citandoti', l.derivatives ? 'modificarlo' : 'ma non modificarlo', l.commercial ? 'anche per guadagnarci' : 'ma non per guadagnarci', l.shareAlike ? 'e le versioni modificate devono avere la stessa licenza' : '']
    : ['Anyone may copy and share it, crediting you', l.derivatives ? 'and change it' : 'but not change it', l.commercial ? 'even for money' : 'but not for money', l.shareAlike ? 'and changed versions must keep the same licence' : ''];
  return parts.filter(Boolean).join(', ') + '.';
}

export const IRREVOCABLE = { en: 'Creative Commons licences cannot be withdrawn for copies already shared.', it: 'Le licenze Creative Commons non si possono revocare per le copie già distribuite.' };
export const COLLECTING_SOCIETY = {
  en: 'If you are a member of a collecting society (SIAE, PRS, ASCAP…), check with it first: some limit Creative Commons licences, commercial ones above all.',
  it: 'Se sei iscritto a una società di gestione (SIAE, PRS, ASCAP…), verifica prima con lei: alcune limitano le licenze Creative Commons, soprattutto quelle commerciali.',
};

/** Where each licence can go (spec G6: Commons only free licences, YouTube only CC BY, the Archive needs CC). */
export function platformAccepts(platform: string, code: LicenseCode): { ok: boolean; why?: string } {
  const l = LICENSES[code];
  switch (platform) {
    case 'wikimedia':
      return ['CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0'].includes(code) ? { ok: true } : { ok: false, why: 'Wikimedia Commons takes only free licences: CC0, CC BY or CC BY-SA (no NC, no ND)' };
    case 'archive':
      return l.cc ? { ok: true } : { ok: false, why: 'The Internet Archive needs a Creative Commons licence for this kind of upload' };
    case 'youtube':
      return !l.cc || code === 'CC-BY-4.0' ? { ok: true } : { ok: false, why: 'YouTube offers only its standard licence or CC BY: choose one of them' };
    default:
      return { ok: true };
  }
}

/** Can material under `material` go into a song released under `release`? (null: yes; otherwise why not.) */
export function materialAllows(material: string, release: LicenseCode): string | null {
  const r = LICENSES[release];
  if (!r.cc) return null;
  const m = material.toUpperCase();
  if (/^CC0|PUBLIC|MIT|APACHE|BSD/.test(m)) return null;
  if (/ARR|ALL[ -]RIGHTS|UNKNOWN|PROPRIETARY/.test(m)) return 'its licence is unknown or all rights reserved';
  const nc = /NC/.test(m);
  const nd = /ND/.test(m);
  const sa = /SA/.test(m);
  if (nd) return 'it may not be changed (ND), and mixing it into a song changes it';
  if (nc && r.commercial) return 'it forbids commercial use (NC), and this licence allows it';
  if (sa && (!r.shareAlike || nc !== !r.commercial)) return 'it must be shared under the same licence (SA)';
  if (/BY/.test(m) && !r.attribution) return 'it requires attribution (BY), which CC0 gives up';
  return null;
}
