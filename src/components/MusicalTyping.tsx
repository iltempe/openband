import { getTrack, useStore } from '../store';
import { DRUM_TYPING_KEYS, TYPING_KEYS, liveNoteOff, liveNoteOn, useLive } from '../input';
import { drumByPitch, isBlackKey, noteName } from '../music';
import * as I from './Icons';

const KEY_FOR = Object.fromEntries(Object.entries(TYPING_KEYS).map(([k, v]) => [v, k]));

export function MusicalTyping() {
  const s = useStore();
  const active = useLive((l) => l.active);
  const track = getTrack(s.project, s.selectedTrackId);
  const drums = track?.kind === 'drums';
  const base = (s.octave + 1) * 12;

  const press = (p: number) => {
    liveNoteOn(p);
    const up = () => {
      liveNoteOff(p);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="typing">
      <div className="typing-head">
        <div className="typing-title">
          <I.Keyboard width={16} height={16} /> Tastiera musicale
          <span className="typing-track">{track ? track.name : 'nessuna traccia'}</span>
        </div>
        <div className="typing-info">
          {!drums && (
            <span>
              <kbd>Z</kbd>
              <kbd>X</kbd> ottava {s.octave - 4 >= 0 ? `+${s.octave - 4}` : s.octave - 4}
            </span>
          )}
          <span>
            <kbd>C</kbd>
            <kbd>V</kbd> velocity {Math.round(s.velocity * 127)}
          </span>
          <button className="icon-btn" onClick={() => s.set({ keyboardOpen: false })}>
            <I.Close width={16} height={16} />
          </button>
        </div>
      </div>
      {drums ? (
        <div className="pads">
          {Object.entries(DRUM_TYPING_KEYS).map(([k, p]) => (
            <button key={k} className={`pad ${active.includes(p) ? 'on' : ''}`} onPointerDown={() => press(p)}>
              <span className="pad-name">{drumByPitch(p)?.name}</span>
              <kbd>{k.toUpperCase()}</kbd>
            </button>
          ))}
        </div>
      ) : (
        <div className="keys">
          {Array.from({ length: 18 }, (_, i) => {
            const p = base + i;
            const black = isBlackKey(p);
            return (
              <button
                key={p}
                className={`key ${black ? 'black' : 'white'} ${active.includes(p) ? 'on' : ''}`}
                onPointerDown={() => press(p)}
              >
                {KEY_FOR[i] && <kbd>{KEY_FOR[i].toUpperCase()}</kbd>}
                {!black && p % 12 === 0 && <span className="key-c">{noteName(p)}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
