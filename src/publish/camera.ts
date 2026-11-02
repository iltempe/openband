// The camera look (C3.c): the webcam recorded with the take, and its frames for the clip.
import { engine } from '../audio/engine';
import { tx } from '../storage/idb';
import { useStore } from '../store';
import { uid } from '../music';

export interface CameraTake {
  id: string;
  projectId: string;
  /** Where it starts on the song, in seconds. */
  startS: number;
  type: string;
  blob: Blob;
  createdAt: number;
}

/** Enough to see a performance, small enough to carry 30 s in memory. */
export const FRAME_W = 360;
export const FRAME_H = 640;
export const CAMERA_FPS = 10;

let active: { stop: () => Promise<CameraTake> } | null = null;

/** Start the song with the camera on. Stop ends both. */
export async function startCameraTake() {
  if (active) throw new Error('The camera is already recording');
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 720, height: 1280, facingMode: 'user' }, audio: false });
  const type = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t))!;
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 2_500_000 });
  const parts: Blob[] = [];
  rec.ondataavailable = (e) => parts.push(e.data);
  const startS = (engine.position * 60) / useStore.getState().project.bpm;
  rec.start();
  await engine.play();
  useStore.getState().set({ isPlaying: true });
  active = {
    stop: () =>
      new Promise((resolve) => {
        rec.onstop = async () => {
          stream.getTracks().forEach((t) => t.stop());
          engine.stop();
          useStore.getState().set({ isPlaying: false });
          const take: CameraTake = { id: uid('cam'), projectId: useStore.getState().project.meta?.projectId ?? 'local', startS, type, blob: new Blob(parts, { type }), createdAt: Date.now() };
          await tx('media', 'readwrite', (s) => s.put(take));
          active = null;
          resolve(take);
        };
        rec.stop();
      }),
  };
}

export const stopCameraTake = () => {
  if (!active) throw new Error('The camera is not recording');
  return active.stop();
};

export async function latestCameraTake(projectId: string) {
  const all = (await tx<CameraTake[]>('media', 'readonly', (s) => s.getAll())) ?? [];
  return all.filter((t) => t.projectId === projectId).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

/** Seek through the recording: the worker can't decode video here, so the frames travel as bitmaps. */
export async function cameraFrames(take: CameraTake, fromS: number, seconds: number) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.src = URL.createObjectURL(take.blob);
  await new Promise((r, f) => ((video.onloadeddata = r), (video.onerror = () => f(new Error('The camera take does not open')))));
  const frames: ImageBitmap[] = [];
  const offset = fromS - take.startS;
  const n = Math.ceil(seconds * CAMERA_FPS);
  for (let i = 0; i < n; i++) {
    const at = Math.max(0, offset + i / CAMERA_FPS);
    if (Number.isFinite(video.duration) && at > video.duration) break;
    video.currentTime = at;
    await new Promise((r) => (video.onseeked = r));
    frames.push(await createImageBitmap(video, { resizeWidth: FRAME_W, resizeHeight: FRAME_H, resizeQuality: 'medium' }));
  }
  URL.revokeObjectURL(video.src);
  return frames;
}
