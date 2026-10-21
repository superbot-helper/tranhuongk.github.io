// Desktop viewer page: connect form (collapsed once connected), toolbar, the remote screen and
// a collapsible Diagnostics section (the phase-0 spike log). Control state:
//   effective control = local "Điều khiển" toggle && host permission (init / command 49) && accepted.
// The permission is re-read from `peer.allowsRemoteInput` on every `accepted`, because a screen
// refresh (or host command 23) re-initializes with `inputPermission(false)` before it and no
// `inputPermission(true)` after it.
// Chat (panel + unread badge), file transfer (cards in the chat, drop zone on the screen) and
// opt-in clipboard sharing work while the session's tool gate is
// open (`tools` events), independent of control; pasting into the controlled screen uploads the
// clipboard (when sharing is on) and types Ctrl+V on Windows.
import { DEFAULT_DISPLAY_NAME } from '../proto/client-defaults';
import { monitorRegion, type QualityPreset, type RemoteCommand } from '../proto/commands';
import { cursorShapeRequest, type CursorEvent } from '../proto/cursor';
import type { ScreenBitmap } from '../proto/screen-renderer';
import { createIdentity, forgetDevice, IDENTITY_STORAGE_KEY, loadIdentity, saveIdentity, type ClientIdentity } from '../session/identity';
import { createFrameScheduler } from '../session/latest-frame';
import {
  RelaySessionError,
  type ConnectOptions,
  type Peer,
  type SessionDiagnostics,
  type SessionEvent,
  type SessionPhase,
} from '../session/relay-session';
import { connectFormError, formatStats, mountDiagnostics, purgeLegacyToken, readStorage, REASONS } from '../spike/diagnostics';
import { AUDIO_VOLUMES, AudioPlayer, AudioPlayerError, type AudioVolume } from './audio-player';
import { openAnnotator, type AnnotatorHandle } from './annotate';
import { captureFileName, downloadBlob, downloadUrl, pngDataUrl, snapshotCanvas } from './capture';
import { createCaptureToast, type CaptureToast } from './capture-toast';
import { createChatPanel } from './chat-panel';
import { ClipboardSync } from './clipboard-sync';
import { CursorLayer } from './cursor-layer';
import { attachDropZone, createFileTransfers, type FileTransferSession, type UnclaimedFile } from './file-transfers';
import { DesktopInput } from './input';
import { RecorderError, recorderSupport, ScreenRecorder, type RecorderLike, type RecorderOptions, type RecorderSupport, type Recording } from './recorder';
import { ScreenView, type Crop, type ScaleMode } from './screen';
import { createToolbar, type CaptureKind, type SpecialKey } from './toolbar';
import { attachTouch, ViewZoom } from './touch';

/** The RelaySession surface the page uses (a fake one in tests and in the dev-only demo). */
export interface ViewerSession extends FileTransferSession {
  readonly phase: SessionPhase;
  readonly diagnostics: Readonly<SessionDiagnostics>;
  connect(o: ConnectOptions, on: (e: SessionEvent) => void): void;
  send(bytes: Uint8Array, formatFlag?: boolean): Promise<void>;
  sendCommand(c: RemoteCommand, opts: { requiresControl: boolean }): Promise<void>;
  refreshScreen(): Promise<void>;
  canUseSessionTools(): boolean;
  sendChat(text: string): Promise<void>;
  sendTyping(typing: boolean): Promise<void>;
  setClipboardSharing(on: boolean): void;
  /** Command 46 (`active` only). */
  setComputerAudio(on: boolean): Promise<void>;
  sendClipboard(text: string): Promise<void>;
  close(): void;
}

export interface ViewerDeps {
  createSession(o: { workerUrl: string }): ViewerSession;
  workerUrl: string;
  /** Frame draw tick; defaults to requestAnimationFrame. */
  schedule?: (cb: () => void) => void;
  /** Why this page cannot connect at all (insecure context: no crypto.subtle); shown at load, connecting is refused. */
  insecureNotice?: string | null;
  /** The computer-audio player (a fake one in tests); created on the first click of "Âm thanh". */
  createAudioPlayer?: () => AudioPlayerLike;
  /** Local screen size in device pixels (login fields 3/4). */
  screenSize?: () => { width: number; height: number };
  /** Screen recording (a fake one in tests); defaults to MediaRecorder on a canvas. */
  recording?: ScreenRecording;
}

/** The recording surface the page uses. */
export interface ScreenRecording {
  support(): RecorderSupport;
  /** Starts recording the screen canvas; throws RecorderError. */
  start(o: Pick<RecorderOptions, 'source' | 'onTick' | 'onError'>): RecorderLike;
}

const defaultRecording: ScreenRecording = {
  support: () => recorderSupport(),
  start: (o) => ScreenRecorder.start(o),
};

/** The AudioPlayer surface the page uses. */
export interface AudioPlayerLike {
  start(): Promise<void>;
  push(pcm: Int16Array): void;
  setVolume(volume: AudioVolume): void;
  stop(): void;
}

export interface ViewerHandle {
  destroy(): void;
}

const OLD_PEER_NOTICE = 'Máy Windows dùng UltraViewer cũ (< 6.2.13): chỉ điều khiển chuột';
const VIEW_ONLY_NOTICE = 'Máy Windows đang để chế độ chỉ xem: chuột và bàn phím không được gửi.';
/** After a trackpad move, host pointer positions (older, by the round trip) are not drawn for this long. */
const LOCAL_POINTER_HOLD_MS = 500;
const TOOLS_UNAVAILABLE = 'Chat, file và clipboard dùng được khi đã kết nối xong với máy Windows.';
const DROP_HINT = 'Thả file để gửi sang máy Windows';
/** "1" when clipboard sharing should start on (stored only with "Nhớ trên thiết bị này"). */
export const CLIPBOARD_STORAGE_KEY = 'uvweb.clipboard';
/** Remembered computer-audio volume (0.25 | 0.5 | 0.75 | 1; stored only with "Nhớ trên thiết bị này"). */
export const AUDIO_VOLUME_STORAGE_KEY = 'uvweb.audioVolume';
const AUDIO_SUSPENDED_NOTICE = 'Trình duyệt chưa cho phát âm thanh — bấm Âm thanh lần nữa';
const OVERFLOW_NOTICE = 'Hàng đợi chuột/bàn phím bị đầy: đã thả mọi phím và nút, Điều khiển đã tắt. Bật lại để tiếp tục.';

const LAYOUT = `
  <header class="top">
    <h1>Điều khiển máy tính</h1>
    <p class="lede">Nhập ID và mật khẩu đang hiện trong UltraViewer trên máy Windows.</p>
    <form id="connect-form" autocomplete="off">
      <label>ID đối tác
        <input id="partner" inputmode="numeric" autocomplete="off" required></label>
      <label>Mật khẩu đối tác
        <input id="password" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>
      <label class="check"><input id="remember" type="checkbox"> Nhớ trên thiết bị này</label>
      <div class="row">
        <button id="connect" type="submit" class="primary">Kết nối</button>
        <button id="disconnect" type="button" class="text" disabled>Huỷ</button>
      </div>
      <button id="forget" type="button" class="text secondary">Quên thiết bị này</button>
    </form>
    <p id="status" role="status">Chưa kết nối</p>
    <p id="env-notice" role="alert" hidden></p>
  </header>
  <section id="stage">
    <div id="toolbar" hidden></div>
    <p id="notice" role="alert" hidden></p>
    <div id="viewport" class="viewport">
      <div id="zoom" class="zoom">
        <canvas id="screen" width="16" height="9"></canvas>
        <canvas id="cursor-layer" aria-hidden="true"></canvas>
      </div>
      <textarea id="keyboard-input" aria-label="Bàn phím gửi tới máy Windows" autocomplete="off" autocapitalize="off"
        autocorrect="off" spellcheck="false" tabindex="-1"></textarea>
      <div id="composition" class="composition" aria-hidden="true" hidden></div>
    </div>
    <div id="chat-panel"></div>
    <div id="clipboard-toast"></div>
    <div id="capture-toast"></div>
    <div id="file-toast"></div>
  </section>
  <details id="diagnostics"></details>`;

export function mountViewer(app: HTMLElement, deps: ViewerDeps): ViewerHandle {
  app.innerHTML = LAYOUT;
  const $ = <T extends HTMLElement>(id: string) => app.querySelector<T>(`#${id}`)!;
  const form = $<HTMLFormElement>('connect-form');
  const remember = $<HTMLInputElement>('remember');
  const partner = $<HTMLInputElement>('partner');
  const password = $<HTMLInputElement>('password');
  const connectButton = $<HTMLButtonElement>('connect');
  const cancelButton = $<HTMLButtonElement>('disconnect');
  const forgetButton = $<HTMLButtonElement>('forget');
  const statusEl = $<HTMLParagraphElement>('status');
  const stage = $<HTMLElement>('stage');
  const toolbarEl = $<HTMLDivElement>('toolbar');
  const noticeEl = $<HTMLParagraphElement>('notice');
  const envNotice = $<HTMLParagraphElement>('env-notice');
  const viewport = $<HTMLDivElement>('viewport');
  const canvas = $<HTMLCanvasElement>('screen');
  const textarea = $<HTMLTextAreaElement>('keyboard-input');
  const diag = mountDiagnostics($<HTMLDetailsElement>('diagnostics'), {
    workerUrl: deps.workerUrl,
  });
  const { log } = diag;

  // --- identity (phase-0 rules); the Worker has no token any more -------------------------
  purgeLegacyToken();
  let identity: ClientIdentity = loadIdentity() ?? createIdentity();
  remember.checked = readStorage(() => localStorage, IDENTITY_STORAGE_KEY) !== null;
  const blocked = deps.insecureNotice ?? null;
  if (blocked) {
    envNotice.textContent = blocked;
    envNotice.hidden = false;
    connectButton.disabled = true;
    log(blocked);
  }
  log(`Trang sẵn sàng. Worker: ${deps.workerUrl || '(chưa cấu hình — nhập trong Diagnostics)'}`);

  /** saveIdentity throws on blocked storage: keep everything in memory for this tab. */
  const persist = () => {
    try {
      saveIdentity(identity, remember.checked);
    } catch (e) {
      log(`Cảnh báo: không lưu được vào storage (${(e as Error).name}); danh tính chỉ giữ trong tab này.`);
    }
  };
  remember.addEventListener('change', persist);

  // Clipboard sharing preference: off by default, kept on the device only when remembered.
  let clipboardOn = readStorage(() => localStorage, CLIPBOARD_STORAGE_KEY) === '1';
  const persistClipboard = () => {
    try {
      if (remember.checked && clipboardOn) localStorage.setItem(CLIPBOARD_STORAGE_KEY, '1');
      else localStorage.removeItem(CLIPBOARD_STORAGE_KEY);
    } catch {
      // Blocked storage: the choice lives in this tab only.
    }
  };
  remember.addEventListener('change', persistClipboard);

  // Computer-audio volume: remembered on the device only with "Nhớ trên thiết bị này".
  let audioVolume: AudioVolume = (() => {
    const v = Number(readStorage(() => localStorage, AUDIO_VOLUME_STORAGE_KEY));
    return AUDIO_VOLUMES.find((x) => x === v) ?? 1;
  })();
  const persistAudioVolume = () => {
    try {
      if (remember.checked) localStorage.setItem(AUDIO_VOLUME_STORAGE_KEY, String(audioVolume));
      else localStorage.removeItem(AUDIO_VOLUME_STORAGE_KEY);
    } catch {
      // Blocked storage: the choice lives in this tab only.
    }
  };
  remember.addEventListener('change', persistAudioVolume);

  // --- session state ------------------------------------------------------------------------
  let session: ViewerSession | null = null;
  let peer: Peer | null = null;
  let controlOn = true;
  let controlAllowed = false;
  let overflowNotice = false;
  // Computer audio: `audioOn` = the toggle (start requested), `audioLive` = the player runs and
  // command 46 was sent (or is being sent). `audioGen` invalidates a start that finished after a stop/close.
  let audioPlayer: AudioPlayerLike | null = null;
  let audioOn = false;
  let audioLive = false;
  let audioGen = 0;
  let audioNotice = '';
  let selectedMonitor = 0;
  // Screenshots / recording. `captureModal` pauses input to Windows while the annotator is open.
  let captureModal: AnnotatorHandle | null = null;
  let recorder: RecorderLike | null = null;
  let recordingName = '';
  let recordingSeconds = 0;
  let frameSeen = false;
  let destroyed = false;
  const recording = deps.recording ?? defaultRecording;
  let startedAt = 0;
  let clock: ReturnType<typeof setInterval> | null = null;

  const screenView = new ScreenView(canvas, viewport);
  // Local pinch-zoom (touch) of the screen + overlay wrapper; nothing is sent for it.
  const zoom = new ViewZoom($<HTMLDivElement>('zoom'));
  /** Touch must not pop the soft keyboard up: only the ⌨ button focuses the textarea then. */
  let lastPointerType = '';
  const onAnyPointerDown = (e: PointerEvent) => {
    lastPointerType = e.pointerType;
  };
  document.addEventListener('pointerdown', onAnyPointerDown, true);
  /** When the last trackpad move was drawn locally (performance.now()). */
  let localPointerAt = Number.NEGATIVE_INFINITY;
  /** The latest host position received during the hold, applied once it ends (28 is sent on change only). */
  let heldPosition: CursorEvent | null = null;
  let heldTimer: ReturnType<typeof setTimeout> | null = null;
  // Remote pointer overlay; hides the browser cursor (controlling) only once a real shape is known.
  let cursorKnown = false;
  let controlActive = false;
  const updateControlling = () => viewport.classList.toggle('controlling', controlActive && cursorKnown);
  const cursorLayer = new CursorLayer(
    $<HTMLCanvasElement>('cursor-layer'),
    (hash) => {
      session?.send(cursorShapeRequest(hash)).catch((e: unknown) => {
        if (session?.phase !== 'closed') log(`Hỏi hình con trỏ lỗi: ${describe(e)}`);
      });
    },
    {
      schedule: deps.schedule,
      onKnownChange: (known) => {
        cursorKnown = known;
        updateControlling();
      },
    },
  );
  /** The overlay follows the screen canvas box, frame size, crop and scale (inside the zoom wrapper: unzoomed). */
  const syncCursorView = () => cursorLayer.setView(zoom.layoutView(screenView.view()));
  const paintFrame = (bitmap: ScreenBitmap) => {
    screenView.draw(bitmap);
    syncCursorView();
    recorder?.frame();
    if (!frameSeen) {
      frameSeen = true;
      refreshCapture();
    }
  };
  const draw = createFrameScheduler<ScreenBitmap>(paintFrame, deps.schedule);
  const resizeObserver =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          zoom.refit();
          syncCursorView();
          placeChat();
        })
      : null;
  resizeObserver?.observe(viewport);
  resizeObserver?.observe(canvas);
  const input = new DesktopInput({
    canvas,
    textarea,
    composition: $<HTMLDivElement>('composition'),
    view: () => screenView.view(),
    onOverflow: () => {
      controlOn = false;
      overflowNotice = true;
      log('Hàng đợi input tràn (8192): đã thả mọi phím/nút và tắt Điều khiển.');
      refreshControl();
    },
    onSendError: (e) => {
      if (session?.phase !== 'closed') log(`Gửi input lỗi: ${e instanceof RelaySessionError ? e.code : (e as Error).name}`);
    },
    onPaste: (text) => clipboardSync.paste(text),
  });

  function onCursorEvent(event: CursorEvent): void {
    if (event.type === 'position') {
      // While the trackpad drives the pointer the overlay shows it locally; host positions lag behind.
      const wait = localPointerAt + LOCAL_POINTER_HOLD_MS - performance.now();
      if (wait > 0) {
        heldPosition = event;
        heldTimer ??= setTimeout(() => {
          heldTimer = null;
          const held = heldPosition;
          heldPosition = null;
          if (held) onCursorEvent(held);
        }, wait);
        return;
      }
      heldPosition = null;
    }
    cursorLayer.onEvent(event);
  }

  function dropHeldPosition(): void {
    if (heldTimer !== null) clearTimeout(heldTimer);
    heldTimer = null;
    heldPosition = null;
    localPointerAt = Number.NEGATIVE_INFINITY;
  }

  const focusUnlessTouch = () => {
    if (lastPointerType !== 'touch') input.focusKeyboard();
  };
  const showLocalPointer = (p: { x: number; y: number }) => {
    localPointerAt = performance.now();
    cursorLayer.setPosition(p.x, p.y);
  };

  const touch = attachTouch(
    viewport,
    {
      enabled: () => input.isEnabled && input.started,
      move: (p) => {
        if (input.trackpadMove(p)) showLocalPointer(p);
      },
      down: (button, p) => {
        if (input.trackpadButton(button, true, p)) showLocalPointer(p);
      },
      up: (button, p) => {
        input.trackpadButton(button, false, p);
      },
      wheel: (deltaY) => {
        input.trackpadWheel(deltaY);
      },
      zoom: (scale, center) => zoom.zoomTo(scale, center),
      pan: (dx, dy) => zoom.panBy(dx, dy),
      zoomScale: () => zoom.scale,
      showKeyboard: () => {
        if (document.activeElement === textarea) textarea.blur();
        else input.focusKeyboard();
      },
      specialKeys: () => toolbar.openSpecialKeys(),
      pasteLocal: () => pasteFromDevice(),
      cancel: () => input.releaseAll(),
      remotePosition: () => cursorLayer.presenter.snapshot.position,
    },
    () => screenView.view(),
  );

  const fullscreenSupported = typeof stage.requestFullscreen === 'function' && document.fullscreenEnabled !== false;
  const toolbar = createToolbar(
    toolbarEl,
    {
      control: (on) => {
        controlOn = on;
        if (on) overflowNotice = false;
        refreshControl();
        if (on) focusUnlessTouch();
      },
      // Every handler hands the keyboard back to the textarea: a focused select/button/checkbox
      // would otherwise react to the keys meant for the remote machine (Space, Enter, letters).
      monitor: (index) => {
        selectMonitor(index);
        focusUnlessTouch();
      },
      scale: (mode: ScaleMode) => {
        zoom.reset();
        screenView.setScale(mode);
        syncCursorView();
        focusUnlessTouch();
      },
      quality: (preset: QualityPreset) => {
        command({ type: 'quality', preset }, false);
        focusUnlessTouch();
      },
      wallpaper: (hidden) => {
        command({ type: 'wallpaper', visible: !hidden }, true);
        focusUnlessTouch();
      },
      special: (key: SpecialKey) => {
        if (key === 'ctrlAltDel') command({ type: 'action', action: 'ctrlAltDel' }, true);
        else input.sendSynthetic(key);
        focusUnlessTouch();
      },
      chat: () => {
        if (chatPanel.isOpen) return chatPanel.close();
        placeChat();
        chatPanel.open(undefined, lastPointerType !== 'touch');
      },
      clipboard: (on) => {
        clipboardOn = on;
        persistClipboard();
        applyClipboard(true);
        focusUnlessTouch();
      },
      // start() must run synchronously inside this click (Safari/iOS only unlock audio in the gesture).
      audio: (on) => (on ? startAudio() : stopAudio(true)),
      audioVolume: (volume) => {
        audioVolume = volume;
        audioPlayer?.setVolume(volume);
        persistAudioVolume();
        focusUnlessTouch();
      },
      capture: (kind) => capture(kind),
      record: () => {
        if (recorder) void stopRecording();
        else startRecording();
        focusUnlessTouch();
      },
      fullscreen: () => toggleFullscreen(),
      refresh: () => {
        session?.refreshScreen().catch((e: unknown) => log(`Làm mới lỗi: ${describe(e)}`));
        focusUnlessTouch();
      },
      disconnect: () => void disconnect(),
    },
    { fullscreenSupported },
  );

  const clipboardSync = new ClipboardSync($<HTMLDivElement>('clipboard-toast'), {
    send: (text) => (session ? session.sendClipboard(text) : Promise.reject(new RelaySessionError('notConnected'))),
    history: (entries) => chatPanel.setClipboardHistory(entries),
    log,
  });
  const captureToast: CaptureToast = createCaptureToast($<HTMLDivElement>('capture-toast'));
  /** Received files nobody downloaded before the session ended (its own toast: a recording offer must not replace it). */
  const fileToast: CaptureToast = createCaptureToast($<HTMLDivElement>('file-toast'));
  const chatEl = $<HTMLDivElement>('chat-panel');
  /** The desktop panel starts below the toolbar and notices (level with the screen); see index.html. */
  function placeChat(): void {
    chatEl.style.setProperty('--chat-top', `${viewport.offsetTop}px`);
  }
  const chatPanel = createChatPanel(chatEl, {
    send: (text) => (session ? session.sendChat(text) : Promise.reject(new RelaySessionError('notConnected'))),
    typing: (typing) => session?.sendTyping(typing) ?? Promise.resolve(),
    attach: (files) => fileTransfers.send(files),
    copy: (text) => clipboardSync.copy(text),
    pasteLocal: () => pasteFromDevice(),
    changed: (state) => toolbar.setChat(state),
    closed: () => focusUnlessTouch(),
  });
  const fileTransfers = createFileTransfers({
    session: () => session,
    addCard: (card, incoming) => chatPanel.addCard(card, incoming),
  });
  let toolsAvailable = false;
  // Files dropped on the screen are offered like those dropped on the chat; a drag produces no
  // pointer events, so nothing reaches the remote desktop.
  const detachScreenDrop = attachDropZone(viewport, {
    enabled: () => toolsAvailable,
    hint: DROP_HINT,
    overlayParent: stage,
    onFiles: (files) => {
      placeChat();
      chatPanel.open('chat', false);
      fileTransfers.send(files);
    },
  });

  /** Applies the preference to the session (only while the tool gate is open). */
  function applyClipboard(changed: boolean): void {
    let effective = false;
    if (session && toolsAvailable && (changed || clipboardOn)) {
      try {
        session.setClipboardSharing(clipboardOn);
        effective = clipboardOn;
      } catch (e) {
        log(`Bật/tắt clipboard lỗi: ${describe(e)}`);
      }
    }
    clipboardSync.setEnabled(effective);
    toolbar.setClipboard({ on: clipboardOn, available: toolsAvailable, reason: TOOLS_UNAVAILABLE });
  }

  /**
   * "Dán sang Windows" (floating "Dán" button, Clipboard tab): phones have no paste shortcut, so the
   * device clipboard is read here, inside the click, then uploaded (sharing on) and Ctrl+V is typed.
   */
  function pasteFromDevice(): void {
    const current = session;
    if (!current || !peer) return;
    if (!input.isEnabled || !input.supportsKeyboard) {
      clipboardSync.notice(
        input.isEnabled ? 'Máy Windows dùng UltraViewer cũ: chưa dán được từ đây.' : 'Bật Điều khiển để dán sang Windows.',
      );
      focusUnlessTouch();
      return;
    }
    void clipboardSync.readLocal().then(async (text) => {
      if (text === null) return;
      const proceed = await clipboardSync.paste(text);
      // The upload may have taken a while: only type into the same, still controlled, session.
      if (proceed && !destroyed && session === current && input.isEnabled) input.sendPasteShortcut();
      focusUnlessTouch();
    });
  }

  /** Session ended: finished incoming files nobody downloaded yet are offered one download per click. */
  function offerUnclaimedFiles(): void {
    const files = fileTransfers.unclaimed();
    if (files.length === 0) return;
    const offerNext = (rest: UnclaimedFile[]): void => {
      fileToast.offer(`Có ${rest.length} file đã nhận chưa tải về.`, {
        label: `Tải về ${rest.length} file đã nhận`,
        run: () => {
          const [first, ...others] = rest;
          first!.download(); // inside the click
          if (others.length > 0) offerNext(others);
        },
        discard: () => rest.forEach((f) => f.release()),
      });
    };
    offerNext(files);
  }

  function setTools(available: boolean): void {
    toolsAvailable = available;
    chatPanel.setAvailable(available, TOOLS_UNAVAILABLE);
    applyClipboard(false);
  }

  const setStatus = (text: string) => {
    statusEl.textContent = text;
  };

  function describe(e: unknown): string {
    return e instanceof RelaySessionError ? e.code : e instanceof Error ? e.name : String(e);
  }

  function command(c: RemoteCommand, requiresControl: boolean): void {
    if (!session) return;
    if (requiresControl && !input.isEnabled) {
      log('Cần bật Điều khiển (và máy Windows cho phép) để gửi lệnh này.');
      return;
    }
    session.sendCommand(c, { requiresControl }).catch((e: unknown) => log(`Lệnh ${c.type} lỗi: ${describe(e)}`));
  }

  function refreshControl(): void {
    // While the annotator is open nothing is sent to Windows (the toggle itself is unchanged).
    const active = peer !== null && controlOn && controlAllowed && captureModal === null;
    input.setEnabled(active);
    toolbar.setState({ controlOn, controlAllowed, controlActive: active, keyboard: peer?.supportsBinaryKeyboard ?? false });
    refreshAudio();
    const notices: string[] = [];
    if (peer && !controlAllowed) notices.push(VIEW_ONLY_NOTICE);
    if (peer && !peer.supportsBinaryKeyboard) notices.push(OLD_PEER_NOTICE);
    if (overflowNotice) notices.push(OVERFLOW_NOTICE);
    if (audioNotice) notices.push(audioNotice);
    noticeEl.textContent = notices.join(' · ');
    noticeEl.hidden = notices.length === 0;
    toolbar.setConnection(
      peer && {
        name: peer.displayName || 'Máy Windows',
        resolution: `${peer.width}×${peer.height}`,
        detail: statusEl.textContent ?? '',
        tone: overflowNotice ? 'error' : notices.length > 0 ? 'warn' : 'ok',
      },
    );
    // The browser cursor is hidden (cursor:none) only while controlling AND a remote shape is known.
    controlActive = active;
    updateControlling();
  }

  // --- screenshots, annotation, recording ----------------------------------------------------
  function refreshCapture(): void {
    const support = recording.support();
    toolbar.setCapture({
      available: peer !== null && frameSeen,
      recordReason: support.ok ? undefined : support.reason,
      recording: recorder !== null,
      seconds: recordingSeconds,
    });
  }

  /** `<máy>` of the file names. */
  const machineName = () => peer?.displayName || 'UltraViewer';

  function capture(kind: CaptureKind): void {
    if (!peer || !screenView.hasFrame || captureModal) return focusUnlessTouch();
    if (kind === 'full') {
      // Synchronous, inside the menu click: Safari only allows the download within the gesture.
      const url = pngDataUrl(canvas);
      if (url) downloadUrl(url, captureFileName(machineName(), new Date(), 'png'));
      else captureToast.notice('Không tạo được ảnh PNG.');
      focusUnlessTouch();
      return;
    }
    const name = machineName();
    input.releaseAll();
    captureModal = openAnnotator({
      image: snapshotCanvas(canvas),
      selectRegion: kind === 'region',
      save: (url) => downloadUrl(url, captureFileName(name, new Date(), 'png')),
      closed: () => {
        captureModal = null;
        refreshControl();
        focusUnlessTouch();
      },
      failed: () => log('Tạo ảnh PNG lỗi.'),
    });
    refreshControl();
  }

  function startRecording(): void {
    if (recorder) return;
    const support = recording.support();
    if (!support.ok) {
      refreshCapture();
      captureToast.notice(support.reason);
      return focusUnlessTouch();
    }
    if (!peer || !screenView.hasFrame) return focusUnlessTouch();
    captureToast.hide(); // a finished video not downloaded yet is dropped
    recordingName = machineName();
    try {
      recorder = recording.start({
        source: canvas,
        onTick: (s) => {
          recordingSeconds = s;
          refreshCapture();
        },
        onError: () => {
          log('Trình duyệt báo lỗi khi mã hoá video: đã dừng quay.');
          void stopRecording();
        },
      });
    } catch (e) {
      log(`Không bắt đầu được quay: ${e instanceof RecorderError ? e.code : describe(e)}`);
      captureToast.notice('Không bắt đầu được quay video.');
      return focusUnlessTouch();
    }
    recordingSeconds = 0;
    refreshCapture();
    focusUnlessTouch();
  }

  /** Finishes the recording (Stop, disconnect, encoder error) and offers the video for download. */
  async function stopRecording(): Promise<void> {
    const current = recorder;
    if (!current) return;
    recorder = null;
    const name = recordingName;
    refreshCapture();
    const result: Recording | null = await current.stop().catch(() => null);
    if (destroyed) return;
    if (!result) {
      captureToast.notice('Không có dữ liệu video để lưu.');
      return;
    }
    const file = captureFileName(name, result.startedAt, result.ext);
    const m = Math.floor(result.seconds / 60);
    const length = `${m}:${String(result.seconds % 60).padStart(2, '0')}`;
    const size = result.blob.size < 1024 * 1024 ? `${Math.max(1, Math.round(result.blob.size / 1024))} KB` : `${(result.blob.size / (1024 * 1024)).toFixed(1)} MB`;
    captureToast.offer(`Đã quay xong (${length}, ${size}).`, {
      label: 'Tải video về',
      run: () => downloadBlob(result.blob, file),
    });
  }

  function refreshAudio(): void {
    toolbar.setAudio({ on: audioOn, available: peer !== null, volume: audioVolume });
  }

  function startAudio(): void {
    const current = session;
    if (!current || !peer) return;
    const gen = ++audioGen;
    audioOn = true;
    audioLive = false;
    audioNotice = '';
    audioPlayer ??= deps.createAudioPlayer?.() ?? new AudioPlayer();
    const player = audioPlayer;
    player.setVolume(audioVolume);
    let started: Promise<void>;
    try {
      started = player.start(); // first thing, synchronously: still inside the click
    } catch (e) {
      started = Promise.reject(e);
    }
    refreshControl();
    focusUnlessTouch();
    void started
      .then(() => {
        if (gen !== audioGen || session !== current) return;
        audioLive = true; // before the command: audio may arrive as soon as it is sent
        return current.setComputerAudio(true);
      })
      .catch((e: unknown) => {
        if (gen !== audioGen) return;
        failAudio(e);
      });
  }

  /** Audio is switched off after an error: player stopped, toggle off, the reason shown. */
  function failAudio(e: unknown): void {
    const suspended = e instanceof AudioPlayerError && e.code === 'suspended';
    const notice = suspended ? AUDIO_SUSPENDED_NOTICE : `Âm thanh máy tính đã dừng: ${describe(e)}`;
    log(notice);
    stopAudio(false, notice); // the failed command (or a dead session) needs no 46|||0
  }

  /** `tell`: also send command 46 (not after the session closed). */
  function stopAudio(tell: boolean, notice = ''): void {
    const wasLive = audioLive;
    audioGen++;
    audioOn = false;
    audioLive = false;
    audioNotice = notice;
    audioPlayer?.stop();
    if (tell && wasLive && session && session.phase === 'active') {
      session.setComputerAudio(false).catch((e: unknown) => log(`Tắt âm thanh lỗi: ${describe(e)}`));
    }
    refreshControl();
  }

  function cropFor(index: number): Crop | null {
    if (!peer || index === 0) return null;
    const m = peer.monitors.find((x) => x.index === index);
    if (!m) return null;
    try {
      return monitorRegion(m, peer.virtualLeft, peer.virtualTop, peer.width, peer.height);
    } catch (e) {
      log(`Màn hình ${index} nằm ngoài khung ảnh (${describe(e)}): hiện tất cả.`);
      return null;
    }
  }

  function selectMonitor(index: number): void {
    // Release before the mapping changes: held buttons must go up where they went down.
    input.releaseAll();
    const crop = cropFor(index);
    selectedMonitor = crop ? index : 0;
    zoom.reset();
    screenView.setCrop(crop);
    syncCursorView();
    recorder?.frame();
    if (peer) toolbar.setMonitors(peer.monitors, selectedMonitor);
  }

  // --- fullscreen + keyboard lock ---------------------------------------------------------
  type KeyboardLock = { lock?: (codes?: string[]) => Promise<void>; unlock?: () => void };
  const keyboardApi = (): KeyboardLock | undefined => (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;

  function toggleFullscreen(): void {
    if (document.fullscreenElement) {
      void document.exitFullscreen?.().catch(() => {});
      return;
    }
    stage
      .requestFullscreen({ navigationUI: 'hide' })
      .then(() => keyboardApi()?.lock?.())
      .then(() => focusUnlessTouch())
      .catch((e: unknown) => log(`Toàn màn hình / khoá phím: ${describe(e)}`));
  }

  const onFullscreenChange = () => {
    const active = document.fullscreenElement === stage;
    if (!active) keyboardApi()?.unlock?.();
    toolbar.setFullscreen(active);
  };
  document.addEventListener('fullscreenchange', onFullscreenChange);

  // ⌘W / Ctrl+W cannot be intercepted: ask before leaving an open session (Review Focus 4).
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (!session || session.phase === 'closed') return;
    e.preventDefault();
    e.returnValue = '';
  };
  window.addEventListener('beforeunload', onBeforeUnload);

  // --- connect / disconnect ---------------------------------------------------------------
  const setConnecting = (busy: boolean) => {
    connectButton.disabled = busy;
    cancelButton.disabled = !busy;
    forgetButton.disabled = busy;
  };

  function showConnected(connected: boolean): void {
    form.hidden = connected;
    toolbarEl.hidden = !connected;
    app.classList.toggle('connected', connected);
  }

  function onAccepted(current: ViewerSession, next: Peer): void {
    const first = peer === null;
    const capabilityChanged = peer !== null && peer.supportsBinaryKeyboard !== next.supportsBinaryKeyboard;
    peer = next;
    controlAllowed = next.allowsRemoteInput;
    if (first || capabilityChanged || !input.started) input.start(current, { binaryKeyboard: next.supportsBinaryKeyboard });
    screenView.setGeometry(next.width, next.height, next.virtualLeft, next.virtualTop);
    const keep = next.monitors.some((m) => m.index === selectedMonitor) ? selectedMonitor : 0;
    selectedMonitor = keep;
    toolbar.setMonitors(next.monitors, keep);
    screenView.setCrop(cropFor(keep));
    syncCursorView();
    // Shapes requested before a re-login may never be answered: ask again if still needed.
    if (!first) cursorLayer.clearPending();
    cursorLayer.setVisible(true);
    if (first) {
      password.value = '';
      showConnected(true);
    }
    setStatus(`Đã kết nối${next.displayName ? ` tới ${next.displayName}` : ''} (${next.width}×${next.height}, UltraViewer ${next.version})`);
    refreshControl();
    // A refresh (or host command 23) re-initializes the host: ask for the audio again.
    if (!first && audioLive) {
      current.setComputerAudio(true).catch((e: unknown) => {
        if (session === current && audioLive) failAudio(e);
      });
    }
  }

  function onClosed(reason: keyof typeof REASONS | null): void {
    // First: the recording takes the last frame still on the canvas, then offers the video.
    void stopRecording();
    frameSeen = false;
    input.stop();
    touch.reset();
    draw.clear();
    screenView.forget();
    zoom.reset();
    cursorLayer.setVisible(false);
    dropHeldPosition();
    cursorLayer.reset();
    peer = null;
    controlAllowed = false;
    overflowNotice = false;
    stopAudio(false); // refreshes the toolbar and notices
    refreshCapture();
    chatPanel.reset();
    clipboardSync.reset();
    fileTransfers.reset();
    offerUnclaimedFiles();
    setTools(false);
    if (clock !== null) clearInterval(clock);
    clock = null;
    renderStats();
    if (document.fullscreenElement === stage) void document.exitFullscreen?.().catch(() => {});
    showConnected(false);
    setConnecting(false);
    setStatus(reason === null ? 'Đã ngắt.' : REASONS[reason]);
    log(`Phiên kết thúc: ${reason ?? 'người dùng ngắt'}`);
  }

  async function disconnect(): Promise<void> {
    const current = session;
    if (!current || current.phase === 'closed') return;
    // Held keys/buttons go up before the session ends (FIFO behind pending input).
    input.releaseAll();
    await input.flush();
    if (session === current) current.close();
  }

  const renderStats = () => {
    if (session) diag.setStats(formatStats(session.phase, session.diagnostics, performance.now() - startedAt));
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (blocked) {
      setStatus(blocked);
      return log(blocked);
    }
    const fields = {
      workerUrl: diag.workerUrl(),
      partnerID: partner.value.replace(/\s+/g, ''),
      password: password.value,
    };
    const problem = connectFormError(fields);
    if (problem) return log(problem);
    persist();

    const current = deps.createSession({ workerUrl: fields.workerUrl });
    session = current;
    peer = null;
    controlOn = true;
    overflowNotice = false;
    selectedMonitor = 0;
    frameSeen = false;
    stopAudio(false);
    toolbar.reset();
    refreshCapture();
    chatPanel.reset();
    clipboardSync.reset();
    fileToast.hide(); // releases the received files nobody downloaded
    fileTransfers.clear();
    setTools(false);
    const size = deps.screenSize?.() ?? {
      width: Math.round(screen.width * devicePixelRatio),
      height: Math.round(screen.height * devicePixelRatio),
    };
    try {
      current.connect(
        {
          identity,
          partnerID: fields.partnerID,
          password: fields.password,
          screenW: size.width,
          screenH: size.height,
          displayName: DEFAULT_DISPLAY_NAME,
        },
        (e) => {
          if (session !== current) return;
          switch (e.type) {
            case 'status':
              log(e.text);
              break;
            case 'accepted':
              onAccepted(current, e.peer);
              break;
            case 'inputPermission':
              controlAllowed = e.allowed;
              log(e.allowed ? 'Máy Windows cho phép điều khiển.' : 'Máy Windows tạm khoá điều khiển (chỉ xem).');
              refreshControl();
              break;
            case 'frame':
              draw.push(e.bitmap);
              // rAF does not run in a background tab: while recording, paint right away.
              if (recorder && document.visibilityState === 'hidden') paintFrame(e.bitmap);
              break;
            case 'cursor':
              onCursorEvent(e.event);
              break;
            case 'chat':
              chatPanel.receive(e.text);
              break;
            case 'typing':
              chatPanel.setPeerTyping(e.typing);
              break;
            case 'clipboard':
              clipboardSync.receive(e.text);
              break;
            case 'file':
              fileTransfers.handle(e.event);
              break;
            case 'audio':
              if (audioLive) audioPlayer?.push(e.pcm);
              break;
            case 'tools':
              setTools(e.available);
              break;
            case 'closed':
              onClosed(e.reason);
              break;
          }
        },
      );
    } catch (e) {
      log(`Không bắt đầu được phiên: ${describe(e)}`);
      return;
    }
    startedAt = performance.now();
    clock = setInterval(renderStats, 1000);
    setStatus('Đang kết nối…');
    setConnecting(true);
  });

  cancelButton.addEventListener('click', () => session?.close());

  forgetButton.addEventListener('click', () => {
    forgetDevice();
    identity = createIdentity();
    remember.checked = false;
    log('Đã xoá danh tính đã lưu trên thiết bị này; lần kết nối sau dùng danh tính mới.');
  });

  // No pointerup/pointercancel arrives when the page is backgrounded mid-touch: forget the fingers
  // (DesktopInput releases what was held on blur/hidden by itself).
  const onWindowBlur = () => touch.reset();
  window.addEventListener('blur', onWindowBlur);
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') touch.reset();
    log(`Tab ${document.visibilityState === 'hidden' ? 'bị ẩn' : 'hiện lại'} (pha ${session?.phase ?? 'closed'})`);
  };
  const onPageHide = (e: PageTransitionEvent) => log(`pagehide (persisted: ${e.persisted}, pha ${session?.phase ?? 'closed'})`);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);

  refreshControl();
  refreshCapture();
  setTools(false);

  return {
    destroy() {
      destroyed = true;
      recorder?.abort();
      recorder = null;
      captureModal?.close();
      captureToast.dispose();
      fileToast.dispose();
      touch.detach();
      window.removeEventListener('blur', onWindowBlur);
      dropHeldPosition();
      audioGen++;
      audioPlayer?.stop();
      document.removeEventListener('pointerdown', onAnyPointerDown, true);
      input.detach();
      resizeObserver?.disconnect();
      cursorLayer.dispose();
      toolbar.dispose();
      chatPanel.dispose();
      clipboardSync.dispose();
      detachScreenDrop();
      fileTransfers.dispose();
      if (clock !== null) clearInterval(clock);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
      app.replaceChildren();
    },
  };
}
