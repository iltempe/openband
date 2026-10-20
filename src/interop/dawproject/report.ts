// What a DAWproject import (or export) could not carry over — always listed, never dropped silently.

export type ReportCode =
  | 'tempo_changes' // tempo automation: only the first tempo was used
  | 'meter' // not 4/4
  | 'plugin' // a VST/CLAP/AU/built-in device that has no OpenBand equivalent
  | 'instrument_replaced' // instrument plugin replaced by the closest preset
  | 'automation' // automation of another parameter
  | 'group' // folder/group track flattened
  | 'warp' // time-stretched audio imported at its original speed
  | 'send' // sends approximated
  | 'audio_missing' // audio file referenced but not in the archive
  | 'clip_launcher' // scenes / clip slots
  | 'video'
  | 'fade' // clip fades
  | 'export_skipped'; // export: something OpenBand has that DAWproject can't hold (kept in openband.json)

export interface ReportItem {
  code: ReportCode;
  /** Track or device names, values: for the message. */
  track?: string;
  detail?: string;
}

export interface ImportReport {
  items: ReportItem[];
  /** Source application, from <Application>. */
  application: string | null;
  /** The archive was made by OpenBand and nothing changed since: restored exactly from openband.json. */
  lossless: boolean;
}

export const emptyReport = (): ImportReport => ({ items: [], application: null, lossless: false });

/** English text for logs and the tool result (the UI translates the codes). */
export function reportLine(i: ReportItem): string {
  const on = i.track ? ` (${i.track})` : '';
  switch (i.code) {
    case 'tempo_changes':
      return `Tempo changes: only the first tempo was used${i.detail ? ` — ${i.detail}` : ''}`;
    case 'meter':
      return `Time signature ${i.detail}: OpenBand is 4/4, bars may not line up`;
    case 'plugin':
      return `Plugin not portable${on}: ${i.detail}`;
    case 'instrument_replaced':
      return `Instrument plugin replaced by a preset${on}: ${i.detail}`;
    case 'automation':
      return `Automation not imported${on}: ${i.detail}`;
    case 'group':
      return `Group track flattened: ${i.detail}`;
    case 'warp':
      return `Time-stretched audio imported at its original speed${on}: ${i.detail}`;
    case 'send':
      return `Sends approximated${on}: ${i.detail}`;
    case 'audio_missing':
      return `Audio file missing from the archive${on}: ${i.detail}`;
    case 'clip_launcher':
      return `Clip launcher scenes not imported: ${i.detail}`;
    case 'video':
      return `Video not imported${on}`;
    case 'fade':
      return `Clip fades not imported${on}: ${i.detail}`;
    case 'export_skipped':
      return `Not representable in DAWproject (kept for OpenBand in openband.json)${on}: ${i.detail}`;
  }
}
