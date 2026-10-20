// Port of MacViewer's RemoteInputBuffer for a Promise-based sender: strict FIFO,
// an immediately preceding still-pending pointer move is replaced by the next move,
// bounded capacity. Pending release messages (key/button ups) are never dropped: on overflow
// and on clear() everything else is discarded, the ups stay in order. Overflow reports once and
// then drops non-release pushes until clear(); the owner enqueues releaseAll() and disables control.

type Message = string | Uint8Array;

/**
 * A message that lets go of something: keyboard packet kind 2/4 (key up / system key up) or mouse
 * button up (WM_LBUTTONUP 514, WM_RBUTTONUP 517, WM_MBUTTONUP 520). The encoder forgets a key once its
 * up is encoded, so dropping a pending release would strand the key or button at the host.
 */
function isRelease(m: Message): boolean {
  if (typeof m === 'string') return m.startsWith('8|||514|||') || m.startsWith('8|||517|||') || m.startsWith('8|||520|||');
  return m.length === 11 && m[0] === 30 && m[1] === 124 && m[2] === 124 && m[3] === 124 && (m[4] === 2 || m[4] === 4);
}

/** Mouse move text: WM_MOUSEMOVE (0x200 = 512) application message. */
function isMove(m: Message): boolean {
  return typeof m === 'string' && m.startsWith('8|||512|||');
}

export class InputQueue {
  private pending: Message[] = [];
  private draining = false;
  private overflowed = false;

  constructor(
    private readonly send: (m: Message) => Promise<void>,
    private readonly onOverflow: () => void,
    private readonly capacity = 8192,
    private readonly onError: (error: unknown) => void = () => {},
  ) {
    if (!(capacity > 0)) throw new RangeError('capacity must be positive');
  }

  /** Messages accepted but not yet handed to `send`. */
  get length(): number {
    return this.pending.length;
  }

  push(m: Message): void {
    if (this.overflowed) {
      // Releases still go through, so the owner's releaseAll() after onOverflow reaches the host.
      if (isRelease(m)) {
        this.pending.push(m);
        this.schedule();
      }
      return;
    }
    const last = this.pending[this.pending.length - 1];
    if (isMove(m) && last !== undefined && isMove(last)) {
      this.pending[this.pending.length - 1] = m;
      this.schedule();
      return;
    }
    if (this.pending.length >= this.capacity) {
      this.overflowed = true;
      this.pending = this.pending.filter(isRelease);
      if (isRelease(m)) this.pending.push(m);
      this.schedule();
      this.onOverflow();
      return;
    }
    this.pending.push(m);
    this.schedule();
  }

  /**
   * Drop everything not yet sent except pending releases (kept in order) and accept pushes again.
   * An in-flight send cannot be recalled.
   */
  clear(): void {
    this.pending = this.pending.filter(isRelease);
    this.overflowed = false;
  }

  // Start draining on a microtask so a burst of synchronous pushes coalesces before the first send.
  private schedule(): void {
    if (this.draining) return;
    this.draining = true;
    queueMicrotask(() => void this.drain());
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending.length > 0) {
        const next = this.pending.shift() as Message;
        try {
          await this.send(next);
        } catch (error) {
          try {
            this.onError(error);
          } catch {
            // A throwing error handler must not stop the queue or leak an unhandled rejection.
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
