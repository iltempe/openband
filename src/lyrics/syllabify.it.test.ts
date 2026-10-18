import { describe, expect, it } from 'vitest';
import { metricSyllables, syllabifyLine, syllabifyWord } from './syllabify.it';

// Expected orthographic syllabification (standard Italian rules; hiatus where the i/u is stressed).
const WORDS = `
aiuola:a-iuo-la scienza:scien-za glicine:gli-ci-ne psicologo:psi-co-lo-go maggio:mag-gio perché:per-ché mangiare:man-gia-re paura:pa-u-ra pioggia:piog-gia
casa:ca-sa mare:ma-re sole:so-le luna:lu-na cuore:cuo-re amore:a-mo-re vita:vi-ta notte:not-te giorno:gior-no sera:se-ra mattina:mat-ti-na sempre:sem-pre
ancora:an-co-ra tempo:tem-po cielo:cie-lo terra:ter-ra acqua:ac-qua fuoco:fuo-co vento:ven-to strada:stra-da città:cit-tà paese:pa-e-se mondo:mon-do
gente:gen-te donna:don-na uomo:uo-mo bambino:bam-bi-no ragazza:ra-gaz-za amico:a-mi-co padre:pa-dre madre:ma-dre fratello:fra-tel-lo sorella:so-rel-la
figlio:fi-glio famiglia:fa-mi-glia parola:pa-ro-la canzone:can-zo-ne musica:mu-si-ca chitarra:chi-tar-ra pianoforte:pia-no-for-te voce:vo-ce ritmo:rit-mo
melodia:me-lo-di-a armonia:ar-mo-ni-a canto:can-to ballo:bal-lo festa:fe-sta estate:e-sta-te inverno:in-ver-no autunno:au-tun-no primavera:pri-ma-ve-ra
neve:ne-ve giugno:giu-gno luglio:lu-glio agosto:a-go-sto settembre:set-tem-bre ottobre:ot-to-bre novembre:no-vem-bre dicembre:di-cem-bre gennaio:gen-na-io
febbraio:feb-bra-io marzo:mar-zo aprile:a-pri-le occhi:oc-chi ghiaccio:ghiac-cio scherzo:scher-zo gnomo:gno-mo bagno:ba-gno sogno:so-gno legno:le-gno
ogni:o-gni gli:gli aglio:a-glio foglia:fo-glia voglia:vo-glia meglio:me-glio figli:fi-gli scuola:scuo-la sciopero:scio-pe-ro scena:sce-na pesce:pe-sce
uscire:u-sci-re lasciare:la-scia-re conoscere:co-no-sce-re nascosto:na-sco-sto mostro:mo-stro nostro:no-stro vostro:vo-stro finestra:fi-ne-stra
maestro:ma-e-stro poeta:po-e-ta leone:le-o-ne reale:re-a-le idea:i-de-a teatro:te-a-tro aereo:a-e-re-o oceano:o-ce-a-no europa:eu-ro-pa auto:au-to
causa:cau-sa laura:lau-ra pausa:pau-sa feudo:feu-do neutro:neu-tro piano:pia-no fiore:fio-re fiume:fiu-me chiave:chia-ve chiesa:chie-sa ghianda:ghian-da
guerra:guer-ra guardare:guar-da-re quando:quan-do questo:que-sto quattro:quat-tro acquisto:ac-qui-sto quieto:quie-to buio:bu-io gioia:gio-ia noia:no-ia
aiuto:a-iu-to maiale:ma-ia-le lui:lui cui:cui poi:poi mai:mai noi:noi voi:voi lei:lei sei:sei miei:miei tuoi:tuoi suoi:suoi vuoi:vuoi puoi:puoi
più:più già:già giù:giù ciò:ciò può:può cioè:cio-è perciò:per-ciò però:pe-rò virtù:vir-tù caffè:caf-fè mio:mi-o mia:mi-a tuo:tu-o tua:tu-a suo:su-o
sua:su-a zio:zi-o via:vi-a io:i-o magia:ma-gi-a follia:fol-li-a nostalgia:no-stal-gi-a allegria:al-le-gri-a fantasia:fan-ta-si-a poesia:po-e-si-a
malinconia:ma-lin-co-ni-a compagnia:com-pa-gni-a energia:e-ner-gi-a bugia:bu-gi-a gelosia:ge-lo-si-a pazzia:paz-zi-a polizia:po-li-zi-a maria:ma-ri-a
lucia:lu-ci-a farmacia:far-ma-ci-a galleria:gal-le-ri-a addio:ad-di-o mormorio:mor-mo-ri-o brusio:bru-si-o oblio:o-bli-o desio:de-si-o albero:al-be-ro
alto:al-to campo:cam-po parte:par-te forte:for-te morte:mor-te sangue:san-gue lingua:lin-gua inglese:in-gle-se ombra:om-bra sembra:sem-bra entrare:en-tra-re
dentro:den-tro centro:cen-tro sopra:so-pra libro:li-bro vetro:ve-tro quadro:qua-dro pietra:pie-tra aprire:a-pri-re africa:a-fri-ca offrire:of-fri-re
soffrire:sof-fri-re sofferenza:sof-fe-ren-za applauso:ap-plau-so problema:pro-ble-ma pubblico:pub-bli-co biblioteca:bi-blio-te-ca atmosfera:at-mo-sfe-ra
tecnica:tec-ni-ca cosmo:co-smo sbaglio:sba-glio sfera:sfe-ra sguardo:sguar-do smettere:smet-te-re snello:snel-lo svegliare:sve-glia-re strano:stra-no
spremere:spre-me-re scrivere:scri-ve-re splendido:splen-di-do mostrare:mo-stra-re inchiostro:in-chio-stro esplodere:e-splo-de-re asfalto:a-sfal-to
aspetto:a-spet-to astro:a-stro triste:tri-ste tristezza:tri-stez-za pasta:pa-sta rosso:ros-so basso:bas-so passo:pas-so pezzo:pez-zo mezzo:mez-zo
ragazzo:ra-gaz-zo piazza:piaz-za bellezza:bel-lez-za giovinezza:gio-vi-nez-za dolcezza:dol-cez-za carezza:ca-rez-za abbraccio:ab-brac-cio braccio:brac-cio
faccia:fac-cia goccia:goc-cia uccello:uc-cel-lo accanto:ac-can-to occasione:oc-ca-sio-ne emozione:e-mo-zio-ne stazione:sta-zio-ne nazione:na-zio-ne
attenzione:at-ten-zio-ne silenzio:si-len-zio spazio:spa-zio grazie:gra-zie vecchio:vec-chio specchio:spec-chio orecchio:o-rec-chio ginocchio:gi-noc-chio
inchino:in-chi-no macchina:mac-chi-na luce:lu-ce pace:pa-ce dolce:dol-ce croce:cro-ce cena:ce-na cibo:ci-bo cinema:ci-ne-ma gelato:ge-la-to giro:gi-ro
giardino:giar-di-no giallo:gial-lo gioco:gio-co giusto:giu-sto viaggio:viag-gio coraggio:co-rag-gio spiaggia:spiag-gia oggi:og-gi leggere:leg-ge-re
sorriso:sor-ri-so sorridere:sor-ri-de-re ricordo:ri-cor-do ricordare:ri-cor-da-re pensiero:pen-sie-ro pensare:pen-sa-re sentire:sen-ti-re
sentimento:sen-ti-men-to momento:mo-men-to istante:i-stan-te eterno:e-ter-no infinito:in-fi-ni-to destino:de-sti-no speranza:spe-ran-za libertà:li-ber-tà
felicità:fe-li-ci-tà verità:ve-ri-tà bontà:bon-tà ognuno:o-gnu-no insieme:in-sie-me lontano:lon-ta-no vicino:vi-ci-no dietro:die-tro davanti:da-van-ti
sotto:sot-to fuori:fuo-ri oltre:ol-tre contro:con-tro senza:sen-za adesso:a-des-so domani:do-ma-ni ieri:ie-ri stanotte:sta-not-te stasera:sta-se-ra
niente:nien-te nessuno:nes-su-no qualcuno:qual-cu-no ciascuno:cia-scu-no tutto:tut-to tanto:tan-to poco:po-co molto:mol-to troppo:trop-po
abbastanza:ab-ba-stan-za piccolo:pic-co-lo grande:gran-de bello:bel-lo brutto:brut-to nuovo:nuo-vo giovane:gio-va-ne anima:a-ni-ma lacrima:la-cri-ma
angelo:an-ge-lo stella:stel-la pianeta:pia-ne-ta universo:u-ni-ver-so orizzonte:o-riz-zon-te tramonto:tra-mon-to alba:al-ba aurora:au-ro-ra fiamma:fiam-ma
cenere:ce-ne-re polvere:pol-ve-re tempesta:tem-pe-sta onda:on-da sabbia:sab-bia conchiglia:con-chi-glia gabbiano:gab-bia-no barca:bar-ca nave:na-ve
porto:por-to treno:tre-no autostrada:au-to-stra-da semaforo:se-ma-fo-ro telefono:te-le-fo-no schermo:scher-mo messaggio:mes-sag-gio chiamata:chia-ma-ta
sveglia:sve-glia pigiama:pi-gia-ma cuscino:cu-sci-no lenzuolo:len-zuo-lo balcone:bal-co-ne guaio:gua-io acquaio:ac-qua-io per:per con:con non:non
`
  .trim()
  .split(/\s+/)
  .map((p) => p.split(':') as [string, string]);

describe('Italian syllabification', () => {
  it(`syllabifies ${WORDS.length} words correctly`, () => {
    const wrong = WORDS.filter(([w, exp]) => syllabifyWord(w).join('-') !== exp).map(([w, exp]) => `${w}: got ${syllabifyWord(w).join('-')}, expected ${exp}`);
    expect(wrong).toEqual([]);
    expect(WORDS.length).toBeGreaterThanOrEqual(200);
  });

  it('keeps case, accents and apostrophes', () => {
    expect(syllabifyWord('Amore')).toEqual(['A', 'mo', 're']);
    expect(syllabifyWord("l'amore")).toEqual(["l'a", 'mo', 're']);
    expect(syllabifyWord('Città')).toEqual(['Cit', 'tà']);
  });

  it('counts metric syllables with synalepha', () => {
    expect(metricSyllables('canto e ballo').map((s) => s.text)).toEqual(['can', 'to‿e', 'bal', 'lo']);
    expect(metricSyllables('canto e ballo')).toHaveLength(4);
    expect(metricSyllables('canto e ballo', false)).toHaveLength(5);
    // the classic hendecasyllable
    expect(metricSyllables('Nel mezzo del cammin di nostra vita')).toHaveLength(11);
  });

  it('marks stress: penultimate by default, written accents, sdrucciole, forced', () => {
    const stressed = (line: string) => syllabifyLine(line).filter((s) => s.stressed).map((s) => s.text);
    expect(stressed('amore')).toEqual(['mo']);
    expect(stressed('città')).toEqual(['tà']);
    expect(stressed('musica')).toEqual(['mu']);
    expect(stressed('scrivere')).toEqual(['scri']);
    expect(stressed('vedere')).toEqual(['de']);
    expect(stressed('paura')).toEqual(['u']);
    expect(stressed('melodia')).toEqual(['di']);
    expect(stressed('ancora')).toEqual(['co']);
    expect(stressed('ANcora')).toEqual(['AN']);
    expect(stressed('il sole')).toEqual(['so']); // articles are unstressed
  });
});
