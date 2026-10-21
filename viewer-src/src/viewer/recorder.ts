// Silent screen recording of the decoded remote frame (port of MacViewer's RemoteVideoRecorder /
// RemoteCaptureController recording). Each NEW frame the page draws is copied, letterboxed on black,
// into a hidden canvas of at most 1920×1080 (even sides, never upscaled) at most 15 times a second;
// `canvas.captureStream(15)` feeds a MediaRecorder (video/mp4 when the browser can, otherwise
// video/webm; no audio track). The last frame is held until Stop (a 1 s keep-alive redraw plus a
// final redraw at Stop), and the result is a Blob the page offers for download. Nothing is persisted
// and nothing recorded is ever logged.
import { RECORD_FPS, recordBitrate, recordSize } from './capture';

/** A frame is drawn at most this often. */
export const MIN_FRAME_INTERVAL_MS = 1000 / RECORD_FPS;
/** With no new frame the last one is redrawn this often, so the video keeps its last picture. */
export const KEEPALIVE_MS = 1000;
/** `stop` should follow `MediaRecorder.stop()`; if a browser never fires it, finish with what arrived. */
const STOP_TIMEOUT_MS = 5000;

export type RecorderErrorCode = 'unsupported' | 'badSize' | 'noContext' | 'failed';

export class RecorderError extends Error {
  constructor(readonly code: RecorderErrorCode) {
    super(code);
    this.name = 'RecorderError';
  }
}

/** The parts of MediaRecorder the recorder uses (a fake one in tests). */
export interface MediaRecorderLike {
  readonly state: string;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((e: unknown) => void) | null;
  start(timesliceMs?: number): void;
  stop(): void;
}
export interface MediaRecorderCtor {
  new (stream: MediaStream, options?: { mimeType?: string; videoBitsPerSecond?: number }): MediaRecorderLike;
  isTypeSupported(mime: string): boolean;
}

export interface RecorderEnv {
  MediaRecorder?: MediaRecorderCtor;
  /** Whether canvases can be captured (HTMLCanvasElement.prototype.captureStream). */
  captureStream?: boolean;
}

export type RecorderSupport = { ok: true; mime: string; ext: 'mp4' | 'webm' } | { ok: false; reason: string };

export const UNSUPPORTED_REASON = 'Trình duyệt này không hỗ trợ quay video màn hình (MediaRecorder / captureStream).';

function defaultEnv(): RecorderEnv {
  return {
    MediaRecorder: typeof MediaRecorder === 'undefined' ? undefined : (MediaRecorder as unknown as MediaRecorderCtor),
    captureStream: typeof HTMLCanvasElement !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function',
  };
}

/** MP4 when the browser records it, otherwise WebM. */
export function recorderSupport(env: RecorderEnv = defaultEnv()): RecorderSupport {
  const Ctor = env.MediaRecorder;
  if (!Ctor || !env.captureStream) return { ok: false, reason: UNSUPPORTED_REASON };
  const mp4 = typeof Ctor.isTypeSupported === 'function' && Ctor.isTypeSupported('video/mp4');
  return mp4 ? { ok: true, mime: 'video/mp4', ext: 'mp4' } : { ok: true, mime: 'video/webm', ext: 'webm' };
}

export interface Recording {
  blob: Blob;
  mime: string;
  ext: 'mp4' | 'webm';
  /** Length in seconds. */
  seconds: number;
  /** When the recording started (the file name's timestamp). */
  startedAt: Date;
}

export interface RecorderOptions {
  /** The screen canvas: the decoded frame cropped to the selected monitor. */
  source: HTMLCanvasElement;
  /** Seconds elapsed, once a second while recording. */
  onTick(seconds: number): void;
  /** The browser's encoder failed; the recording was finished with what it had (see `stop()`). */
  onError?(): void;
  env?: RecorderEnv;
  now?: () => number;
  createCanvas?: () => HTMLCanvasElement;
}

/** What the page needs from a recording (a fake in tests). */
export interface RecorderLike {
  /** A new frame was drawn on the source canvas. */
  frame(): void;
  /** Finishes the recording; null when nothing usable was recorded. Calling it again returns the same result. */
  stop(): Promise<Recording | null>;
  /** Throws the recording away. */
  abort(): void;
}

export class ScreenRecorder implements RecorderLike {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly recorder: MediaRecorderLike;
  private readonly stream: MediaStream;
  private readonly chunks: Blob[] = [];
  private readonly mime: string;
  private readonly ext: 'mp4' | 'webm';
  private readonly now: () => number;
  private readonly startedMs: number;
  private readonly startedAt = new Date();
  private lastDrawMs: number;
  private pending: ReturnType<typeof setTimeout> | null = null;
  private clock: ReturnType<typeof setInterval> | null = null;
  private state: 'recording' | 'stopping' | 'done' = 'recording';
  private result: Promise<Recording | null> | null = null;
  private finishResult: ((r: Recording | null) => void) | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(private readonly o: RecorderOptions, size: { width: number; height: number }, support: Extract<RecorderSupport, { ok: true }>) {
    const env = o.env ?? defaultEnv();
    this.now = o.now ?? (() => performance.now());
    this.canvas = (o.createCanvas ?? (() => document.createElement('canvas')))();
    this.canvas.width = size.width;
    this.canvas.height = size.height;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new RecorderError('noContext');
    this.ctx = ctx;
    this.mime = support.mime;
    this.ext = support.ext;
    try {
      this.stream = this.canvas.captureStream(RECORD_FPS);
      this.recorder = new env.MediaRecorder!(this.stream, {
        mimeType: support.mime,
        videoBitsPerSecond: recordBitrate(size.width, size.height),
      });
    } catch {
      throw new RecorderError('failed');
    }
    this.startedMs = this.now();
    this.lastDrawMs = Number.NEGATIVE_INFINITY;
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.onstop = () => this.finish();
    this.recorder.onerror = () => {
      if (this.state !== 'recording') return;
      this.o.onError?.();
      void this.stop();
    };
    // The first frame is drawn before the encoder starts, so even a static desktop has a picture.
    this.draw();
    try {
      this.recorder.start(1000);
    } catch {
      this.release();
      throw new RecorderError('failed');
    }
    this.clock = setInterval(() => this.tick(), 1000);
  }

  /** Starts recording the current content of `o.source`. Throws RecorderError. */
  static start(o: RecorderOptions): ScreenRecorder {
    const support = recorderSupport(o.env ?? defaultEnv());
    if (!support.ok) throw new RecorderError('unsupported');
    const size = recordSize(o.source.width, o.source.height);
    if (!size) throw new RecorderError('badSize');
    return new ScreenRecorder(o, size, support);
  }

  get seconds(): number {
    return Math.max(0, Math.floor((this.now() - this.startedMs) / 1000));
  }

  frame(): void {
    if (this.state !== 'recording') return;
    const wait = this.lastDrawMs + MIN_FRAME_INTERVAL_MS - this.now();
    if (wait <= 0) {
      this.draw();
    } else if (this.pending === null) {
      // Too soon: the newest frame is drawn when the interval is over.
      this.pending = setTimeout(() => {
        this.pending = null;
        if (this.state === 'recording') this.draw();
      }, wait);
    }
  }

  stop(): Promise<Recording | null> {
    if (this.result) return this.result;
    this.result = new Promise((resolve) => {
      this.finishResult = resolve;
    });
    this.state = 'stopping';
    this.clearTimers();
    this.draw(); // hold the last picture until the very end
    const track = this.stream.getVideoTracks()[0] as (MediaStreamTrack & { requestFrame?: () => void }) | undefined;
    track?.requestFrame?.();
    this.stopTimer = setTimeout(() => this.finish(), STOP_TIMEOUT_MS);
    try {
      if (this.recorder.state !== 'inactive') this.recorder.stop();
      else this.finish();
    } catch {
      this.finish();
    }
    return this.result;
  }

  abort(): void {
    if (this.state === 'done') return;
    this.state = 'done';
    this.clearTimers();
    this.recorder.ondataavailable = null;
    this.recorder.onstop = null;
    this.recorder.onerror = null;
    try {
      if (this.recorder.state !== 'inactive') this.recorder.stop();
    } catch {
      // Already stopped.
    }
    this.release();
    this.chunks.length = 0;
    this.finishResult?.(null);
    this.result ??= Promise.resolve(null);
  }

  private tick(): void {
    this.o.onTick(this.seconds);
    if (this.state === 'recording' && this.now() - this.lastDrawMs >= KEEPALIVE_MS) this.draw();
  }

  private draw(): void {
    const src = this.o.source;
    const { width: W, height: H } = this.canvas;
    const sw = src.width;
    const sh = src.height;
    this.lastDrawMs = this.now();
    if (sw <= 0 || sh <= 0) return;
    const scale = Math.min(W / sw, H / sh);
    const w = Math.round(sw * scale);
    const h = Math.round(sh * scale);
    if (w < W || h < H) {
      this.ctx.fillStyle = '#000';
      this.ctx.fillRect(0, 0, W, H);
    }
    this.ctx.drawImage(src, Math.floor((W - w) / 2), Math.floor((H - h) / 2), w, h);
  }

  private clearTimers(): void {
    if (this.pending !== null) clearTimeout(this.pending);
    this.pending = null;
    if (this.clock !== null) clearInterval(this.clock);
    this.clock = null;
  }

  private release(): void {
    for (const t of this.stream.getTracks()) t.stop();
  }

  private finish(): void {
    if (this.state === 'done') return;
    this.state = 'done';
    this.clearTimers();
    if (this.stopTimer !== null) clearTimeout(this.stopTimer);
    this.stopTimer = null;
    this.release();
    const blob = new Blob(this.chunks, { type: this.mime });
    this.chunks.length = 0;
    this.finishResult?.(
      blob.size > 0 ? { blob, mime: this.mime, ext: this.ext, seconds: this.seconds, startedAt: this.startedAt } : null,
    );
  }
}
