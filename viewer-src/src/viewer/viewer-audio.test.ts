// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AudioPlayerError, type AudioVolume } from './audio-player';
import { peer, settle, TestSession } from './test-session';
import { AUDIO_VOLUME_STORAGE_KEY, mountViewer, type AudioPlayerLike, type ViewerHandle } from './viewer';

vi.mock('../net/trust', () => ({ checkServerChain: vi.fn(), defaultAnchors: () => [] }));

/** Records its calls in the shared `log`, in order with the session's 46 commands. */
class FakePlayer implements AudioPlayerLike {
  readonly pushed: Int16Array[] = [];
  readonly volumes: AudioVolume[] = [];
  starts = 0;
  stops = 0;
  /** Set to make start() fail (rejects) or to hold it until `release()`. */
  failWith: Error | null = null;
  hold: Promise<void> | null = null;
  constructor(private readonly log: string[]) {}
  start(): Promise<void> {
    this.starts++;
    this.log.push('start');
    if (this.failWith) return Promise.reject(this.failWith);
    return this.hold ?? Promise.resolve();
  }
  push(pcm: Int16Array): void {
    this.pushed.push(pcm);
  }
  setVolume(v: AudioVolume): void {
    this.volumes.push(v);
  }
  stop(): void {
    this.stops++;
    this.log.push('stop');
  }
}

describe('computer audio in the viewer page', () => {
  let session: TestSession;
  let player: FakePlayer;
  let log: string[];
  let app: HTMLElement;
  let viewer: ViewerHandle;
  const $ = <T extends HTMLElement>(sel: string) => app.querySelector<T>(sel)!;
  const toggle = () => $<HTMLButtonElement>('#audio-toggle');
  const notice = () => $<HTMLElement>('#notice');

  function mount(): void {
    document.body.innerHTML = '<main id="app"></main>';
    app = document.getElementById('app')!;
    viewer = mountViewer(app, {
      createSession: () => session,
      workerUrl: 'ws://127.0.0.1:8787',
      schedule: (cb) => cb(),
      createAudioPlayer: () => player,
    });
  }

  function connect(): void {
    $<HTMLInputElement>('#partner').value = '123456789';
    $<HTMLInputElement>('#password').value = 'abc';
    $<HTMLFormElement>('#connect-form').dispatchEvent(new Event('submit', { cancelable: true }));
    session.emit({ type: 'accepted', peer: peer() });
  }

  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    localStorage.clear();
    sessionStorage.clear();
    log = [];
    session = new TestSession();
    const original = session.setComputerAudio.bind(session);
    session.setComputerAudio = async (on) => {
      log.push(on ? '46|||-1' : '46|||0');
      return original(on);
    };
    player = new FakePlayer(log);
    mount();
  });

  afterEach(() => {
    viewer.destroy();
    vi.restoreAllMocks();
  });

  test('off by default and disabled until connected', () => {
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(toggle().textContent).toBe('Âm thanh: tắt');
    expect(toggle().disabled).toBe(true);
    connect();
    expect(toggle().disabled).toBe(false);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(player.starts).toBe(0);
  });

  test('turning on starts the player synchronously inside the click, then asks the host (46|||-1)', async () => {
    connect();
    toggle().click();
    expect(log).toEqual(['start']); // before any await: still in the user gesture
    await settle();
    expect(log).toEqual(['start', '46|||-1']);
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(toggle().textContent).toBe('Âm thanh: bật');
  });

  test('audio events reach the player only while on', async () => {
    connect();
    const early = new Int16Array([1, 2]);
    session.emit({ type: 'audio', pcm: early });
    expect(player.pushed).toEqual([]);
    toggle().click();
    await settle();
    const pcm = new Int16Array([3, 4, 5, 6]);
    session.emit({ type: 'audio', pcm });
    expect(player.pushed).toEqual([pcm]);
  });

  test('turning off sends 46|||0 and stops the player; later audio is dropped', async () => {
    connect();
    toggle().click();
    await settle();
    toggle().click();
    await settle();
    expect(log).toEqual(['start', '46|||-1', 'stop', '46|||0']);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    session.emit({ type: 'audio', pcm: new Int16Array(2) });
    expect(player.pushed).toEqual([]);
  });

  test('a suspended context turns the toggle back off with the "press again" notice and no 46', async () => {
    connect();
    player.failWith = new AudioPlayerError('suspended');
    toggle().click();
    await settle();
    expect(log).toEqual(['start', 'stop']);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(notice().hidden).toBe(false);
    expect(notice().textContent).toContain('Trình duyệt chưa cho phát âm thanh — bấm Âm thanh lần nữa');
    // The next press works and clears the notice.
    player.failWith = null;
    toggle().click();
    await settle();
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(notice().textContent).not.toContain('Trình duyệt chưa cho phát');
    expect(log.at(-1)).toBe('46|||-1');
  });

  test('another start error turns it off with "Âm thanh máy tính đã dừng: …" (no content)', async () => {
    connect();
    player.failWith = new Error('secret details');
    toggle().click();
    await settle();
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(notice().textContent).toContain('Âm thanh máy tính đã dừng: Error');
    expect(notice().textContent).not.toContain('secret');
    expect(log).toEqual(['start', 'stop']);
  });

  test('a failed 46|||-1 stops the player and turns the toggle off', async () => {
    connect();
    session.failAudio = new Error('boom');
    toggle().click();
    await settle();
    expect(log).toEqual(['start', '46|||-1', 'stop']);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(notice().textContent).toContain('Âm thanh máy tính đã dừng');
  });

  test('turning off while the player is still starting never asks the host', async () => {
    connect();
    let release!: () => void;
    player.hold = new Promise<void>((r) => (release = r));
    toggle().click();
    toggle().click();
    release();
    await settle();
    expect(log).toEqual(['start', 'stop']);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
  });

  test('disconnecting stops the player and turns the toggle off without sending 46|||0', async () => {
    connect();
    toggle().click();
    await settle();
    session.emit({ type: 'closed', reason: 'partnerEnded' });
    expect(log).toEqual(['start', '46|||-1', 'stop']);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(toggle().disabled).toBe(true);
    session.emit({ type: 'audio', pcm: new Int16Array(2) });
    expect(player.pushed).toEqual([]);
  });

  test('a re-init (accepted again) while on asks the host for audio again', async () => {
    connect();
    toggle().click();
    await settle();
    session.emit({ type: 'accepted', peer: peer() });
    await settle();
    expect(log).toEqual(['start', '46|||-1', '46|||-1']);
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
  });

  test('a re-init while off sends nothing', async () => {
    connect();
    session.emit({ type: 'accepted', peer: peer() });
    await settle();
    expect(log).toEqual([]);
  });

  test('volume menu offers 25/50/75/100 %, applies to the player and is remembered only with "Nhớ trên thiết bị này"', async () => {
    const select = $<HTMLSelectElement>('#audio-volume');
    expect([...select.options].map((o) => o.textContent)).toEqual(['25%', '50%', '75%', '100%']);
    expect(select.value).toBe('1');
    connect();
    toggle().click();
    await settle();
    expect(player.volumes.at(-1)).toBe(1);
    select.value = '0.5';
    select.dispatchEvent(new Event('change'));
    expect(player.volumes.at(-1)).toBe(0.5);
    expect(localStorage.getItem(AUDIO_VOLUME_STORAGE_KEY)).toBeNull();

    const remember = $<HTMLInputElement>('#remember');
    remember.checked = true;
    remember.dispatchEvent(new Event('change'));
    expect(localStorage.getItem(AUDIO_VOLUME_STORAGE_KEY)).toBe('0.5');
    select.value = '0.25';
    select.dispatchEvent(new Event('change'));
    expect(localStorage.getItem(AUDIO_VOLUME_STORAGE_KEY)).toBe('0.25');

    viewer.destroy();
    mount();
    expect($<HTMLSelectElement>('#audio-volume').value).toBe('0.25');
    connect();
    $<HTMLButtonElement>('#audio-toggle').click();
    expect(player.volumes.at(-1)).toBe(0.25);

    $<HTMLInputElement>('#remember').checked = false;
    $<HTMLInputElement>('#remember').dispatchEvent(new Event('change'));
    expect(localStorage.getItem(AUDIO_VOLUME_STORAGE_KEY)).toBeNull();
  });

  test('a corrupt stored volume falls back to 100 %', () => {
    localStorage.setItem(AUDIO_VOLUME_STORAGE_KEY, '0.9');
    viewer.destroy();
    mount();
    expect($<HTMLSelectElement>('#audio-volume').value).toBe('1');
  });
});
