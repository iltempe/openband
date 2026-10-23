export function encodeWav(channels: Float32Array[], sampleRate: number): Buffer;
export function decodeWav(buf: Buffer): { sampleRate: number; channels: Float32Array[] };
export function estimateBpm(channels: Float32Array[], sr: number): number;
export function estimateKey(channels: Float32Array[], sr: number): string;
export function keyOfNotes(notes: { pitch: number; duration: number }[]): string;
export function keyFromChroma(chroma: number[]): string;
