import type { SVGProps } from 'react';

const base = (p: SVGProps<SVGSVGElement>) => ({
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  ...p,
});

type I = SVGProps<SVGSVGElement>;

export const Play = (p: I) => (
  <svg {...base(p)}><path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none" /></svg>
);
export const Pause = (p: I) => (
  <svg {...base(p)}><rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" /></svg>
);
export const Record = (p: I) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="6.5" fill="currentColor" stroke="none" /></svg>
);
export const Mic = (p: I) => (
  <svg {...base(p)}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" /></svg>
);
export const People = (p: I) => (
  <svg {...base(p)}><circle cx="9" cy="8" r="3.2" /><path d="M3 19.5c.6-3.3 3-5 6-5s5.4 1.7 6 5" /><circle cx="17" cy="9" r="2.4" /><path d="M16.5 14.6c2.3.2 3.9 1.7 4.5 4.4" /></svg>
);
export const ToStart = (p: I) => (
  <svg {...base(p)}><path d="M6 5v14" /><path d="M19 5v14L9 12z" fill="currentColor" stroke="none" /></svg>
);
export const Cycle = (p: I) => (
  <svg {...base(p)}><path d="M17 2l3 3-3 3" /><path d="M4 11V9a4 4 0 0 1 4-4h12" /><path d="M7 22l-3-3 3-3" /><path d="M20 13v2a4 4 0 0 1-4 4H4" /></svg>
);
export const Metronome = (p: I) => (
  <svg {...base(p)}><path d="M9 3h6l4 18H5z" /><path d="M12 17l5-9" /></svg>
);
export const Library = (p: I) => (
  <svg {...base(p)}><rect x="3" y="4" width="5" height="16" rx="1" /><rect x="10" y="4" width="4" height="16" rx="1" /><path d="M16.5 5.5l3.5-.9 3 15-3.5.9z" /></svg>
);
export const Sliders = (p: I) => (
  <svg {...base(p)}><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" /></svg>
);
export const PianoRoll = (p: I) => (
  <svg {...base(p)}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M7 8h5M10 12h7M6 16h4" /></svg>
);
export const Mixer = (p: I) => (
  <svg {...base(p)}><path d="M6 3v18M12 3v18M18 3v18" /><rect x="4" y="13" width="4" height="3" rx="1" fill="currentColor" /><rect x="10" y="7" width="4" height="3" rx="1" fill="currentColor" /><rect x="16" y="15" width="4" height="3" rx="1" fill="currentColor" /></svg>
);
export const Keyboard = (p: I) => (
  <svg {...base(p)}><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M7 5v8M12 5v8M17 5v8M7 13v6M12 13v6M17 13v6" /></svg>
);
export const Sparkles = (p: I) => (
  <svg {...base(p)}><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></svg>
);
export const Undo = (p: I) => (
  <svg {...base(p)}><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></svg>
);
export const Redo = (p: I) => (
  <svg {...base(p)}><path d="M15 14l5-5-5-5" /><path d="M20 9H9a5 5 0 0 0 0 10h3" /></svg>
);
export const Plus = (p: I) => (
  <svg {...base(p)}><path d="M12 5v14M5 12h14" /></svg>
);
export const Trash = (p: I) => (
  <svg {...base(p)}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
);
export const Menu = (p: I) => (
  <svg {...base(p)}><circle cx="5" cy="12" r="1.4" fill="currentColor" /><circle cx="12" cy="12" r="1.4" fill="currentColor" /><circle cx="19" cy="12" r="1.4" fill="currentColor" /></svg>
);
export const Speaker = (p: I) => (
  <svg {...base(p)}><path d="M11 5L6 9H3v6h3l5 4z" fill="currentColor" /><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" /></svg>
);
export const Close = (p: I) => (
  <svg {...base(p)}><path d="M6 6l12 12M18 6L6 18" /></svg>
);
export const KeysIcon = (p: I) => (
  <svg {...base(p)}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M8 4v10M13 4v10M18 4v10" strokeWidth={3} /></svg>
);
export const DrumIcon = (p: I) => (
  <svg {...base(p)}><ellipse cx="12" cy="9" rx="8" ry="3.5" /><path d="M4 9v6c0 1.9 3.6 3.5 8 3.5s8-1.6 8-3.5V9" /><path d="M7 2l4 6M17 2l-4 6" /></svg>
);
export const Copy = (p: I) => (
  <svg {...base(p)}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></svg>
);
export const Wave = (p: I) => (
  <svg {...base(p)}><path d="M2 12h2M6 8v8M10 4v16M14 7v10M18 10v4M22 12h-2" /></svg>
);
export const Fx = (p: I) => (
  <svg {...base(p)}><path d="M4 7h9M4 17h5M17 7h3M13 17h7" /><circle cx="15" cy="7" r="2" /><circle cx="11" cy="17" r="2" /></svg>
);
export const Automation = (p: I) => (
  <svg {...base(p)}><path d="M3 17l5-6 4 3 4-7 5 4" /><circle cx="8" cy="11" r="1.4" fill="currentColor" /><circle cx="16" cy="7" r="1.4" fill="currentColor" /></svg>
);
export const Midi = (p: I) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="9" /><circle cx="7.5" cy="12" r="1" fill="currentColor" /><circle cx="16.5" cy="12" r="1" fill="currentColor" /><circle cx="9" cy="8" r="1" fill="currentColor" /><circle cx="15" cy="8" r="1" fill="currentColor" /><circle cx="12" cy="6.8" r="1" fill="currentColor" /></svg>
);
export const Flag = (p: I) => (
  <svg {...base(p)}><path d="M5 21V4" /><path d="M5 4h11l-2 4 2 4H5" /></svg>
);
