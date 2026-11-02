// A track's role from its name, in Italian and English. No audio code here: the command line uses it too.
import type { MixRole } from '../types';

export const NAME_RULES: [RegExp, MixRole][] = [
  [/\b(kick|cassa|bd|bass ?drum)\b/, 'kick'],
  [/\b(vox|voc|voce|voci|vocal|vocals|voice|canto|cori|choir|backing|bv)/, 'vocal'],
  [/\b(fx|sfx|riser|sweep|impact|noise|rumore|effett)/, 'fx'],
  [/\b(bass|basso|808|sub)\b/, 'bass'],
  [/\b(drum|drums|batteria|perc|percussion|hats?|snare|rullante|loop ?drum)/, 'drums'],
  [/\b(lead|solo|melod|hook|riff)/, 'lead'],
  [/\b(pad|strings|archi|atmo|ambient|texture|drone)/, 'texture'],
  [/\b(piano|keys|tastier|chord|accord|guitar|chitarra|gtr|organ|organo|rhodes|ep)\b/, 'harmony'],
];
