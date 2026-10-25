// Voice commands (SPEC v0.6 G4): a small fixed grammar in Italian and English — commands, numbers and the
// song's section names — so a small offline recognizer (Vosk) is reliable. The recognizer is given the
// vocabulary; this file turns what it heard into a studio command. Pure.

export type Lang = 'it' | 'en';

export type VoiceCommand =
  | { action: 'record' }
  | { action: 'stop' }
  | { action: 'again' }
  | { action: 'playback' }
  | { action: 'from_section'; kind: string; ordinal?: number }
  | { action: 'from_bar'; bar: number }
  | { action: 'loop_section'; kind: string; ordinal?: number }
  | { action: 'loop_off' }
  | { action: 'punch'; from: number; to: number }
  | { action: 'flub' }
  | { action: 'good' }
  | { action: 'keep_take' }
  | { action: 'delete_last_take' }
  | { action: 'metronome'; change: 'louder' | 'softer' | 'off' | 'on' }
  | { action: 'tempo'; bpm?: number; delta?: number }
  | { action: 'monitor'; target: 'input' | 'playback'; delta: number }
  | { action: 'undo' }
  | { action: 'session'; kind?: string; ordinal?: number; passes?: number }
  | { action: 'session_stop' };

// ---------------------------------------------------------------- numbers
const IT_UNITS = ['zero', 'uno', 'due', 'tre', 'quattro', 'cinque', 'sei', 'sette', 'otto', 'nove'];
const IT_TEENS = ['dieci', 'undici', 'dodici', 'tredici', 'quattordici', 'quindici', 'sedici', 'diciassette', 'diciotto', 'diciannove'];
const IT_TENS = ['', '', 'venti', 'trenta', 'quaranta', 'cinquanta', 'sessanta', 'settanta', 'ottanta', 'novanta'];
const EN_UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const EN_TEENS = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** An Italian number word as spoken (1–299): "ventuno", "centoventi", "duecentoquaranta". */
export function itNumber(n: number): string {
  if (n >= 100) {
    const h = Math.floor(n / 100);
    const rest = n % 100;
    return (h === 1 ? 'cento' : `${IT_UNITS[h]}cento`) + (rest ? itNumber(rest) : '');
  }
  if (n < 10) return IT_UNITS[n];
  if (n < 20) return IT_TEENS[n - 10];
  const t = IT_TENS[Math.floor(n / 10)];
  const u = n % 10;
  if (!u) return t;
  // venti + uno → ventuno, trenta + otto → trentotto (the tens' vowel drops before uno and otto)
  return (u === 1 || u === 8 ? t.slice(0, -1) : t) + IT_UNITS[u];
}
export function enNumber(n: number): string {
  if (n >= 100) {
    const h = Math.floor(n / 100);
    const rest = n % 100;
    return `${h === 1 ? 'one' : EN_UNITS[h]} hundred${rest ? ` ${enNumber(rest)}` : ''}`;
  }
  if (n < 10) return EN_UNITS[n];
  if (n < 20) return EN_TEENS[n - 10];
  const u = n % 10;
  return EN_TENS[Math.floor(n / 10)] + (u ? ` ${EN_UNITS[u]}` : '');
}

const MAX = 299;
const numberTable = (lang: Lang) => {
  const m = new Map<string, number>();
  for (let n = 1; n <= MAX; n++) m.set((lang === 'it' ? itNumber(n) : enNumber(n)).replace(/\s+/g, ' '), n);
  return m;
};
const TABLES: Record<Lang, Map<string, number>> = { it: numberTable('it'), en: numberTable('en') };

/** Read numbers out of words: digits, one word ("centoventi") or several ("cento venti", "one hundred twenty"). */
export function readNumbers(words: string[], lang: Lang): { at: number; len: number; value: number }[] {
  const table = TABLES[lang];
  const out: { at: number; len: number; value: number }[] = [];
  for (let i = 0; i < words.length; ) {
    if (/^\d+$/.test(words[i])) {
      out.push({ at: i, len: 1, value: Number(words[i]) });
      i++;
      continue;
    }
    // The longest run of words that is a number, glued (Italian) or spaced (English).
    let best: { len: number; value: number } | null = null;
    for (let len = Math.min(4, words.length - i); len >= 1; len--) {
      const run = words.slice(i, i + len);
      const v = table.get(run.join(' ')) ?? table.get(run.join(''));
      if (v !== undefined) {
        best = { len, value: v };
        break;
      }
    }
    if (best) {
      out.push({ at: i, ...best });
      i += best.len;
    } else i++;
  }
  return out;
}

// ---------------------------------------------------------------- sections
/** Section kinds and how each language says them. */
export const SECTION_WORDS: Record<Lang, Record<string, string[]>> = {
  it: { intro: ['intro', 'introduzione'], verse: ['strofa'], prechorus: ['prechorus', 'pre ritornello', 'preritornello'], chorus: ['ritornello', 'chorus'], bridge: ['bridge', 'ponte'], solo: ['assolo', 'solo'], outro: ['finale', 'outro', 'coda'], break: ['break', 'pausa'] },
  en: { intro: ['intro'], verse: ['verse'], prechorus: ['pre chorus', 'prechorus'], chorus: ['chorus', 'refrain'], bridge: ['bridge'], solo: ['solo'], outro: ['outro', 'ending'], break: ['break'] },
};
const ORDINALS: Record<Lang, string[]> = { it: ['', 'prima', 'seconda', 'terza', 'quarta', 'quinta'], en: ['', 'first', 'second', 'third', 'fourth', 'fifth'] };

function findSection(text: string, lang: Lang): { kind: string; ordinal?: number } | null {
  for (const [kind, names] of Object.entries(SECTION_WORDS[lang])) {
    for (const name of names) {
      const at = text.indexOf(name);
      if (at < 0 || !new RegExp(`(^|\\s|')${name}(\\s|$)`).test(text)) continue;
      const before = text.slice(0, at).trim().split(/\s+/).at(-1) ?? '';
      const after = text.slice(at + name.length).trim().split(/\s+/);
      let ordinal = ORDINALS[lang].indexOf(before);
      if (ordinal < 1) {
        const n = readNumbers(after.slice(0, 2), lang)[0];
        ordinal = n && n.at === 0 ? n.value : -1;
      }
      return ordinal > 0 ? { kind, ordinal } : { kind };
    }
  }
  return null;
}

// ---------------------------------------------------------------- the grammar
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[àá]/g, 'a')
    .replace(/[èé]/g, 'e')
    .replace(/[ìí]/g, 'i')
    .replace(/[òó]/g, 'o')
    .replace(/[ùú]/g, 'u')
    .replace(/(\w)'(\w)/g, '$1 $2')
    .replace(/[^\p{L}\d' ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const has = (t: string, ...ps: string[]) => ps.some((p) => new RegExp(`(^| )${p}( |$)`).test(t));

/** What a phrase asks the studio for, or null (not a command: it can go to the AI). */
export function parseCommand(heard: string, lang: Lang): VoiceCommand | null {
  const t = norm(heard);
  if (!t) return null;
  const words = t.split(' ');
  const nums = readNumbers(words, lang).map((n) => n.value);
  if (lang === 'it') {
    if (has(t, 'basta cosi', 'basta', 'fine sessione')) return { action: 'session_stop' };
    if (has(t, 'sessione')) return { action: 'session', ...(findSection(t, lang) ?? {}), ...(nums.length && /passaggi|volte|giri/.test(t) ? { passes: nums.at(-1) } : {}) };
    if (has(t, 'annulla')) return { action: 'undo' };
    if (has(t, 'segna errore', 'errore', 'sbagliato')) return { action: 'flub' };
    if (has(t, 'buona questa', 'buona', 'perfetta')) return { action: 'good' };
    if (has(t, 'tieni questa', 'tieni')) return { action: 'keep_take' };
    if (has(t, 'cancella') && has(t, 'take', 'ultima')) return { action: 'delete_last_take' };
    if (has(t, 'metronomo', 'click', 'clic')) {
      if (has(t, 'via', 'spento', 'spegni', 'togli')) return { action: 'metronome', change: 'off' };
      if (has(t, 'forte', 'alto')) return { action: 'metronome', change: 'louder' };
      if (has(t, 'piano', 'basso')) return { action: 'metronome', change: 'softer' };
      return { action: 'metronome', change: 'on' };
    }
    if (has(t, 'tempo') && nums.length) return { action: 'tempo', bpm: nums[0] };
    if (has(t, 'piu lento', 'lento', 'rallenta')) return { action: 'tempo', delta: -5 };
    if (has(t, 'piu veloce', 'veloce', 'accelera')) return { action: 'tempo', delta: 5 };
    if (has(t, 'cuffia', 'cuffie', 'me')) {
      if (has(t, 'piu me', 'piu io')) return { action: 'monitor', target: 'input', delta: 3 };
      if (has(t, 'meno me', 'meno io')) return { action: 'monitor', target: 'input', delta: -3 };
    }
    if (has(t, 'basi', 'base')) return { action: 'monitor', target: 'playback', delta: has(t, 'piu') ? 3 : -3 };
    // "punch" is English: the Italian model may drop it, "dalla nove alla dodici" is enough.
    if ((has(t, 'punch') || (has(t, 'alla', 'a') && has(t, 'dalla', 'da'))) && nums.length >= 2) return { action: 'punch', from: nums[0], to: nums.at(-1)! };
    if (has(t, 'loop', 'ciclo', 'cicla')) {
      if (has(t, 'via', 'togli', 'spegni', 'basta')) return { action: 'loop_off' };
      const s = findSection(t, lang);
      if (s) return { action: 'loop_section', ...s };
    }
    if (has(t, 'battuta') && nums.length) return { action: 'from_bar', bar: nums[0] };
    // "dal ritornello" — or just "ritornello": a section said on its own means go there.
    const sec = findSection(t, lang);
    if (sec && (/(^| )(dal|dalla|dall|dallo|da|vai al|vai alla)( |$)/.test(t) || words.length <= 3)) return { action: 'from_section', ...sec };
    if (has(t, 'registra', 'rec', 'registriamo')) return { action: 'record' };
    if (has(t, 'riascolta', 'riascoltiamo', 'fammi sentire')) return { action: 'playback' };
    if (has(t, 'ancora', 'di nuovo', 'rifacciamo', 'daccapo')) return { action: 'again' };
    if (has(t, 'stop', 'ferma', 'fermati', 'alt')) return { action: 'stop' };
    return null;
  }
  if (has(t, "that's enough", 'thats enough', 'enough', 'end session', 'stop session')) return { action: 'session_stop' };
  if (has(t, 'session')) return { action: 'session', ...(findSection(t, lang) ?? {}), ...(nums.length && /passes|takes|times/.test(t) ? { passes: nums.at(-1) } : {}) };
  if (has(t, 'undo')) return { action: 'undo' };
  if (has(t, 'mark error', 'mark mistake', 'mistake', 'error')) return { action: 'flub' };
  if (has(t, 'good one', "that's good", 'thats good', 'good take', 'good')) return { action: 'good' };
  if (has(t, 'keep this', 'keep it', 'keep')) return { action: 'keep_take' };
  if (has(t, 'delete', 'remove', 'scrap') && has(t, 'take', 'last')) return { action: 'delete_last_take' };
  if (has(t, 'metronome', 'click')) {
    if (has(t, 'off')) return { action: 'metronome', change: 'off' };
    if (has(t, 'louder', 'up')) return { action: 'metronome', change: 'louder' };
    if (has(t, 'softer', 'quieter', 'down')) return { action: 'metronome', change: 'softer' };
    return { action: 'metronome', change: 'on' };
  }
  if (has(t, 'tempo') && nums.length) return { action: 'tempo', bpm: nums[0] };
  if (has(t, 'slower', 'slow down')) return { action: 'tempo', delta: -5 };
  if (has(t, 'faster', 'speed up')) return { action: 'tempo', delta: 5 };
  if (has(t, 'more me', 'me up')) return { action: 'monitor', target: 'input', delta: 3 };
  if (has(t, 'less me', 'me down')) return { action: 'monitor', target: 'input', delta: -3 };
  if (has(t, 'track', 'tracks', 'backing')) {
    if (has(t, 'more')) return { action: 'monitor', target: 'playback', delta: 3 };
    if (has(t, 'less')) return { action: 'monitor', target: 'playback', delta: -3 };
  }
  if (has(t, 'punch') && nums.length >= 2) return { action: 'punch', from: nums[0], to: nums.at(-1)! };
  if (has(t, 'loop', 'cycle')) {
    if (has(t, 'off', 'stop')) return { action: 'loop_off' };
    const s = findSection(t, lang);
    if (s) return { action: 'loop_section', ...s };
  }
  if (has(t, 'bar', 'measure') && nums.length) return { action: 'from_bar', bar: nums[0] };
  const sec = findSection(t, lang);
  if (sec && (has(t, 'from', 'go to') || words.length <= 3)) return { action: 'from_section', ...sec };
  if (has(t, 'record', 'recording')) return { action: 'record' };
  if (has(t, 'play back', 'playback', 'listen back', 'play it back')) return { action: 'playback' };
  if (has(t, 'again', 'one more', 'once more')) return { action: 'again' };
  if (has(t, 'stop', 'hold on')) return { action: 'stop' };
  return null;
}

/** The phrases that go to the recognizer: every command phrase, the numbers, the song's section words. */
export function vocabulary(lang: Lang, extraWords: string[] = []): string[] {
  const it = [
    'registra', 'stop', 'ferma', 'ancora', 'di nuovo', 'riascolta', 'dal', 'dalla', 'dall', 'battuta', 'loop', 'sul', 'sulla', 'via', 'togli',
    'punch', 'alla', 'segna errore', 'buona questa', 'tieni questa', "cancella l'ultima take", 'metronomo', 'più forte', 'più piano', 'più lento',
    'più veloce', 'tempo', 'più me in cuffia', 'meno me in cuffia', 'più basi', 'meno basi', 'annulla', 'sessione', 'passaggi', 'basta così',
    ...ORDINALS.it.filter(Boolean), ...Object.values(SECTION_WORDS.it).flat(),
  ];
  const en = [
    'record', 'stop', 'again', 'play back', 'from', 'the', 'bar', 'loop', 'off', 'punch', 'to', 'mark error', 'good one', 'keep this one', 'delete the last take',
    'metronome', 'louder', 'softer', 'slower', 'faster', 'tempo', 'more me', 'less me', 'more track', 'less track', 'undo', 'session', 'on', 'passes', "that's enough",
    ...ORDINALS.en.filter(Boolean), ...Object.values(SECTION_WORDS.en).flat(),
  ];
  const numbers = Array.from({ length: MAX }, (_, i) => (lang === 'it' ? itNumber(i + 1) : enNumber(i + 1)));
  return [...new Set([...(lang === 'it' ? it : en), ...numbers, ...extraWords.map(norm).filter(Boolean)])];
}

/** How the studio says, back, what it understood (for the spoken feedback and the toast). */
export const COMMANDS_HELP: Record<Lang, string> = {
  it: 'registra · stop · ancora · riascolta · dal ritornello · dalla battuta nove · loop sul ritornello · punch dalla nove alla dodici · segna errore · buona questa · tieni questa · cancella l’ultima take · metronomo più forte / più piano / via · più lento · tempo novanta · più me in cuffia · meno basi · annulla',
  en: 'record · stop · again · play back · from the chorus · from bar nine · loop the chorus · punch from nine to twelve · mark error · good one · keep this one · delete the last take · metronome louder / softer / off · slower · tempo ninety · more me · less track · undo',
};
