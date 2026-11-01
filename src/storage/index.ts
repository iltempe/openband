// The backend in use. Everything that stores a song goes through backend().
import { LocalBackend } from './local';
import type { Backend } from './types';

let current: Backend = LocalBackend;
export const backend = () => current;
export const setBackend = (b: Backend) => void (current = b);
export type * from './types';
