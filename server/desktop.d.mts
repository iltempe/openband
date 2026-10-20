export function desktopEntry(o: { exe: string; root: string }): { command: string; args: string[]; env: Record<string, string> };
export function findClaudeCli(env?: Record<string, string | undefined>): string | null;
export function connectClients(entry: { command: string; args: string[]; env?: Record<string, string> }, o?: { clients?: unknown[]; codex?: unknown; claude?: string | null; run?: unknown }): { name: string; status: string; detail?: string }[];
