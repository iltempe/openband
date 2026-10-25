// Runs the separation model off the main thread: onnxruntime-web on WebAssembly (bundled with the studio,
// fetched only when someone separates). One session per worker, one segment per message.
import * as ort from 'onnxruntime-web/wasm';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import mjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';

ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: mjsUrl };
// Threads need a cross-origin isolated page; otherwise one thread (slower, same result).
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

let session: ort.InferenceSession | null = null;

type In = { type: 'load'; model: ArrayBuffer } | { type: 'run'; id: number; segment: number; mix: Float32Array };

self.onmessage = async (ev: MessageEvent<In>) => {
  const m = ev.data;
  try {
    if (m.type === 'load') {
      // The graph optimizer expands HT-Demucs' fp16 weights past WebAssembly's 4 GB: run it as exported.
      session = await ort.InferenceSession.create(new Uint8Array(m.model), { executionProviders: ['wasm'], graphOptimizationLevel: 'disabled', enableCpuMemArena: false, enableMemPattern: false });
      self.postMessage({ type: 'loaded', inputs: session.inputNames, outputs: session.outputNames });
      return;
    }
    if (!session) throw new Error('The separation model is not loaded');
    const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', m.mix, [1, 2, m.segment]) });
    const stems = out[session.outputNames[0]].data as Float32Array;
    self.postMessage({ type: 'stems', id: m.id, stems }, { transfer: [stems.buffer] });
  } catch (e) {
    self.postMessage({ type: 'error', id: m.type === 'run' ? m.id : -1, message: (e as Error).message ?? String(e) });
  }
};
