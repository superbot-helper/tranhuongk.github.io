// Port of MacViewer's RemoteInputBuffer for a Promise-based sender: strict FIFO,
// an immediately preceding still-pending pointer move is replaced by the next move,
// bounded capacity. Overflow keeps what was accepted, reports once, then drops
// pushes until clear(); the owner must release held input and disable control.

type Message = string | Uint8Array;

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
    if (this.overflowed) return;
    const last = this.pending[this.pending.length - 1];
    if (isMove(m) && last !== undefined && isMove(last)) {
      this.pending[this.pending.length - 1] = m;
      this.schedule();
      return;
    }
    if (this.pending.length >= this.capacity) {
      this.overflowed = true;
      this.onOverflow();
      return;
    }
    this.pending.push(m);
    this.schedule();
  }

  /** Drop everything not yet sent and accept pushes again. An in-flight send cannot be recalled. */
  clear(): void {
    this.pending = [];
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
          this.onError(error);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
