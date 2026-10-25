// Voice commands (SPEC v0.6 G4): the grammar turns what the recognizer heard into studio commands.
import { describe, expect, it } from 'vitest';
import { enNumber, itNumber, parseCommand, readNumbers, vocabulary } from './grammar';

describe('voice command grammar', () => {
  it('numbers as they are said, in both languages', () => {
    expect([1, 9, 12, 21, 28, 33, 90, 100, 120, 128, 240].map(itNumber)).toEqual(['uno', 'nove', 'dodici', 'ventuno', 'ventotto', 'trentatre', 'novanta', 'cento', 'centoventi', 'centoventotto', 'duecentoquaranta']);
    expect([9, 21, 120].map(enNumber)).toEqual(['nine', 'twenty one', 'one hundred twenty']);
    expect(readNumbers('tempo cento venti'.split(' '), 'it')[0].value).toBe(120);
    expect(readNumbers('tempo centoventi'.split(' '), 'it')[0].value).toBe(120);
    expect(readNumbers('tempo one hundred twenty'.split(' '), 'en')[0].value).toBe(120);
  });

  const it_ = (s: string) => parseCommand(s, 'it');
  const en = (s: string) => parseCommand(s, 'en');

  it('the Italian commands of the spec', () => {
    expect(it_('registra')).toEqual({ action: 'record' });
    expect(it_('stop')).toEqual({ action: 'stop' });
    expect(it_('ancora')).toEqual({ action: 'again' });
    expect(it_('riascolta')).toEqual({ action: 'playback' });
    expect(it_('dal ritornello')).toEqual({ action: 'from_section', kind: 'chorus' });
    expect(it_('dalla seconda strofa')).toEqual({ action: 'from_section', kind: 'verse', ordinal: 2 });
    expect(it_('dalla battuta nove')).toEqual({ action: 'from_bar', bar: 9 });
    expect(it_('loop sul ritornello')).toEqual({ action: 'loop_section', kind: 'chorus' });
    expect(it_('punch dalla nove alla dodici')).toEqual({ action: 'punch', from: 9, to: 12 });
    expect(it_('segna errore')).toEqual({ action: 'flub' });
    expect(it_('buona questa')).toEqual({ action: 'good' });
    expect(it_('tieni questa')).toEqual({ action: 'keep_take' });
    expect(it_("cancella l'ultima take")).toEqual({ action: 'delete_last_take' });
    expect(it_('metronomo più forte')).toEqual({ action: 'metronome', change: 'louder' });
    expect(it_('metronomo più piano')).toEqual({ action: 'metronome', change: 'softer' });
    expect(it_('metronomo via')).toEqual({ action: 'metronome', change: 'off' });
    expect(it_('più lento')).toEqual({ action: 'tempo', delta: -5 });
    expect(it_('tempo novanta')).toEqual({ action: 'tempo', bpm: 90 });
    expect(it_('più me in cuffia')).toEqual({ action: 'monitor', target: 'input', delta: 3 });
    expect(it_('meno basi')).toEqual({ action: 'monitor', target: 'playback', delta: -3 });
    expect(it_('annulla')).toEqual({ action: 'undo' });
    expect(it_('sessione sulla prima strofa cinque passaggi')).toEqual({ action: 'session', kind: 'verse', ordinal: 1, passes: 5 });
    expect(it_('basta così')).toEqual({ action: 'session_stop' });
    // What the small Italian model really hears for two of them (it drops "punch" and sometimes "dal").
    expect(it_('dalla nove alla dodici')).toEqual({ action: 'punch', from: 9, to: 12 });
    expect(it_('ritornello')).toEqual({ action: 'from_section', kind: 'chorus' });
    expect(it_('che bella giornata')).toBeNull();
  });

  it('the English ones, also when "to" is heard as "two"', () => {
    expect(en('record')).toEqual({ action: 'record' });
    expect(en('play back')).toEqual({ action: 'playback' });
    expect(en('from the chorus')).toEqual({ action: 'from_section', kind: 'chorus' });
    expect(en('from verse two')).toEqual({ action: 'from_section', kind: 'verse', ordinal: 2 });
    expect(en('from bar nine')).toEqual({ action: 'from_bar', bar: 9 });
    expect(en('loop the chorus')).toEqual({ action: 'loop_section', kind: 'chorus' });
    expect(en('punch from nine two twelve')).toEqual({ action: 'punch', from: 9, to: 12 });
    expect(en('mark error')).toEqual({ action: 'flub' });
    expect(en('keep this one')).toEqual({ action: 'keep_take' });
    expect(en('delete the last take')).toEqual({ action: 'delete_last_take' });
    expect(en('metronome off')).toEqual({ action: 'metronome', change: 'off' });
    expect(en('tempo one hundred twenty')).toEqual({ action: 'tempo', bpm: 120 });
    expect(en('less track')).toEqual({ action: 'monitor', target: 'playback', delta: -3 });
    expect(en('undo')).toEqual({ action: 'undo' });
    expect(en("that's enough")).toEqual({ action: 'session_stop' });
    expect(en('what a nice day')).toBeNull();
  });

  it('a vocabulary for the recognizer, with the song’s own words', () => {
    const v = vocabulary('it', ['Ponte Milvio']);
    expect(v).toEqual(expect.arrayContaining(['registra', 'ritornello', 'centoventi', 'ponte milvio']));
    expect(new Set(v).size).toBe(v.length);
  });
});
