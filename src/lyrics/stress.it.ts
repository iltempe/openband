// Italian word stress and lexical hiatus. Italian writes the accent only on final stressed vowels,
// so stress elsewhere comes from rules plus a small dictionary.

/** Words stressed on the antepenultimate syllable (sdrucciole), common in lyrics. */
export const SDRUCCIOLE = new Set(
  `anima lacrima musica medico subito ultimo unico timido magico logico tragico comico numero pagina rapido semplice facile difficile utile inutile fragile debole nobile mobile piccolo angelo tavolo popolo secolo titolo giovane polvere cenere lucido limpido splendido candido morbido gelido tiepido umido stupido libero albero zucchero sabato domenica america africa fisica chimica pratica tecnica critica politica replica favola nuvola isola regola camera opera epoca lettera macchina monaca vergine ordine origine immagine margine termine cardine pettine femmina fragola pentola scatola tavola ciotola vipera venere genere essere credere vivere scrivere leggere perdere piangere ridere chiedere correre muovere nascere crescere conoscere rendere prendere scendere spendere chiudere mettere battere rompere spingere vincere dipingere giungere fingere cogliere scegliere togliere sciogliere accendere attendere difendere offendere intendere sorridere uccidere decidere dividere ripetere esplodere spremere smettere telefono semaforo cinema parlano cantano amano ballano guardano pensano sognano tornano restano chiamano aspettano vivono dicono scrivono leggono corrono piangono ridono credono perdono vincono chiedono partono sentono dormono aprono offrono soffrono tremano brillano volano cadono passano lasciano portano mostrano cercano trovano baciano stringono spengono accendono nascondono rispondono ascoltano camminano diventano ricordano dimenticano ultima unica splendida limpida tiepida gelida candida morbida fragili semplici difficili facili piccola piccoli piccole angeli lacrime anime numeri pagine isole favole nuvole lettere immagini macchine attimo attimi brivido brividi palpito fremito spirito spiriti ostacolo miracolo spettacolo pericolo vincolo circolo muscolo gomito orecchio? stomaco portico tempio? elica sindaco epico ipnotico romantico malinconico melanconico fantastico elettrico armonico acustico ritmico lirico mistico esotico erotico eroico ironico simpatico antipatico automatico pratico satirico storico estatico statico ecologico psicologo psicologa archeologo gotico pubblico pubblica quindici dodici tredici undici quattordici sedici`
    .split(/\s+/)
    .filter((w) => !w.endsWith('?')),
);

/** -ere infinitives stressed on -ére (most -ere verbs are stressed on the root instead). */
const ERE_PIANE = new Set('vedere avere potere sapere volere dovere tenere piacere dispiacere cadere temere sedere godere tacere parere valere rimanere ottenere mantenere sostenere trattenere possedere prevedere persuadere giacere tenere avvenire'.split(' '));

/**
 * Words whose i/u is stressed and therefore in hiatus with the next vowel, written as syllables.
 * (Orthography can't tell "mio" from "fiore": the accent isn't written.)
 */
export const HIATUS: Record<string, string> = Object.fromEntries(
  `pa-u-ra mi-o mi-a mi-e tu-o tu-a tu-e su-o su-a su-e zi-o zi-a vi-a vi-e i-o di-o ad-di-o ma-gi-a fol-li-a no-stal-gi-a al-le-gri-a fan-ta-si-a po-e-si-a ma-lin-co-ni-a me-lan-co-ni-a com-pa-gni-a e-ner-gi-a bu-gi-a ge-lo-si-a paz-zi-a po-li-zi-a ma-ri-a lu-ci-a so-fi-a far-ma-ci-a gal-le-ri-a me-lo-di-a ar-mo-ni-a sin-fo-ni-a fi-lo-so-fi-a geo-gra-fi-a fo-to-gra-fi-a de-mo-cra-zi-a mor-mo-ri-o bru-si-o o-bli-o de-si-o pen-di-o lo-gi-o tri-o ri-o pi-o scin-til-li-o ma-lat-ti-a sim-pa-ti-a an-ti-pa-ti-a e-re-si-a cor-te-si-a ip-po-cri-si-a ma-ni-a e-u-fo-ri-a a-go-ni-a e-co-no-mi-a teo-ri-a a-ve-ma-ri-a ma-li-a scia-gu-ra? ba-u-le ra-di-o? lu-i-gi`
    .split(/\s+/)
    .filter((w) => !w.endsWith('?'))
    .map((h) => [h.replace(/-/g, ''), h]),
);

const ACCENTED = /[àèéìíòóùú]/;

/**
 * Index of the stressed syllable of a word, given its syllables.
 * Priority: forced (ˈ before a syllable, or an uppercase syllable in a lowercase word),
 * written accent, dictionary, rules (-ere infinitives), then the default: second to last.
 */
export function stressIndex(syllables: string[], word: string): number {
  const n = syllables.length;
  if (n <= 1) return 0;
  const forced = syllables.findIndex((s) => s.includes('ˈ'));
  if (forced >= 0) return forced;
  const isLowerWord = word.slice(1) !== word.slice(1).toUpperCase();
  if (isLowerWord) {
    const upper = syllables.findIndex((s, i) => (i > 0 || s.length > 1) && /[A-ZÀ-Ú]/.test(i === 0 ? s.slice(1) : s) && s.replace(/[^A-Za-zÀ-ú]/g, '') === s.replace(/[^A-Za-zÀ-ú]/g, '').toUpperCase());
    if (upper >= 0) return upper;
  }
  const acc = syllables.findIndex((s) => ACCENTED.test(s));
  if (acc >= 0) return acc;
  const w = word.toLowerCase().replace(/[^a-zàèéìíòóùú]/g, '');
  if (HIATUS[w]) {
    // In hiatus words the stressed i/u is the syllable made of that single vowel (or the one before the last).
    const single = syllables.findIndex((s, i) => i < n - 1 && /^[^aeo]*[iu]$/i.test(s.replace(/[^a-z]/gi, '')) && !/[aeo]/i.test(s));
    if (single >= 0) return single;
  }
  if (SDRUCCIOLE.has(w) && n >= 3) return n - 3;
  if (w.endsWith('ere') && n >= 3 && !ERE_PIANE.has(w)) return n - 3;
  return n - 2;
}
