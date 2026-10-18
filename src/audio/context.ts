// Tone.js defaults to a wrapped ("standardized") AudioContext, but Web Audio Modules are native
// AudioWorkletNodes that can only connect to native nodes. Run Tone on a native context instead.
// Imported first by main.tsx, before any Tone node exists.
import * as Tone from 'tone';

Tone.setContext(new Tone.Context(new AudioContext({ latencyHint: 'interactive' })));
