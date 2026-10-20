// Installable app: the service worker (offline), the install prompt and files opened with a double-click
// (File Handling API, where the browser supports it).
import { create } from 'zustand';
import { useStore } from './store';
import { runCommand } from './commands';
import { desktop, initDesktop } from './desktop';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export const usePwa = create<{ canInstall: boolean; installed: boolean; offlineReady: boolean }>(() => ({
  canInstall: false,
  // The desktop app is installed by definition (and has no install prompt).
  installed: !!desktop || (typeof matchMedia !== 'undefined' && matchMedia('(display-mode: standalone)').matches),
  offlineReady: false,
}));

let deferred: InstallPromptEvent | null = null;

export async function installApp() {
  if (!deferred) return false;
  await deferred.prompt();
  const { outcome } = await deferred.userChoice;
  deferred = null;
  usePwa.setState({ canInstall: false, installed: outcome === 'accepted' });
  return outcome === 'accepted';
}

/** Safari has no install prompt: it is done from the Share menu. */
export const isSafari = () => /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent);

/** A file opened with OpenBand from the operating system. */
async function openLaunched(file: File) {
  try {
    if (/\.midi?$/i.test(file.name)) await runCommand('import_midi_file', { file }, 'ui');
    else if (/\.dawproject$/i.test(file.name)) await runCommand('import_dawproject_file', { file }, 'ui');
    else {
      const { openProjectFile } = await import('./components/ImportUI');
      await openProjectFile(file);
    }
  } catch (e) {
    useStore.getState().notify((e as Error).message);
  }
}

export function initPwa() {
  // In the desktop app files come from the operating system through the app, and there is nothing to cache.
  if (desktop) return initDesktop(openLaunched);
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    usePwa.setState({ canInstall: true });
  });
  window.addEventListener('appinstalled', () => usePwa.setState({ installed: true, canInstall: false }));
  const lq = (window as unknown as { launchQueue?: { setConsumer(fn: (p: { files: FileSystemFileHandle[] }) => void): void } }).launchQueue;
  lq?.setConsumer(async (params) => {
    for (const h of params.files ?? []) await openLaunched(await h.getFile());
  });
  // Offline support only for the built app (Vite's dev server must stay uncached).
  if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker
      .register('./sw.js')
      .then(() => navigator.serviceWorker.ready)
      .then(() => usePwa.setState({ offlineReady: true }))
      .catch(() => {});
  }
}
