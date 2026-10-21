// Viewer toolbar, one flat row: connection status (dot, machine name, resolution), then grouped
// icon buttons and menus — Điều khiển, Màn hình▾ (monitor), Hiển thị▾ (Scale, Chất lượng, Ẩn
// wallpaper), Phím▾, Chụp▾ (screenshots, recording) | Chat (unread badge), Clipboard (opt-in
// sharing), Âm thanh▾ (on/off + Âm lượng) | Toàn màn hình, Làm mới, Ngắt. Pure DOM: it reports
// choices to the handlers and shows the state it is given. Menus are `<details class="menu">`
// popovers placed with `position: fixed` (the bar may scroll horizontally on phones).
import type { QualityPreset, RemoteMonitor } from '../proto/commands';
import { AUDIO_VOLUMES, type AudioVolume } from './audio-player';
import { icon, iconElement, type IconName } from './icons';
import type { SyntheticKey } from './input';
import type { ScaleMode } from './screen';

export type CaptureKind = 'annotate' | 'region' | 'full';

export type SpecialKey = 'ctrlAltDel' | SyntheticKey;

export interface ToolbarHandlers {
  control(on: boolean): void;
  /** 0 = all monitors, otherwise the one-based monitor index. */
  monitor(index: number): void;
  scale(mode: ScaleMode): void;
  quality(preset: QualityPreset): void;
  wallpaper(hidden: boolean): void;
  special(key: SpecialKey): void;
  /** Open or close the chat panel. */
  chat(): void;
  /** Clipboard sharing switched by the user. */
  clipboard(on: boolean): void;
  /** A screenshot action from the "Chụp" menu: annotate, one region, or the whole frame as a PNG. */
  capture(kind: CaptureKind): void;
  /** "Quay màn hình" / "Dừng quay": start or stop the recording. */
  record(): void;
  /** Computer audio switched by the user; runs inside the click (autoplay policy). */
  audio(on: boolean): void;
  audioVolume(volume: AudioVolume): void;
  fullscreen(): void;
  refresh(): void;
  disconnect(): void;
}

export interface ToolbarState {
  /** Local toggle. */
  controlOn: boolean;
  /** Host permission (command 49 / init). */
  controlAllowed: boolean;
  /** Effective control: input is being sent. */
  controlActive: boolean;
  /** Binary keyboard packets are possible (peer >= 6.2.13). */
  keyboard: boolean;
}

/** The status block at the start of the bar: `ok` green, `warn` amber, `error` red dot. */
export interface ToolbarConnection {
  name: string;
  /** "2560×720". */
  resolution: string;
  /** The full status line (tooltip). */
  detail: string;
  tone: 'ok' | 'warn' | 'error';
}

export interface Toolbar {
  setState(s: ToolbarState): void;
  /** Connection status block; null clears it (not connected). */
  setConnection(c: ToolbarConnection | null): void;
  setMonitors(monitors: readonly RemoteMonitor[], selected: number): void;
  setFullscreen(active: boolean): void;
  /** Open the special-keys menu (the floating "Phím" button on touch devices). */
  openSpecialKeys(): void;
  setChat(s: { open: boolean; unread: number }): void;
  /** `reason` explains a disabled button (tools unavailable). */
  setClipboard(s: { on: boolean; available: boolean; reason?: string }): void;
  /** Computer audio: `available` only while a session is connected. */
  setAudio(s: { on: boolean; available: boolean; volume: AudioVolume }): void;
  /**
   * "Chụp" menu. `available`: a decoded frame exists. `recordReason` explains a disabled
   * "Quay màn hình" (the browser cannot record). `seconds`: length of the running recording.
   */
  setCapture(s: { available: boolean; recordReason?: string; recording: boolean; seconds: number }): void;
  /** Back to defaults for a new session. */
  reset(): void;
  /** Removes the document/window listeners of the menus. */
  dispose(): void;
}

const SPECIAL_KEYS: ReadonlyArray<[SpecialKey, string]> = [
  ['ctrlAltDel', 'Ctrl+Alt+Del'],
  ['win', 'Win'],
  ['altTab', 'Alt+Tab'],
  ['altF4', 'Alt+F4'],
  ['ctrlEsc', 'Ctrl+Esc'],
  ['printScreen', 'PrintScreen'],
];

/**
 * Icon + label. The label is visually hidden below 900 px (and on `.icon-only` buttons) but stays
 * the accessible name. No whitespace: a control's textContent is exactly its label (+ state).
 */
const face = (name: IconName, label: string, extra = '') => `${icon(name)}<span class="label">${label}</span>${extra}`;

/** A bar menu: summary (icon, label, chevron) and its flat popover. */
const menu = (id: string, name: IconName, label: string, items: string, extra = '') =>
  `<details id="${id}" class="menu"><summary class="tb-btn" title="${label}">${face(name, label, extra)}${icon('chevronDown', 'chev')}</summary>` +
  `<div class="menu-items" role="group" aria-label="${label}">${items}</div></details>`;

export function createToolbar(root: HTMLElement, h: ToolbarHandlers, o: { fullscreenSupported: boolean }): Toolbar {
  root.classList.add('toolbar');
  root.setAttribute('role', 'toolbar');
  root.setAttribute('aria-label', 'Thanh điều khiển');
  root.innerHTML = `
    <div id="conn-status" class="tb-status"><span class="tb-dot" data-tone="ok"></span><span class="tb-name"></span><span class="tb-res"></span></div>
    <div class="tb-group" role="group" aria-label="Màn hình từ xa">
      <button id="control-toggle" class="tb-btn" type="button" aria-pressed="true">${face('control', 'Điều khiển', '<span class="state"></span>')}</button>
      ${menu('monitor-menu', 'monitor', 'Màn hình', `<label class="menu-field menu-list">Màn hình<select id="monitor" size="2"><option value="0">Tất cả</option></select></label>`)}
      ${menu(
        'display-menu',
        'display',
        'Hiển thị',
        `<label class="menu-field">Scale<select id="scale">
          <option value="fit">Vừa khung</option>
          <option value="actual">100%</option>
        </select></label>
        <label class="menu-field">Chất lượng<select id="quality">
          <option value="auto">Tự động</option>
          <option value="speed">Tốc độ</option>
          <option value="quality">Chất lượng</option>
        </select></label>
        <label class="menu-switch">Ẩn wallpaper<input id="wallpaper" class="switch" type="checkbox" role="switch"></label>`,
      )}
      ${menu('special-keys', 'keyboard', 'Phím', SPECIAL_KEYS.map(([k, label]) => `<button type="button" class="menu-item" data-special="${k}">${label}</button>`).join(''))}
      ${menu(
        'capture-menu',
        'camera',
        'Chụp',
        `<button type="button" class="menu-item" data-capture="annotate">Chụp và chú thích…</button>
        <button type="button" class="menu-item" data-capture="region">Chụp một vùng…</button>
        <button type="button" class="menu-item" data-capture="full">Lưu toàn màn hình (PNG)</button>
        <button type="button" class="menu-item" id="record-toggle">Quay màn hình</button>`,
        '<span class="rec"></span>',
      )}
    </div>
    <div class="tb-group" role="group" aria-label="Công cụ">
      <button id="chat-toggle" class="tb-btn" type="button" aria-expanded="false" aria-controls="chat-panel" title="Chat">${face('chat', 'Chat', '<span class="badge" hidden></span>')}</button>
      <button id="clipboard-toggle" class="tb-btn" type="button" aria-pressed="false">${face('clipboard', 'Clipboard', '<span class="state">: tắt</span>')}</button>
      ${menu(
        'audio-menu',
        'speaker',
        'Âm thanh',
        `<button id="audio-toggle" type="button" class="menu-switch" aria-pressed="false"><span>Âm thanh</span><span class="state">: tắt</span><span class="switch" aria-hidden="true"></span></button>
        <label class="menu-field">Âm lượng<select id="audio-volume">${AUDIO_VOLUMES.map((v) => `<option value="${v}">${v * 100}%</option>`).join('')}</select></label>`,
      )}
    </div>
    <div class="tb-group" role="group" aria-label="Phiên">
      <button id="fullscreen" class="tb-btn icon-only" type="button" aria-pressed="false" title="Toàn màn hình">${face('fullscreen', 'Toàn màn hình')}</button>
      <button id="refresh" class="tb-btn icon-only" type="button" title="Làm mới">${face('refresh', 'Làm mới')}</button>
      <button id="toolbar-disconnect" type="button" class="tb-btn danger" title="Ngắt kết nối">${face('power', 'Ngắt')}</button>
    </div>`;

  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const control = $<HTMLButtonElement>('control-toggle');
  const monitor = $<HTMLSelectElement>('monitor');
  const scale = $<HTMLSelectElement>('scale');
  const quality = $<HTMLSelectElement>('quality');
  const wallpaper = $<HTMLInputElement>('wallpaper');
  const special = $<HTMLDetailsElement>('special-keys');
  const fullscreen = $<HTMLButtonElement>('fullscreen');
  const chat = $<HTMLButtonElement>('chat-toggle');
  const badge = chat.querySelector<HTMLSpanElement>('.badge')!;
  const clipboard = $<HTMLButtonElement>('clipboard-toggle');
  const audioMenu = $<HTMLDetailsElement>('audio-menu');
  const audio = $<HTMLButtonElement>('audio-toggle');
  const audioVolume = $<HTMLSelectElement>('audio-volume');
  const captureMenu = $<HTMLDetailsElement>('capture-menu');
  const captureSummary = captureMenu.querySelector<HTMLElement>('summary')!;
  const captureClock = captureSummary.querySelector<HTMLSpanElement>('.rec')!;
  const captureButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-capture]')];
  const record = $<HTMLButtonElement>('record-toggle');
  const specialButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-special]')];
  const status = $<HTMLDivElement>('conn-status');
  const statusDot = status.querySelector<HTMLSpanElement>('.tb-dot')!;
  const statusName = status.querySelector<HTMLSpanElement>('.tb-name')!;
  const statusRes = status.querySelector<HTMLSpanElement>('.tb-res')!;
  const menus = [...root.querySelectorAll<HTMLDetailsElement>('details.menu')];
  fullscreen.disabled = !o.fullscreenSupported;
  if (!o.fullscreenSupported) fullscreen.title = 'Trình duyệt này không hỗ trợ toàn màn hình cho trang.';

  const setLabel = (b: HTMLElement, label: string, state?: string) => {
    b.querySelector<HTMLSpanElement>('.label')!.textContent = label;
    const s = b.querySelector<HTMLSpanElement>('.state');
    if (s && state !== undefined) s.textContent = state;
    fit();
  };

  // One row, never two: when the labelled buttons do not fit, the bar turns icon-only (`compact`,
  // labels stay the accessible names); below 900 px CSS does the same, and on phones it scrolls.
  function fit(): void {
    if (root.hidden) return;
    root.classList.remove('compact');
    if (root.scrollWidth > root.clientWidth + 1) root.classList.add('compact');
  }
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fit()) : null;
  resizeObserver?.observe(root);

  // --- menus: one open at a time, placed under their summary, closed from outside ------------
  const place = (m: HTMLDetailsElement) => {
    const items = m.querySelector<HTMLElement>('.menu-items')!;
    const s = m.querySelector('summary')!.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const left = Math.max(8, Math.min(s.left, vw - items.offsetWidth - 8));
    items.style.left = `${Math.round(left)}px`;
    items.style.top = `${Math.round(s.bottom + 6)}px`;
    items.dataset.placed = '';
  };
  const placeOpen = () => menus.filter((m) => m.open).forEach(place);
  for (const m of menus) {
    m.addEventListener('toggle', () => {
      if (!m.open) {
        delete m.querySelector<HTMLElement>('.menu-items')!.dataset.placed;
        return;
      }
      for (const other of menus) if (other !== m) other.open = false;
      place(m);
    });
  }
  const onOutside = (e: Event) => {
    const target = e.target as Node | null;
    for (const m of menus) if (m.open && !(target && m.contains(target))) m.open = false;
  };
  document.addEventListener('pointerdown', onOutside, true);
  window.addEventListener('resize', placeOpen);
  root.addEventListener('scroll', placeOpen, { passive: true });
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const m = menus.find((x) => x.open && x.contains(e.target as Node));
    if (!m) return;
    m.open = false;
    m.querySelector('summary')!.focus();
  });

  // Buttons never take focus from the keyboard textarea (focus on a button makes Space/Enter
  // re-trigger it while the user types to the remote machine). Selects and the checkbox must keep
  // their native mousedown (opening the list); their change handlers return focus instead.
  root.addEventListener('mousedown', (e) => {
    if ((e.target as Element | null)?.closest('button')) e.preventDefault();
  });

  control.addEventListener('click', () => h.control(control.getAttribute('aria-pressed') !== 'true'));
  monitor.addEventListener('change', () => h.monitor(Number(monitor.value)));
  scale.addEventListener('change', () => h.scale(scale.value as ScaleMode));
  quality.addEventListener('change', () => h.quality(quality.value as QualityPreset));
  wallpaper.addEventListener('change', () => h.wallpaper(wallpaper.checked));
  for (const b of specialButtons) {
    b.addEventListener('click', () => {
      special.open = false;
      h.special(b.dataset.special as SpecialKey);
    });
  }
  for (const b of captureButtons) {
    b.addEventListener('click', () => {
      captureMenu.open = false;
      h.capture(b.dataset.capture as CaptureKind);
    });
  }
  record.addEventListener('click', () => {
    captureMenu.open = false;
    h.record();
  });
  chat.addEventListener('click', () => h.chat());
  clipboard.addEventListener('click', () => h.clipboard(clipboard.getAttribute('aria-pressed') !== 'true'));
  audio.addEventListener('click', () => h.audio(audio.getAttribute('aria-pressed') !== 'true'));
  audioVolume.addEventListener('change', () => h.audioVolume(Number(audioVolume.value) as AudioVolume));
  fullscreen.addEventListener('click', () => h.fullscreen());
  $<HTMLButtonElement>('refresh').addEventListener('click', () => h.refresh());
  $<HTMLButtonElement>('toolbar-disconnect').addEventListener('click', () => h.disconnect());

  return {
    setState(s) {
      control.setAttribute('aria-pressed', String(s.controlOn && s.controlAllowed));
      control.disabled = !s.controlAllowed;
      if (s.controlAllowed) setLabel(control, 'Điều khiển', s.controlOn ? ': bật' : ': tắt');
      else setLabel(control, 'Chỉ xem', '');
      control.title = s.controlAllowed
        ? 'Bật/tắt gửi chuột và bàn phím tới máy Windows (chỉ trên trình duyệt này).'
        : 'Máy Windows đang để chế độ chỉ xem.';
      wallpaper.disabled = !s.controlActive;
      for (const b of specialButtons) {
        b.disabled = !s.controlActive || (b.dataset.special !== 'ctrlAltDel' && !s.keyboard);
      }
    },
    setConnection(c) {
      statusDot.dataset.tone = c?.tone ?? 'ok';
      statusName.textContent = c?.name ?? '';
      statusRes.textContent = c?.resolution ?? '';
      status.title = c?.detail ?? '';
      fit();
    },
    setMonitors(monitors, selected) {
      monitor.replaceChildren(
        new Option('Tất cả', '0'),
        ...monitors.map((m) => new Option(`Màn hình ${m.index}`, String(m.index))),
      );
      monitor.size = Math.max(2, monitor.options.length);
      monitor.value = String(selected);
      monitor.disabled = monitors.length === 0;
    },
    setFullscreen(active) {
      fullscreen.setAttribute('aria-pressed', String(active));
      const label = active ? 'Thoát toàn màn hình' : 'Toàn màn hình';
      fullscreen.querySelector('svg')!.replaceWith(iconElement(active ? 'fullscreenExit' : 'fullscreen'));
      setLabel(fullscreen, label);
      if (o.fullscreenSupported) fullscreen.title = label;
    },
    openSpecialKeys() {
      special.open = true;
      special.scrollIntoView?.({ block: 'nearest' });
    },
    setChat(s) {
      chat.setAttribute('aria-expanded', String(s.open));
      badge.hidden = s.unread === 0;
      badge.textContent = s.unread > 99 ? '99+' : String(s.unread);
      chat.setAttribute('aria-label', s.unread > 0 ? `Chat (${s.unread} tin chưa đọc)` : 'Chat');
      fit();
    },
    setClipboard(s) {
      clipboard.setAttribute('aria-pressed', String(s.on));
      setLabel(clipboard, 'Clipboard', s.on ? ': bật' : ': tắt');
      clipboard.disabled = !s.available;
      clipboard.title = s.available
        ? 'Chia sẻ văn bản clipboard hai chiều với máy Windows: dán (⌘V / Ctrl+V) trong màn hình để gửi.'
        : (s.reason ?? '');
    },
    setAudio(s) {
      audio.setAttribute('aria-pressed', String(s.on));
      audio.querySelector<HTMLSpanElement>('.state')!.textContent = s.on ? ': bật' : ': tắt';
      audioMenu.classList.toggle('on', s.on);
      audio.disabled = !s.available;
      audio.title = s.available ? 'Nghe âm thanh từ máy Windows (chỉ trên trình duyệt này).' : 'Dùng được khi đã kết nối với máy Windows.';
      audioVolume.value = String(s.volume);
    },
    setCapture(s) {
      for (const b of captureButtons) {
        b.disabled = !s.available;
        b.title = s.available ? '' : 'Dùng được khi đã nhận được hình từ máy Windows.';
      }
      const unsupported = s.recordReason !== undefined;
      record.disabled = unsupported || (!s.recording && !s.available);
      record.title = unsupported ? s.recordReason! : s.available || s.recording ? '' : 'Dùng được khi đã nhận được hình từ máy Windows.';
      record.setAttribute('aria-pressed', String(s.recording));
      const m = Math.floor(s.seconds / 60);
      const clock = `${m}:${String(s.seconds % 60).padStart(2, '0')}`;
      record.textContent = s.recording ? `Dừng quay (${clock})` : 'Quay màn hình';
      const rec = s.recording ? ` ● ${clock}` : '';
      if (captureClock.textContent !== rec) {
        captureClock.textContent = rec;
        fit();
      }
      captureMenu.classList.toggle('recording', s.recording);
      captureSummary.setAttribute('aria-label', s.recording ? `Chụp (đang quay ${clock})` : 'Chụp');
    },
    reset() {
      for (const m of menus) m.open = false;
      wallpaper.checked = false;
      quality.value = 'auto';
    },
    dispose() {
      resizeObserver?.disconnect();
      document.removeEventListener('pointerdown', onOutside, true);
      window.removeEventListener('resize', placeOpen);
    },
  };
}
