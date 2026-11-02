// USB devices in the browser (R3.7b): Web Serial, with the same manifest as JSON lines. A Pico or an Arduino says
// {"omep-device":"0.1","manifest":{…}} and then sends {"values":{…}}. Chromium and Firefox 151+; never Safari.
export const serialSupported = () => 'serial' in navigator;

export interface SerialDevice {
  manifest: { engine: { id: string; name: string }; device: { hardware: string; controls: { id: string; label: string; kind: string }[]; outputs?: { id: string; kind: string }[] } };
}

/** Bytes come in pieces: whole lines out. Pure. */
export function lineSplitter(onLine: (line: string) => void) {
  let rest = '';
  return (text: string) => {
    const parts = (rest + text).split(/\r?\n/);
    rest = parts.pop() ?? '';
    for (const p of parts) if (p.trim()) onLine(p.trim());
  };
}

/** One line of the protocol. A line that isn't is ignored: serial ports start with noise. Pure. */
export function parseSerial(line: string): { hello: SerialDevice } | { values: Record<string, number> } | null {
  try {
    const m = JSON.parse(line) as { 'omep-device'?: string; manifest?: SerialDevice['manifest']; values?: Record<string, number> };
    if (m['omep-device'] && m.manifest?.device) return { hello: { manifest: m.manifest } };
    if (m.values) return { values: m.values };
  } catch {
    // noise
  }
  return null;
}

interface PortLike {
  open(o: { baudRate: number }): Promise<void>;
  readable: ReadableStream<Uint8Array>;
}

export async function connectSerial(onHello: (d: SerialDevice) => void, onValues: (v: Record<string, number>) => void, baudRate = 115200) {
  const port = (await (navigator as unknown as { serial: { requestPort(): Promise<PortLike> } }).serial.requestPort()) as PortLike;
  await port.open({ baudRate });
  const reader = port.readable.pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>).getReader();
  const feed = lineSplitter((line) => {
    const m = parseSerial(line);
    if (m && 'hello' in m) onHello(m.hello);
    else if (m) onValues(m.values);
  });
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      feed(value);
    }
  })();
}
