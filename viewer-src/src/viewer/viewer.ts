// Desktop viewer page: connect form (collapsed once connected), toolbar, the remote screen and
// a collapsible Diagnostics section (the phase-0 spike log). Control state:
//   effective control = local "Điều khiển" toggle && host permission (init / command 49) && accepted.
// The permission is re-read from `peer.allowsRemoteInput` on every `accepted`, because a screen
// refresh (or host command 23) re-initializes with `inputPermission(false)` before it and no
// `inputPermission(true)` after it.
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
import { connectFormError, formatStats, loadToken, mountDiagnostics, readStorage, REASONS, saveToken } from '../spike/diagnostics';
import { CursorLayer } from './cursor-layer';
import { DesktopInput } from './input';
import { ScreenView, type Crop, type ScaleMode } from './screen';
import { createToolbar, type SpecialKey } from './toolbar';
import { attachTouch, ViewZoom } from './touch';

/** The RelaySession surface the page uses (a fake one in tests and in the dev-only demo). */
export interface ViewerSession {
  readonly phase: SessionPhase;
  readonly diagnostics: Readonly<SessionDiagnostics>;
  connect(o: ConnectOptions, on: (e: SessionEvent) => void): void;
  send(bytes: Uint8Array, formatFlag?: boolean): Promise<void>;
  sendCommand(c: RemoteCommand, opts: { requiresControl: boolean }): Promise<void>;
  refreshScreen(): Promise<void>;
  close(): void;
}

export interface ViewerDeps {
  createSession(o: { workerUrl: string; token: string }): ViewerSession;
  workerUrl: string;
  /** Frame draw tick; defaults to requestAnimationFrame. */
  schedule?: (cb: () => void) => void;
  /** Local screen size in device pixels (login fields 3/4). */
  screenSize?: () => { width: number; height: number };
}

export interface ViewerHandle {
  destroy(): void;
}

const OLD_PEER_NOTICE = 'Máy Windows dùng UltraViewer cũ (< 6.2.13): chỉ điều khiển chuột';
const VIEW_ONLY_NOTICE = 'Máy Windows đang để chế độ chỉ xem: chuột và bàn phím không được gửi.';
/** After a trackpad move, host pointer positions (older, by the round trip) are not drawn for this long. */
const LOCAL_POINTER_HOLD_MS = 500;
const OVERFLOW_NOTICE = 'Hàng đợi chuột/bàn phím bị đầy: đã thả mọi phím và nút, Điều khiển đã tắt. Bật lại để tiếp tục.';

const LAYOUT = `
  <header class="top">
    <h1>UV Web Viewer</h1>
    <form id="connect-form" autocomplete="off">
      <label>Worker token
        <input id="token" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>
      <label class="check"><input id="remember" type="checkbox"> Nhớ trên thiết bị này</label>
      <label>ID đối tác
        <input id="partner" inputmode="numeric" autocomplete="off" required></label>
      <label>Mật khẩu đối tác
        <input id="password" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>
      <div class="row">
        <button id="connect" type="submit">Kết nối</button>
        <button id="disconnect" type="button" disabled>Huỷ</button>
      </div>
      <button id="forget" type="button" class="secondary">Quên thiết bị này</button>
    </form>
    <p id="status" role="status">Chưa kết nối</p>
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
  </section>
  <details id="diagnostics"></details>`;

export function mountViewer(app: HTMLElement, deps: ViewerDeps): ViewerHandle {
  app.innerHTML = LAYOUT;
  const $ = <T extends HTMLElement>(id: string) => app.querySelector<T>(`#${id}`)!;
  const form = $<HTMLFormElement>('connect-form');
  const tokenInput = $<HTMLInputElement>('token');
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
  const viewport = $<HTMLDivElement>('viewport');
  const canvas = $<HTMLCanvasElement>('screen');
  const textarea = $<HTMLTextAreaElement>('keyboard-input');
  const diag = mountDiagnostics($<HTMLDetailsElement>('diagnostics'), {
    workerUrl: deps.workerUrl,
    token: () => tokenInput.value.trim(),
  });
  const { log } = diag;

  // --- identity and token (unchanged phase-0 rules) ---------------------------------------
  let identity: ClientIdentity = loadIdentity() ?? createIdentity();
  const stored = loadToken();
  tokenInput.value = stored.token;
  remember.checked = stored.remembered || readStorage(() => localStorage, IDENTITY_STORAGE_KEY) !== null;
  log(`Trang sẵn sàng. Worker: ${deps.workerUrl || '(chưa cấu hình — nhập trong Diagnostics)'}`);

  /** saveIdentity/saveToken throw on blocked storage: keep everything in memory for this tab. */
  const persist = () => {
    try {
      saveIdentity(identity, remember.checked);
      const token = tokenInput.value.trim();
      if (token) saveToken(token, remember.checked);
    } catch (e) {
      log(`Cảnh báo: không lưu được vào storage (${(e as Error).name}); danh tính chỉ giữ trong tab này.`);
    }
  };
  remember.addEventListener('change', persist);

  // --- session state ------------------------------------------------------------------------
  let session: ViewerSession | null = null;
  let peer: Peer | null = null;
  let controlOn = true;
  let controlAllowed = false;
  let overflowNotice = false;
  let selectedMonitor = 0;
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
  const draw = createFrameScheduler<ScreenBitmap>((bitmap) => {
    screenView.draw(bitmap);
    syncCursorView();
  }, deps.schedule);
  const resizeObserver =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          zoom.refit();
          syncCursorView();
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

  const detachTouch = attachTouch(
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
      monitor: (index) => selectMonitor(index),
      scale: (mode: ScaleMode) => {
        zoom.reset();
        screenView.setScale(mode);
        syncCursorView();
      },
      quality: (preset: QualityPreset) => command({ type: 'quality', preset }, false),
      wallpaper: (hidden) => command({ type: 'wallpaper', visible: !hidden }, true),
      special: (key: SpecialKey) => {
        if (key === 'ctrlAltDel') command({ type: 'action', action: 'ctrlAltDel' }, true);
        else input.sendSynthetic(key);
        focusUnlessTouch();
      },
      fullscreen: () => toggleFullscreen(),
      refresh: () => {
        session?.refreshScreen().catch((e: unknown) => log(`Làm mới lỗi: ${describe(e)}`));
      },
      disconnect: () => void disconnect(),
    },
    { fullscreenSupported },
  );

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
    const active = peer !== null && controlOn && controlAllowed;
    input.setEnabled(active);
    toolbar.setState({ controlOn, controlAllowed, controlActive: active, keyboard: peer?.supportsBinaryKeyboard ?? false });
    const notices: string[] = [];
    if (peer && !controlAllowed) notices.push(VIEW_ONLY_NOTICE);
    if (peer && !peer.supportsBinaryKeyboard) notices.push(OLD_PEER_NOTICE);
    if (overflowNotice) notices.push(OVERFLOW_NOTICE);
    noticeEl.textContent = notices.join(' · ');
    noticeEl.hidden = notices.length === 0;
    // The browser cursor is hidden (cursor:none) only while controlling AND a remote shape is known.
    controlActive = active;
    updateControlling();
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
  }

  function onClosed(reason: keyof typeof REASONS | null): void {
    input.stop();
    draw.clear();
    screenView.forget();
    zoom.reset();
    cursorLayer.setVisible(false);
    dropHeldPosition();
    cursorLayer.reset();
    peer = null;
    controlAllowed = false;
    overflowNotice = false;
    refreshControl();
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
    const fields = {
      workerUrl: diag.workerUrl(),
      token: tokenInput.value.trim(),
      partnerID: partner.value.replace(/\s+/g, ''),
      password: password.value,
    };
    const problem = connectFormError(fields);
    if (problem) return log(problem);
    persist();

    const current = deps.createSession({ workerUrl: fields.workerUrl, token: fields.token });
    session = current;
    peer = null;
    controlOn = true;
    overflowNotice = false;
    selectedMonitor = 0;
    toolbar.reset();
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
              break;
            case 'cursor':
              onCursorEvent(e.event);
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
    tokenInput.value = '';
    remember.checked = false;
    log('Đã xoá danh tính và token đã lưu trên thiết bị này; lần kết nối sau dùng danh tính mới.');
  });

  const onVisibility = () => log(`Tab ${document.visibilityState === 'hidden' ? 'bị ẩn' : 'hiện lại'} (pha ${session?.phase ?? 'closed'})`);
  const onPageHide = (e: PageTransitionEvent) => log(`pagehide (persisted: ${e.persisted}, pha ${session?.phase ?? 'closed'})`);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);

  refreshControl();

  return {
    destroy() {
      detachTouch();
      dropHeldPosition();
      document.removeEventListener('pointerdown', onAnyPointerDown, true);
      input.detach();
      resizeObserver?.disconnect();
      cursorLayer.dispose();
      if (clock !== null) clearInterval(clock);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
      app.replaceChildren();
    },
  };
}
