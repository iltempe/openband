// The providers the gateway knows. A new one: a driver file here (see stability.mjs for the shape), a fake
// server in omep/fixtures/fake-cloud.mjs, and conformance passing against it (omep/cloud.test.ts).
import stability from './stability.mjs';
import elevenlabs from './elevenlabs.mjs';
import mureka from './mureka.mjs';
import lyria from './lyria.mjs';
import local from './local.mjs';

export const DRIVERS = { stability, elevenlabs, mureka, lyria, local };
