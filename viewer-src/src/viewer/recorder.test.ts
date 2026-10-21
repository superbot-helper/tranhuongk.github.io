// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { recordBitrate } from './capture';
import {
  KEEPALIVE_MS,
  MIN_FRAME_INTERVAL_MS,
  recorderSupport,
  RecorderError,
  ScreenRecorder,
  UNSUPPORTED_REASON,
  type MediaRecorderCtor,
  type MediaRecorderLike,
} from './recorder';

class FakeRecorder implements MediaRecorderLike {
  static instances: FakeRecorder[] = [];
  static mp4 = false;
  static isTypeSupported(mime: string): boolean {
    return mime === 'video/webm' || (FakeRecorder.mp4 && mime === 'video/mp4');
  }
  state = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  timeslice: number | undefined;
  /** What stop() emits before the stop event. */
  flush: Blob[] = [new Blob(['video-bytes'])];
  /** Set to leave the stop event unfired. */
  stuck = false;
  constructor(
    readonly stream: MediaStream,
    readonly options?: { mimeType?: string; videoBitsPerSecond?: number },
  ) {
    FakeRecorder.instances.push(this);
  }
  start(timeslice?: number): void {
    this.timeslice = timeslice;
    this.state = 'recording';
  }
  stop(): void {
    this.state = 'inactive';
    if (this.stuck) return;
    for (const data of this.flush) this.ondataavailable?.({ data });
    this.onstop?.();
  }
}

interface DrawCall {
  op: string;
  args: unknown[];
}

describe('recorderSupport', () => {
  test('mp4 when the browser records it, otherwise webm', () => {
    FakeRecorder.mp4 = true;
    expect(recorderSupport({ MediaRecorder: FakeRecorder as unknown as MediaRecorderCtor, captureStream: true })).toEqual({
      ok: true,
      mime: 'video/mp4',
      ext: 'mp4',
    });
    FakeRecorder.mp4 = false;
    expect(recorderSupport({ MediaRecorder: FakeRecorder as unknown as MediaRecorderCtor, captureStream: true })).toEqual({
      ok: true,
      mime: 'video/webm',
      ext: 'webm',
    });
  });

  test('missing MediaRecorder or captureStream gives a reason', () => {
    expect(recorderSupport({ captureStream: true })).toEqual({ ok: false, reason: UNSUPPORTED_REASON });
    expect(recorderSupport({ MediaRecorder: FakeRecorder as unknown as MediaRecorderCtor })).toEqual({ ok: false, reason: UNSUPPORTED_REASON });
  });
});

describe('ScreenRecorder', () => {
  let draws: DrawCall[];
  let nowMs: number;
  let requestFrames: number;
  let trackStops: number;
  let source: HTMLCanvasElement;
  let ticks: number[];
  let errors: number;
  const env = () => ({ MediaRecorder: FakeRecorder as unknown as MediaRecorderCtor, captureStream: true });

  function makeCanvas(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    (c as unknown as { captureStream: (fps: number) => MediaStream }).captureStream = (fps) => {
      captured.push(fps);
      const track = { requestFrame: () => requestFrames++, stop: () => trackStops++ } as unknown as MediaStreamTrack;
      return { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
    };
    return c;
  }
  let captured: number[];

  function start(width = 1280, height = 720): ScreenRecorder {
    source.width = width;
    source.height = height;
    return ScreenRecorder.start({
      source,
      env: env(),
      now: () => nowMs,
      createCanvas: makeCanvas,
      onTick: (s) => ticks.push(s),
      onError: () => errors++,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    FakeRecorder.instances = [];
    FakeRecorder.mp4 = false;
    draws = [];
    captured = [];
    ticks = [];
    errors = 0;
    nowMs = 0;
    requestFrames = 0;
    trackStops = 0;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => {
      const state: Record<string, unknown> = {};
      return new Proxy(state, {
        get: (t, p: string) => (p in t ? t[p] : (...args: unknown[]) => draws.push({ op: p, args })),
        set: (t, p: string, v) => ((t[p] = v), true),
      });
    }) as never);
    source = document.createElement('canvas');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const drawImages = () => draws.filter((d) => d.op === 'drawImage');

  test('records a canvas of the capped size at 15 fps with the bitrate formula and the browser format', () => {
    FakeRecorder.mp4 = true;
    const rec = start(2560, 1440);
    const media = FakeRecorder.instances[0]!;
    expect(captured).toEqual([15]);
    expect(media.options).toEqual({ mimeType: 'video/mp4', videoBitsPerSecond: recordBitrate(1920, 1080) });
    expect(media.state).toBe('recording');
    expect(rec.seconds).toBe(0);
    // The first frame is already on the canvas: full size, so no letterbox fill.
    expect(drawImages()).toHaveLength(1);
    expect(drawImages()[0]!.args).toEqual([source, 0, 0, 1920, 1080]);
    expect(draws.some((d) => d.op === 'fillRect')).toBe(false);
  });

  test('a source that changes shape is letterboxed on black and centred in the fixed recording canvas', () => {
    const rec = start(801, 601); // records 800×600
    expect(drawImages()[0]!.args).toEqual([source, 0, 0, 800, 600]);
    draws.length = 0;
    source.width = 1600; // the monitor changed to a wider crop
    source.height = 600;
    nowMs += 1000;
    rec.frame();
    expect(draws.find((d) => d.op === 'fillRect')!.args).toEqual([0, 0, 800, 600]);
    expect(drawImages()[0]!.args).toEqual([source, 0, 150, 800, 300]);
  });

  test('frames are drawn at most 15 times a second; the newest one is drawn when the interval is over', () => {
    const rec = start();
    draws.length = 0;
    nowMs = 10;
    rec.frame();
    nowMs = 30;
    rec.frame();
    expect(drawImages()).toHaveLength(0);
    nowMs = MIN_FRAME_INTERVAL_MS;
    vi.advanceTimersByTime(Math.ceil(MIN_FRAME_INTERVAL_MS));
    expect(drawImages()).toHaveLength(1);
    // After the interval a frame is drawn at once.
    nowMs = 200;
    rec.frame();
    expect(drawImages()).toHaveLength(2);
  });

  test('a burst of frames never draws more than 15 a second', () => {
    const rec = start();
    draws.length = 0;
    for (let t = 1; t <= 1000; t += 5) {
      nowMs = t;
      rec.frame();
      vi.advanceTimersByTime(5);
    }
    expect(drawImages().length).toBeLessThanOrEqual(15);
    expect(drawImages().length).toBeGreaterThanOrEqual(12);
  });

  test('ticks once a second and redraws the last frame when the desktop is static', () => {
    start();
    draws.length = 0;
    nowMs = 1000;
    vi.advanceTimersByTime(1000);
    expect(ticks).toEqual([1]);
    expect(drawImages()).toHaveLength(1); // keep-alive: nothing new for a second
    draws.length = 0;
    nowMs = 1500;
    vi.advanceTimersByTime(1000);
    expect(ticks).toEqual([1, 1]);
    expect(drawImages()).toHaveLength(0); // only 500 ms since the last draw
  });

  test('stop holds the last frame, finalizes and returns the blob with the stream released', async () => {
    const rec = start();
    nowMs = 3400;
    draws.length = 0;
    const result = await rec.stop();
    expect(drawImages()).toHaveLength(1); // the held last frame
    expect(requestFrames).toBe(1);
    expect(trackStops).toBe(1);
    expect(result).not.toBeNull();
    expect(result!.ext).toBe('webm');
    expect(result!.mime).toBe('video/webm');
    expect(result!.seconds).toBe(3);
    expect(result!.blob.type).toBe('video/webm');
    expect(result!.blob.size).toBeGreaterThan(0);
    expect(FakeRecorder.instances[0]!.state).toBe('inactive');
    // Frames after stop draw nothing; a second stop returns the same result.
    draws.length = 0;
    nowMs += 1000;
    rec.frame();
    expect(drawImages()).toHaveLength(0);
    expect(await rec.stop()).toBe(result);
  });

  test('an empty recording is reported as null', async () => {
    const rec = start();
    FakeRecorder.instances[0]!.flush = [];
    expect(await rec.stop()).toBeNull();
  });

  test('a browser that never fires stop is finished with what it delivered', async () => {
    const rec = start();
    const media = FakeRecorder.instances[0]!;
    media.stuck = true;
    media.ondataavailable?.({ data: new Blob(['partial']) });
    const pending = rec.stop();
    await vi.advanceTimersByTimeAsync(5000);
    const result = await pending;
    expect(result!.blob.size).toBe(7);
  });

  test('an encoder error ends the recording with what it has and tells the page', async () => {
    const rec = start();
    const media = FakeRecorder.instances[0]!;
    media.onerror?.(new Event('error'));
    expect(errors).toBe(1);
    expect((await rec.stop())?.blob.size).toBeGreaterThan(0);
  });

  test('abort throws everything away and releases the stream', async () => {
    const rec = start();
    rec.abort();
    expect(trackStops).toBe(1);
    expect(FakeRecorder.instances[0]!.state).toBe('inactive');
    expect(await rec.stop()).toBeNull();
    rec.abort();
  });

  test('refuses a missing encoder, an unusable size and a context-less canvas', () => {
    expect(() => ScreenRecorder.start({ source, onTick: () => {}, env: {} })).toThrow(RecorderError);
    source.width = 0;
    source.height = 0;
    expect(() => ScreenRecorder.start({ source, env: env(), onTick: () => {}, createCanvas: makeCanvas })).toThrow(
      expect.objectContaining({ code: 'badSize' }),
    );
    source.width = 100;
    source.height = 100;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(() => ScreenRecorder.start({ source, env: env(), onTick: () => {}, createCanvas: makeCanvas })).toThrow(
      expect.objectContaining({ code: 'noContext' }),
    );
  });
});
