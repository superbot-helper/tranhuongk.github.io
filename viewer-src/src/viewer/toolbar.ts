// Viewer toolbar: Điều khiển, Màn hình, Scale, Chất lượng, Ẩn wallpaper, Phím, Toàn màn hình,
// Làm mới, Ngắt. Pure DOM: it reports choices to the handlers and shows the state it is given.
import type { QualityPreset, RemoteMonitor } from '../proto/commands';
import type { SyntheticKey } from './input';
import type { ScaleMode } from './screen';

export type SpecialKey = 'ctrlAltDel' | SyntheticKey;

export interface ToolbarHandlers {
  control(on: boolean): void;
  /** 0 = all monitors, otherwise the one-based monitor index. */
  monitor(index: number): void;
  scale(mode: ScaleMode): void;
  quality(preset: QualityPreset): void;
  wallpaper(hidden: boolean): void;
  special(key: SpecialKey): void;
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

export interface Toolbar {
  setState(s: ToolbarState): void;
  setMonitors(monitors: readonly RemoteMonitor[], selected: number): void;
  setFullscreen(active: boolean): void;
  /** Open the special-keys menu (the floating "Phím" button on touch devices). */
  openSpecialKeys(): void;
  /** Back to defaults for a new session. */
  reset(): void;
}

const SPECIAL_KEYS: ReadonlyArray<[SpecialKey, string]> = [
  ['ctrlAltDel', 'Ctrl+Alt+Del'],
  ['win', 'Win'],
  ['altTab', 'Alt+Tab'],
  ['altF4', 'Alt+F4'],
  ['ctrlEsc', 'Ctrl+Esc'],
  ['printScreen', 'PrintScreen'],
];

export function createToolbar(root: HTMLElement, h: ToolbarHandlers, o: { fullscreenSupported: boolean }): Toolbar {
  root.classList.add('toolbar');
  root.setAttribute('role', 'toolbar');
  root.innerHTML = `
    <button id="control-toggle" type="button" aria-pressed="true">Điều khiển</button>
    <label>Màn hình <select id="monitor"><option value="0">Tất cả</option></select></label>
    <label>Scale <select id="scale">
      <option value="fit">Vừa khung</option>
      <option value="actual">100%</option>
    </select></label>
    <label>Chất lượng <select id="quality">
      <option value="auto">Tự động</option>
      <option value="speed">Tốc độ</option>
      <option value="quality">Chất lượng</option>
    </select></label>
    <label class="check"><input id="wallpaper" type="checkbox"> Ẩn wallpaper</label>
    <details id="special-keys" class="menu">
      <summary>Phím</summary>
      <div class="menu-items">${SPECIAL_KEYS.map(([k, label]) => `<button type="button" data-special="${k}">${label}</button>`).join('')}</div>
    </details>
    <button id="fullscreen" type="button" aria-pressed="false">Toàn màn hình</button>
    <button id="refresh" type="button">Làm mới</button>
    <button id="toolbar-disconnect" type="button" class="danger">Ngắt</button>`;

  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const control = $<HTMLButtonElement>('control-toggle');
  const monitor = $<HTMLSelectElement>('monitor');
  const scale = $<HTMLSelectElement>('scale');
  const quality = $<HTMLSelectElement>('quality');
  const wallpaper = $<HTMLInputElement>('wallpaper');
  const special = $<HTMLDetailsElement>('special-keys');
  const fullscreen = $<HTMLButtonElement>('fullscreen');
  const specialButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-special]')];
  fullscreen.disabled = !o.fullscreenSupported;
  if (!o.fullscreenSupported) fullscreen.title = 'Trình duyệt này không hỗ trợ toàn màn hình cho trang.';

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
  fullscreen.addEventListener('click', () => h.fullscreen());
  $<HTMLButtonElement>('refresh').addEventListener('click', () => h.refresh());
  $<HTMLButtonElement>('toolbar-disconnect').addEventListener('click', () => h.disconnect());

  return {
    setState(s) {
      control.setAttribute('aria-pressed', String(s.controlOn && s.controlAllowed));
      control.disabled = !s.controlAllowed;
      control.textContent = s.controlAllowed ? (s.controlOn ? 'Điều khiển: bật' : 'Điều khiển: tắt') : 'Chỉ xem';
      control.title = s.controlAllowed
        ? 'Bật/tắt gửi chuột và bàn phím tới máy Windows (chỉ trên trình duyệt này).'
        : 'Máy Windows đang để chế độ chỉ xem.';
      wallpaper.disabled = !s.controlActive;
      for (const b of specialButtons) {
        b.disabled = !s.controlActive || (b.dataset.special !== 'ctrlAltDel' && !s.keyboard);
      }
    },
    setMonitors(monitors, selected) {
      monitor.replaceChildren(
        new Option('Tất cả', '0'),
        ...monitors.map((m) => new Option(`Màn hình ${m.index}`, String(m.index))),
      );
      monitor.value = String(selected);
      monitor.disabled = monitors.length === 0;
    },
    setFullscreen(active) {
      fullscreen.setAttribute('aria-pressed', String(active));
      fullscreen.textContent = active ? 'Thoát toàn màn hình' : 'Toàn màn hình';
    },
    openSpecialKeys() {
      special.open = true;
      special.scrollIntoView?.({ block: 'nearest' });
    },
    reset() {
      special.open = false;
      wallpaper.checked = false;
      quality.value = 'auto';
    },
  };
}
