// Notices for captures and recordings, in their own toast (the clipboard has one too). A plain
// notice fades after a few seconds; an offer with an action button ("Tải video về") stays until
// it is used or closed with × — the button's click is the user gesture the download needs.

export const CAPTURE_NOTICE_MS = 6_000;

export interface CaptureToastAction {
  label: string;
  /** Runs inside the click. The toast closes afterwards. */
  run(): void;
  /** The offer was dropped without being used (×, a newer offer, reset). */
  discard?(): void;
}

export interface CaptureToast {
  /** A short notice that fades by itself. */
  notice(text: string): void;
  /** A notice with one action; stays until used or closed. */
  offer(text: string, action: CaptureToastAction): void;
  /** Closes the toast; a pending offer is discarded. */
  hide(): void;
  dispose(): void;
}

export function createCaptureToast(el: HTMLElement): CaptureToast {
  el.classList.add('toast', 'capture-toast');
  el.setAttribute('role', 'status');
  el.hidden = true;
  el.innerHTML = `<span class="toast-text"></span>
    <button type="button" class="toast-action" hidden></button>
    <button type="button" class="toast-close" aria-label="Đóng">×</button>`;
  const text = el.querySelector<HTMLSpanElement>('.toast-text')!;
  const action = el.querySelector<HTMLButtonElement>('.toast-action')!;
  const close = el.querySelector<HTMLButtonElement>('.toast-close')!;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let current: CaptureToastAction | null = null;

  // The toast's buttons never take the keyboard from the remote screen.
  el.addEventListener('mousedown', (e) => {
    if ((e.target as Element | null)?.closest('button')) e.preventDefault();
  });

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  function hide(): void {
    clearTimer();
    const dropped = current;
    current = null;
    el.hidden = true;
    action.hidden = true;
    dropped?.discard?.();
  }

  function show(message: string, a: CaptureToastAction | null): void {
    clearTimer();
    const previous = current;
    current = a;
    previous?.discard?.();
    text.textContent = message;
    action.hidden = a === null;
    action.textContent = a?.label ?? '';
    el.hidden = false;
    if (a === null) timer = setTimeout(hide, CAPTURE_NOTICE_MS);
  }

  action.addEventListener('click', () => {
    const used = current;
    if (!used) return;
    current = null; // used, not discarded
    used.run();
    hide();
  });
  close.addEventListener('click', hide);

  return {
    notice: (t) => show(t, null),
    offer: (t, a) => show(t, a),
    hide,
    dispose() {
      hide();
    },
  };
}
