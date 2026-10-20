// Bridge protocol compatibility: the online demo is always the latest app, the server on the user's
// computer may be older (or newer). Commands it doesn't know fail with a message; the panel says why.

/** 'server_old' / 'app_old' when they differ, null when they match or the server doesn't say. */
export function protocolProblem(server: number | undefined, app: number): 'server_old' | 'app_old' | null {
  if (typeof server !== 'number' || server === app) return null;
  return server < app ? 'server_old' : 'app_old';
}
