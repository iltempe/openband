import { useEffect, useRef, useState } from 'react';
import { engine } from './audio/engine';

/** Calls `fn` on every animation frame while mounted. */
export function useFrame(fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    let id = 0;
    const loop = () => {
      ref.current();
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, []);
}

/** Transport position in beats, refreshed every frame. */
export function usePosition() {
  const [pos, setPos] = useState(0);
  useFrame(() => {
    const p = engine.position;
    setPos((prev) => (Math.abs(prev - p) > 0.001 ? p : prev));
  });
  return pos;
}
