import { useRef } from 'react';
import { clamp } from '../music';

interface Props {
  value: number;
  min?: number;
  max?: number;
  defaultValue?: number;
  label: string;
  size?: number;
  color?: string;
  bipolar?: boolean;
  format?: (v: number) => string;
  onStart?: () => void;
  onChange: (v: number) => void;
}

const START = -135;
const SWEEP = 270;

function arc(cx: number, cy: number, r: number, a0: number, a1: number) {
  const p = (a: number) => {
    const rad = ((a - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  };
  const [x0, y0] = p(a0);
  const [x1, y1] = p(a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  const sweep = a1 > a0 ? 1 : 0;
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} ${sweep} ${x1} ${y1}`;
}

/** Drag up/down (or scroll) to change; double-click resets. */
export function Knob({ value, min = 0, max = 1, defaultValue, label, size = 56, color = 'var(--accent)', bipolar, format, onStart, onChange }: Props) {
  const drag = useRef<{ y: number; v: number } | null>(null);
  const norm = (value - min) / (max - min);
  const angle = START + norm * SWEEP;
  const from = bipolar ? 0 : START;
  const c = size / 2;
  const r = c - 5;

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, v: value };
    onStart?.();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const range = max - min;
    const sens = e.shiftKey ? 600 : 160;
    onChange(clamp(drag.current.v + ((drag.current.y - e.clientY) / sens) * range, min, max));
  };
  const end = () => (drag.current = null);

  return (
    <div className="knob" style={{ width: size + 16 }}>
      <svg
        width={size}
        height={size}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={() => defaultValue !== undefined && (onStart?.(), onChange(defaultValue))}
        onWheel={(e) => {
          onChange(clamp(value - Math.sign(e.deltaY) * (max - min) * 0.02, min, max));
        }}
        role="slider"
        aria-label={label}
        aria-valuenow={value}
      >
        <circle cx={c} cy={c} r={r - 5} className="knob-body" />
        <path d={arc(c, c, r, START, START + SWEEP)} className="knob-track" />
        {Math.abs(angle - from) > 0.5 && (
          <path d={arc(c, c, r, Math.min(from, angle), Math.max(from, angle))} stroke={color} className="knob-value" />
        )}
        <line
          x1={c}
          y1={c}
          x2={c + (r - 10) * Math.cos(((angle - 90) * Math.PI) / 180)}
          y2={c + (r - 10) * Math.sin(((angle - 90) * Math.PI) / 180)}
          className="knob-pointer"
        />
      </svg>
      <div className="knob-label">{label}</div>
      <div className="knob-readout">{format ? format(value) : Math.round(norm * 100)}</div>
    </div>
  );
}
