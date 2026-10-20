// Port of UltraViewerProtocol/LatestScreenFrame.swift plus the page-side "draw on the next
// animation frame" step. Each bitmap is the whole screen, so a consumer that is behind can
// skip stale frames without losing anything: at most one draw is pending at any time and it
// always draws the newest frame.

/** Holds only the newest value until the consumer takes it. */
export class LatestScreenFrame<T> {
  private value: T | null = null;

  /** Replaces any value not taken yet. True when nothing was pending (a draw must be scheduled). */
  put(next: T): boolean {
    const wasEmpty = this.value === null;
    this.value = next;
    return wasEmpty;
  }

  /** The newest value, or null if an earlier call already took it. */
  take(): T | null {
    const latest = this.value;
    this.value = null;
    return latest;
  }
}

export interface FrameScheduler<T> {
  push(frame: T): void;
  /** Drops a pending frame (e.g. on disconnect); a scheduled callback then draws nothing. */
  clear(): void;
}

/** decode -> push -> one `draw(newest)` on the next `schedule` tick (requestAnimationFrame). */
export function createFrameScheduler<T>(
  draw: (frame: T) => void,
  schedule: (cb: () => void) => void = (cb) => requestAnimationFrame(cb),
): FrameScheduler<T> {
  const latest = new LatestScreenFrame<T>();
  return {
    push(frame) {
      if (!latest.put(frame)) return;
      schedule(() => {
        const next = latest.take();
        if (next !== null) draw(next);
      });
    },
    clear() {
      latest.take();
    },
  };
}
