// UI language (English by default, Italian optional). Project data and the MCP API stay language-neutral:
// only what the user reads goes through t().
import { create } from 'zustand';

export type Lang = 'en' | 'it';
export const LANGS: { id: Lang; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'it', label: 'Italiano' },
];

const en = {
  // Splash
  'splash.tagline': 'The open-source music studio that you — or your AI — can play.',
  'splash.enter': 'Enter the studio',
  'splash.project': 'Project:',

  // Toolbar & LCD
  'lcd.position': 'BAR · BEAT',
  'lcd.tempo': 'TEMPO',
  'lcd.key': 'KEY · 4/4',
  'lcd.tempoHint': 'Drag vertically or double-click to edit',
  'tb.library': 'Library (Y)',
  'tb.toStart': 'Go to start (Enter)',
  'tb.play': 'Play / Stop (Space)',
  'tb.record': 'Record (R)',
  'tb.cycle': 'Cycle (C)',
  'tb.metronome': 'Metronome (M)',
  'tb.undo': 'Undo (⌘Z)',
  'tb.redo': 'Redo (⇧⌘Z)',
  'tb.masterVolume': 'Master volume',
  'tb.typing': 'Musical typing (K)',
  'tb.ai': 'AI / MCP panel',
  'tb.aiConnected': 'AI connected',

  // Project menu
  'menu.title': 'Project',
  'menu.new': 'New empty project',
  'menu.demo': 'Load demo song',
  'menu.save': 'Save project (.json)',
  'menu.open': 'Open project…',
  'menu.exportWav': 'Export song as WAV',
  'menu.language': 'Language',
  'menu.rendering': 'Rendering the song…',
  'menu.wavDone': 'WAV exported',
  'menu.wavFailed': 'Export failed: {error}',
  'menu.opened': 'Opened “{name}”',

  // Arrangement
  'arr.addInstrument': 'Instrument',
  'arr.addDrums': 'Drums',
  'arr.emptyTitle': 'Start a new song',
  'arr.emptyText': 'Add a track, pick a sound from the library, or ask your AI to compose for you via MCP.',
  'arr.softwareInstrument': 'Software instrument',
  'arr.laneHint': 'Double-click to create a region',
  'arr.renameHint': 'Double-click to rename',
  'arr.deleteTrack': 'Delete track',

  // Editor
  'ed.empty': 'Select a region, or double-click a track to create one.',
  'ed.length': 'Length',
  'ed.bars': '{n} bars',
  'ed.transpose': 'Transpose',
  'ed.quantize': 'Quantize',
  'ed.quantizeHint': 'Quantize to 1/16',
  'ed.velocity': 'Velocity',
  'ed.duplicate': 'Duplicate',
  'ed.duplicateHint': 'Duplicate (⌘D)',
  'ed.deleteRegion': 'Delete region',
  'ed.grid': 'Grid',
  'ed.zoom': 'Zoom',
  'ed.triplet': '1/8 triplet',
  'ed.prHint': 'Click: add · Drag: move · Right edge: length · Double-click: delete · ⇧ multi-select',
  'ed.seqHint': 'Click or drag to paint hits · ⇧ click to change accent · Space to listen',

  // Library
  'lib.title': 'Sound library',
  'lib.track': 'Track: {name}',
  'lib.clickToCreate': 'Click to create a track',
  'lib.newTrack': 'New track “{name}”',

  // Smart Controls & mixer
  'sc.empty': 'Select a track to shape its sound.',
  'sc.volume': 'Volume',
  'sc.pan': 'Pan',
  'sc.brightness': 'Brightness',
  'sc.reverb': 'Reverb',
  'sc.echo': 'Echo',
  'mix.rev': 'Rev',
  'mix.master': 'MASTER',
  'mix.out': 'Stereo out',

  // Musical typing & recording
  'typing.title': 'Musical typing',
  'typing.noTrack': 'no track',
  'typing.octave': 'octave',
  'rec.start': 'Recording on “{name}” — play with the keyboard or a MIDI controller',
  'rec.done': 'Recorded {n} notes',
  'rec.region': 'Recording',

  // AI panel
  'ai.connected': 'MCP server connected',
  'ai.connecting': 'Connecting…',
  'ai.unreachable': 'MCP server unreachable',
  'ai.demo': 'Online demo · AI available locally',
  'ai.demoText1': 'This is the online demo: to let your AI play it, clone the project from',
  'ai.demoText2': 'and run it locally.',
  'ai.setup1': 'Add OpenBand to your MCP client (Claude Desktop, Cursor, etc.). The client starts the server, which connects to this window at',
  'ai.path': '/PATH/TO',
  'ai.copy': 'Copy configuration',
  'ai.copied': 'Configuration copied',
  'ai.copyFailed': 'Copy failed',
  'ai.try': 'Try asking',
  'ai.ex1': 'Make a lo-fi beat at 82 BPM in D minor with drums, bass and Rhodes',
  'ai.ex2': 'Add a synth lead melody over bars 5–8',
  'ai.ex3': 'Make the chorus more energetic: sixteenth-note hi-hats and a crash on the 1',
  'ai.ex4': 'Turn the pad down, add reverb to the piano and start the loop',
  'ai.activity': 'Activity',
  'ai.logEmpty': 'Commands received from the AI will appear here.',
  'ai.sum.track': 'New track {name}',
  'ai.sum.region': 'Region at bar {bar} ({n} notes)',
  'ai.sum.notes': '{n} notes added',
  'ai.sum.drums': 'Drum pattern: {pieces}',
  'ai.sum.chords': 'Chords: {chords}',
  'ai.sum.transport': 'Transport: {action}',
  'ai.sum.updateTrack': 'Track updated: {fields}',

  // Imported sounds & audio tracks
  'arr.addAudio': 'Audio',
  'arr.audioLaneHint': 'Double-click or drop audio files to add a clip',
  'audio.clipInfo': '{bars} bars · {seconds} s at {bpm} BPM — audio is not time-stretched when the tempo changes',
  'audio.fit': 'Fit to sample',
  'audio.fitHint': 'Set the region length to the rest of the sample',
  'audio.gain': 'Gain',
  'audio.missing': 'Sample missing — open the .openband bundle that contains it',
  'audio.start': 'Start',
  'audio.track': 'Audio track',
  'audio.trackDesc': 'Plays imported audio clips',
  'imp.title': 'Import sounds',
  'imp.sampler': 'Sampler',
  'imp.samplerHint': 'Turn one or more audio files into a playable instrument (note names in file names set the keys)',
  'imp.kit': 'Drum kit',
  'imp.kitHint': 'Build a kit from audio files (kick, snare, hat… are recognised by name)',
  'imp.sfHint': 'Import instruments from a SoundFont (.sf2) library',
  'imp.audio': 'Audio',
  'imp.audioHint': 'Put audio files on the timeline as clips',
  'imp.audioReady': '{n} audio clip(s) added',
  'imp.failed': 'Import failed: {error}',
  'imp.imported': 'Imported',
  'imp.instrument': 'Instrument',
  'imp.instrumentReady': 'Instrument “{name}” ready',
  'imp.loading': 'Loading…',
  'inst.addSamples': 'Add samples…',
  'inst.attack': 'Attack',
  'inst.load': 'Load…',
  'inst.release': 'Release',
  'inst.root': 'Root',
  'inst.sampler': 'Sampler',
  'inst.sfInfo': '{n} zones from the SoundFont preset.',
  'menu.importAudio': 'Import audio…',
  'menu.importSf': 'Import SoundFont…',
  'sf.title': 'SoundFont presets',
  'sf.sub': '{name} · {n} presets',
  'sf.search': 'Search presets…',
  'sf.add': 'Add',
  'sf.added': 'Added ✓',
  'sf.importing': 'Importing…',
  'sf.none': 'No presets match.',
  'sf.hint': 'Each preset becomes an instrument in the library. Only the samples it uses are stored.',
  'cat.Imported': 'Imported',
  'cat.Audio': 'Audio',

  // Default names
  'name.untitled': 'My song',
  'name.newSong': 'New song',
  'name.beat': 'Beat',
  'name.chords': 'Chords',

  // Instrument categories and descriptions
  'cat.Keys': 'Keys',
  'cat.Synth': 'Synth',
  'cat.Bass': 'Bass',
  'cat.Pads & Strings': 'Pads & Strings',
  'cat.Drums': 'Drums',
  'preset.felt-piano': 'Soft, intimate piano',
  'preset.velvet-keys': 'Vintage FM electric piano',
  'preset.retro-organ': 'Tonewheel organ',
  'preset.crystal-bells': 'Shimmering FM bells',
  'preset.neon-lead': 'Analog sawtooth lead',
  'preset.pluck': 'Bright pluck',
  'preset.chip': 'Retro console square wave',
  'preset.sub-bass': 'Deep, round bass',
  'preset.acid-bass': 'Resonant 303-style bass',
  'preset.finger-bass': 'Fingered electric bass',
  'preset.aurora-pad': 'Wide, evolving pad',
  'preset.silk-strings': 'Synth string ensemble',
  'preset.kit-studio': 'Tight, punchy pop kit',
  'preset.kit-808': 'Drum machine with long kick',
  'preset.kit-lofi': 'Dusty, saturated kit',

  // Drum pieces (by short code)
  'drum.CR': 'Crash',
  'drum.RD': 'Ride',
  'drum.T1': 'High tom',
  'drum.T2': 'Mid tom',
  'drum.T3': 'Low tom',
  'drum.OH': 'Open hi-hat',
  'drum.HH': 'Closed hi-hat',
  'drum.RM': 'Rim',
  'drum.CP': 'Clap',
  'drum.SN': 'Snare',
  'drum.KK': 'Kick',

  // Demo song
  'demo.name': 'Night in Trastevere',
  'demo.drums': 'Drums',
  'demo.bass': 'Bass',
  'demo.bassLine': 'Bass line',
  'demo.keys': 'Electric piano',
};

export type MessageKey = keyof typeof en;

const it: Record<MessageKey, string> = {
  'splash.tagline': 'Lo studio musicale open source che puoi suonare tu o la tua AI.',
  'splash.enter': 'Entra nello studio',
  'splash.project': 'Progetto:',

  'lcd.position': 'BATTUTA · MOVIMENTO',
  'lcd.tempo': 'TEMPO',
  'lcd.key': 'TONALITÀ · 4/4',
  'lcd.tempoHint': 'Trascina in verticale o doppio clic per modificare',
  'tb.library': 'Libreria (Y)',
  'tb.toStart': "Vai all'inizio (Invio)",
  'tb.play': 'Play / Stop (Spazio)',
  'tb.record': 'Registra (R)',
  'tb.cycle': 'Ciclo (C)',
  'tb.metronome': 'Metronomo (M)',
  'tb.undo': 'Annulla (⌘Z)',
  'tb.redo': 'Ripristina (⇧⌘Z)',
  'tb.masterVolume': 'Volume master',
  'tb.typing': 'Tastiera musicale (K)',
  'tb.ai': 'Pannello AI / MCP',
  'tb.aiConnected': 'AI collegata',

  'menu.title': 'Progetto',
  'menu.new': 'Nuovo progetto vuoto',
  'menu.demo': 'Carica brano demo',
  'menu.save': 'Salva progetto (.json)',
  'menu.open': 'Apri progetto…',
  'menu.exportWav': 'Esporta brano in WAV',
  'menu.language': 'Lingua',
  'menu.rendering': 'Rendering del brano in corso…',
  'menu.wavDone': 'WAV esportato',
  'menu.wavFailed': 'Esportazione non riuscita: {error}',
  'menu.opened': 'Aperto “{name}”',

  'arr.addInstrument': 'Strumento',
  'arr.addDrums': 'Batteria',
  'arr.emptyTitle': 'Inizia un nuovo brano',
  'arr.emptyText': 'Aggiungi una traccia, scegli un suono dalla libreria, oppure chiedi alla tua AI di comporre per te via MCP.',
  'arr.softwareInstrument': 'Strumento software',
  'arr.laneHint': 'Doppio clic per creare una regione',
  'arr.renameHint': 'Doppio clic per rinominare',
  'arr.deleteTrack': 'Elimina traccia',

  'ed.empty': 'Seleziona una regione, oppure fai doppio clic su una traccia per crearne una.',
  'ed.length': 'Lunghezza',
  'ed.bars': '{n} batt.',
  'ed.transpose': 'Trasponi',
  'ed.quantize': 'Quantizza',
  'ed.quantizeHint': 'Quantizza a 1/16',
  'ed.velocity': 'Velocity',
  'ed.duplicate': 'Duplica',
  'ed.duplicateHint': 'Duplica (⌘D)',
  'ed.deleteRegion': 'Elimina regione',
  'ed.grid': 'Griglia',
  'ed.zoom': 'Zoom',
  'ed.triplet': '1/8 terzina',
  'ed.prHint': 'Clic: aggiungi · Trascina: sposta · Bordo destro: durata · Doppio clic: elimina · ⇧ multi-selezione',
  'ed.seqHint': 'Clic o trascina per disegnare i colpi · ⇧ clic per cambiare l’accento · Barra spaziatrice per ascoltare',

  'lib.title': 'Libreria suoni',
  'lib.track': 'Traccia: {name}',
  'lib.clickToCreate': 'Clic per creare una traccia',
  'lib.newTrack': 'Nuova traccia “{name}”',

  'sc.empty': 'Seleziona una traccia per regolarne il suono.',
  'sc.volume': 'Volume',
  'sc.pan': 'Pan',
  'sc.brightness': 'Brillantezza',
  'sc.reverb': 'Riverbero',
  'sc.echo': 'Eco',
  'mix.rev': 'Rev',
  'mix.master': 'MASTER',
  'mix.out': 'Uscita stereo',

  'typing.title': 'Tastiera musicale',
  'typing.noTrack': 'nessuna traccia',
  'typing.octave': 'ottava',
  'rec.start': 'Registrazione su “{name}” — suona con la tastiera o un controller MIDI',
  'rec.done': 'Registrate {n} note',
  'rec.region': 'Registrazione',

  'ai.connected': 'Server MCP collegato',
  'ai.connecting': 'Connessione in corso…',
  'ai.unreachable': 'Server MCP non raggiungibile',
  'ai.demo': 'Demo online · AI disponibile in locale',
  'ai.demoText1': 'Questa è la demo online: per farla suonare alla tua AI, clona il progetto da',
  'ai.demoText2': 'e avvialo in locale.',
  'ai.setup1': 'Aggiungi OpenBand al tuo client MCP (Claude Desktop, Cursor, ecc.). Il client avvia il server, che si collega a questa finestra su',
  'ai.path': '/PERCORSO',
  'ai.copy': 'Copia configurazione',
  'ai.copied': 'Configurazione copiata',
  'ai.copyFailed': 'Copia non riuscita',
  'ai.try': 'Prova a chiedere',
  'ai.ex1': 'Crea un beat lo-fi a 82 BPM in Re minore con batteria, basso e Rhodes',
  'ai.ex2': 'Aggiungi una melodia di synth lead sulle battute 5–8',
  'ai.ex3': 'Rendi il ritornello più energico: hi-hat in sedicesimi e crash sull’1',
  'ai.ex4': 'Abbassa il pad, alza il riverbero sul piano e fai partire il loop',
  'ai.activity': 'Attività',
  'ai.logEmpty': 'I comandi ricevuti dall’AI appariranno qui.',
  'ai.sum.track': 'Nuova traccia {name}',
  'ai.sum.region': 'Regione su battuta {bar} ({n} note)',
  'ai.sum.notes': '{n} note aggiunte',
  'ai.sum.drums': 'Pattern di batteria: {pieces}',
  'ai.sum.chords': 'Accordi: {chords}',
  'ai.sum.transport': 'Trasporto: {action}',
  'ai.sum.updateTrack': 'Traccia aggiornata: {fields}',

  'arr.addAudio': 'Audio',
  'arr.audioLaneHint': 'Doppio clic o trascina file audio per aggiungere una clip',
  'audio.clipInfo': '{bars} battute · {seconds} s a {bpm} BPM — se cambi tempo l’audio non viene adattato',
  'audio.fit': 'Adatta al campione',
  'audio.fitHint': 'Imposta la lunghezza della regione sul resto del campione',
  'audio.gain': 'Guadagno',
  'audio.missing': 'Campione mancante — apri il file .openband che lo contiene',
  'audio.start': 'Inizio',
  'audio.track': 'Traccia audio',
  'audio.trackDesc': 'Riproduce clip audio importate',
  'imp.title': 'Importa suoni',
  'imp.sampler': 'Campionatore',
  'imp.samplerHint': 'Trasforma uno o più file audio in uno strumento suonabile (i nomi delle note nei file indicano i tasti)',
  'imp.kit': 'Kit batteria',
  'imp.kitHint': 'Crea un kit da file audio (cassa, rullante, hi-hat… riconosciuti dal nome)',
  'imp.sfHint': 'Importa strumenti da una libreria SoundFont (.sf2)',
  'imp.audio': 'Audio',
  'imp.audioHint': 'Metti file audio sulla timeline come clip',
  'imp.audioReady': '{n} clip audio aggiunte',
  'imp.failed': 'Import non riuscito: {error}',
  'imp.imported': 'Importati',
  'imp.instrument': 'Strumento',
  'imp.instrumentReady': 'Strumento “{name}” pronto',
  'imp.loading': 'Caricamento…',
  'inst.addSamples': 'Aggiungi campioni…',
  'inst.attack': 'Attacco',
  'inst.load': 'Carica…',
  'inst.release': 'Rilascio',
  'inst.root': 'Nota',
  'inst.sampler': 'Campionatore',
  'inst.sfInfo': '{n} zone dal preset SoundFont.',
  'menu.importAudio': 'Importa audio…',
  'menu.importSf': 'Importa SoundFont…',
  'sf.title': 'Preset SoundFont',
  'sf.sub': '{name} · {n} preset',
  'sf.search': 'Cerca preset…',
  'sf.add': 'Aggiungi',
  'sf.added': 'Aggiunto ✓',
  'sf.importing': 'Importazione…',
  'sf.none': 'Nessun preset trovato.',
  'sf.hint': 'Ogni preset diventa uno strumento nella libreria. Vengono salvati solo i campioni che usa.',
  'cat.Imported': 'Importati',
  'cat.Audio': 'Audio',

  'name.untitled': 'Il mio brano',
  'name.newSong': 'Nuovo brano',
  'name.beat': 'Beat',
  'name.chords': 'Accordi',

  'cat.Keys': 'Tastiere',
  'cat.Synth': 'Synth',
  'cat.Bass': 'Bassi',
  'cat.Pads & Strings': 'Pad & Archi',
  'cat.Drums': 'Batterie',
  'preset.felt-piano': 'Pianoforte morbido e intimo',
  'preset.velvet-keys': 'Piano elettrico FM vintage',
  'preset.retro-organ': 'Organo a ruote foniche',
  'preset.crystal-bells': 'Campane FM luccicanti',
  'preset.neon-lead': 'Lead analogico a dente di sega',
  'preset.pluck': 'Pizzicato brillante',
  'preset.chip': 'Onda quadra da console retrò',
  'preset.sub-bass': 'Basso profondo e rotondo',
  'preset.acid-bass': 'Basso risonante stile 303',
  'preset.finger-bass': 'Basso elettrico pizzicato',
  'preset.aurora-pad': 'Pad ampio ed evolutivo',
  'preset.silk-strings': 'Ensemble d’archi sintetico',
  'preset.kit-studio': 'Batteria pop asciutta e punchy',
  'preset.kit-808': 'Drum machine con cassa lunga',
  'preset.kit-lofi': 'Kit polveroso e saturo',

  'drum.CR': 'Crash',
  'drum.RD': 'Ride',
  'drum.T1': 'Tom alto',
  'drum.T2': 'Tom medio',
  'drum.T3': 'Tom basso',
  'drum.OH': 'Hi-hat aperto',
  'drum.HH': 'Hi-hat chiuso',
  'drum.RM': 'Rim',
  'drum.CP': 'Clap',
  'drum.SN': 'Rullante',
  'drum.KK': 'Cassa',

  'demo.name': 'Notte a Trastevere',
  'demo.drums': 'Batteria',
  'demo.bass': 'Basso',
  'demo.bassLine': 'Linea di basso',
  'demo.keys': 'Piano elettrico',
};

const DICTS: Record<Lang, Record<MessageKey, string>> = { en, it };
const STORAGE_KEY = 'openband.lang';

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'it') return saved;
  } catch {
    // storage unavailable: fall back to the default
  }
  return 'en';
}

export const useLang = create<{ lang: Lang }>(() => ({ lang: initialLang() }));

export function setLang(lang: Lang) {
  useLang.setState({ lang });
  document.documentElement.lang = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // not persisted, still applied for this session
  }
}

document.documentElement.lang = useLang.getState().lang;

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const s = DICTS[useLang.getState().lang][key] ?? en[key];
  return vars ? s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? '')) : s;
}

/** Hook version of t(): re-renders the component when the language changes. */
export function useT() {
  useLang((s) => s.lang);
  return t;
}

// Labels for data whose canonical value is English (shared with the MCP API).
export const presetDescription = (p: { id: string; description: string }) => (DICTS[useLang.getState().lang] as Record<string, string>)[`preset.${p.id}`] ?? p.description;
export const categoryLabel = (category: string) => (DICTS[useLang.getState().lang] as Record<string, string>)[`cat.${category}`] ?? category;
export const drumLabel = (d: { short: string; name: string }) => (DICTS[useLang.getState().lang] as Record<string, string>)[`drum.${d.short}`] ?? d.name;
