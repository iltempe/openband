// The desktop app (desktop/main.mjs): its preload exposes `window.openbandDesktop`, a small, fixed API —
// files opened from the operating system, the native menus, the bridge port of an MCP server that started
// the app, and adding OpenBand to the AI apps on this computer. Absent in the browser.
import { switchBridgePort } from './bridge';
import { commands, runCommand } from './commands';
import { saveProject } from './importers';
import { useStore } from './store';

export interface DesktopClientResult {
  name: string;
  status: 'added' | 'already' | 'failed' | 'missing';
  detail?: string;
}

export interface DesktopApi {
  version: string;
  platform: string;
  onOpenFile(cb: (file: { name: string; data: Uint8Array }) => void): void;
  onMenu(cb: (action: string) => void): void;
  onBridgePort(cb: (port: number) => void): void;
  /** Add OpenBand (this app's own MCP server) to Claude Desktop, Claude Code, Cursor and VS Code. */
  connectClients(): Promise<DesktopClientResult[]>;
  /** Ready to receive files and menu actions. */
  ready(): void;
}

export const desktop: DesktopApi | null = typeof window !== 'undefined' ? ((window as unknown as { openbandDesktop?: DesktopApi }).openbandDesktop ?? null) : null;

export function initDesktop(openFile: (file: File) => Promise<void>) {
  if (!desktop) return;
  desktop.onOpenFile(({ name, data }) => void openFile(new File([data as BlobPart], name)));
  desktop.onBridgePort((port) => switchBridgePort(port));
  desktop.onMenu((action) => void menuAction(action));
  desktop.ready();
}

async function menuAction(action: string) {
  const s = useStore.getState();
  try {
    if (action === 'new') commands.new_project({});
    else if (action === 'save') await saveProject();
    else if (action === 'export-wav') await commands.export_wav({});
    else if (action === 'export-midi') await commands.export_midi({});
    else if (action === 'export-dawproject') await commands.export_dawproject({});
    else if (action === 'undo') await runCommand('undo', {}, 'ui');
    else if (action === 'redo') await runCommand('redo', {}, 'ui');
    else if (action === 'ai') s.set({ aiOpen: true });
  } catch (e) {
    s.notify((e as Error).message);
  }
}
