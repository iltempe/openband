// Italian G2P by rule (SPEC v0.6 §10): the phonemes OpenBand hands singing engines.
import { describe, expect, it } from 'vitest';
import { nucleusIndex, phonemesOfSyllable, phonemizeSyllables } from './g2p.it';
import { syllabifyLine } from './syllabify.it';

const word = (w: string) => {
  const sy = syllabifyLine(w).map((s, i) => ({ text: s.text, wordStart: i === 0 }));
  return phonemizeSyllables(sy).map((p) => p.join(' '));
};

describe('Italian G2P', () => {
  it('soft and hard c and g, gn, gli, sc, qu, h', () => {
    expect(word('ciao')).toEqual(['tS a', 'o']);
    expect(word('cena')).toEqual(['tS e', 'n a']);
    expect(word('chiesa')).toEqual(['k j e', 'z a']);
    expect(word('giorno')).toEqual(['dZ o r', 'n o']);
    expect(word('ghiro')).toEqual(['g i', 'r o']);
    expect(word('gnomo')).toEqual(['J o', 'm o']);
    expect(word('figlio')).toEqual(['f i', 'L o']);
    expect(word('gli')).toEqual(['L i']);
    expect(word('scena')).toEqual(['S e', 'n a']);
    expect(word('sciare')).toEqual(['S a', 'r e']);
    expect(word('quando')).toEqual(['k w a n', 'd o']);
    expect(word('ho')).toEqual(['o']);
  });

  it('s and z, double consonants, open vowels from accents, glides', () => {
    expect(word('rosa')).toEqual(['r o', 'z a']);
    expect(word('sbaglio')).toEqual(['z b a', 'L o']);
    expect(word('sole')).toEqual(['s o', 'l e']);
    expect(word('zero')).toEqual(['dz e', 'r o']);
    expect(word('pizza')).toEqual(['p i t', 'ts a']);
    expect(word('gatto')).toEqual(['g a t', 't o']);
    expect(word('faccia')).toEqual(['f a t', 'tS a']);
    expect(word('oggi')).toEqual(['o d', 'dZ i']);
    expect(word('caffè')).toEqual(['k a f', 'f E']);
    expect(word('però')).toEqual(['p e', 'r O']);
    expect(word('piede')).toEqual(['p j e', 'd e']);
    expect(word('uomo')).toEqual(['w o', 'm o']);
  });

  it('a whole line, with the vowel each note lands on', () => {
    const sy = syllabifyLine('notte a Trastevere');
    const ph = phonemizeSyllables(sy.map((s, i) => ({ text: s.text, wordStart: i === 0 || sy[i - 1].word !== s.word })));
    expect(ph.map((p) => p.join(' '))).toEqual(['n o t', 't e', 'a', 't r a', 's t e', 'v e', 'r e']);
    expect(nucleusIndex(phonemesOfSyllable('stra'))).toBe(3);
  });
});
