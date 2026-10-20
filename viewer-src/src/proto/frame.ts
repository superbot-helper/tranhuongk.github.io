// Port of UltraViewerProtocol/LengthPrefixedFrame.swift.
// Wire format: UInt32 little-endian payload length, then the payload.

const INT32_MAX = 0x7fffffff;

export type LengthPrefixedFrameCode = 'invalidLength' | 'frameTooLarge';

export class LengthPrefixedFrameError extends Error {
  readonly code: LengthPrefixedFrameCode;
  constructor(code: LengthPrefixedFrameCode) {
    super(code);
    this.name = 'LengthPrefixedFrameError';
    this.code = code;
  }
}

export function encodeFrame(payload: Uint8Array): Uint8Array {
  if (payload.length > INT32_MAX) throw new LengthPrefixedFrameError('frameTooLarge');
  const frame = new Uint8Array(4 + payload.length);
  new DataView(frame.buffer).setUint32(0, payload.length, true);
  frame.set(payload, 4);
  return frame;
}

/**
 * Incremental decoder: correct under any TCP chunking (split headers, split
 * bodies, several frames per chunk). The limit is a local memory budget, not a
 * recovered wire limit. After a throw the stream is dead: state is cleared and
 * the owner must close the connection.
 */
export class FrameDecoder {
  readonly maximumPayloadLength: number;
  private readonly header = new Uint8Array(4);
  private headerLength = 0;
  private body: Uint8Array | null = null;
  private bodyLength = 0;

  constructor(maximumPayloadLength: number = 16 * 1024 * 1024) {
    if (!Number.isInteger(maximumPayloadLength) || maximumPayloadLength < 0 || maximumPayloadLength > INT32_MAX) {
      throw new RangeError('maximumPayloadLength out of range');
    }
    this.maximumPayloadLength = maximumPayloadLength;
  }

  push(chunk: Uint8Array): Uint8Array[] {
    const frames: Uint8Array[] = [];
    let cursor = 0;
    try {
      while (cursor < chunk.length) {
        if (this.body === null) {
          const count = Math.min(4 - this.headerLength, chunk.length - cursor);
          this.header.set(chunk.subarray(cursor, cursor + count), this.headerLength);
          this.headerLength += count;
          cursor += count;
          if (this.headerLength < 4) break;
          const length = new DataView(this.header.buffer).getUint32(0, true);
          if (length > INT32_MAX) throw new LengthPrefixedFrameError('invalidLength');
          if (length > this.maximumPayloadLength) throw new LengthPrefixedFrameError('frameTooLarge');
          this.body = new Uint8Array(length);
          this.bodyLength = 0;
        }
        const body = this.body;
        const count = Math.min(body.length - this.bodyLength, chunk.length - cursor);
        if (count > 0) {
          body.set(chunk.subarray(cursor, cursor + count), this.bodyLength);
          this.bodyLength += count;
          cursor += count;
        }
        if (this.bodyLength < body.length) break;
        frames.push(body);
        this.clear();
      }
      return frames;
    } catch (error) {
      this.clear();
      throw error;
    }
  }

  get hasIncompleteFrame(): boolean {
    return this.headerLength > 0 || this.body !== null;
  }

  reset(): void {
    this.clear();
  }

  private clear(): void {
    this.headerLength = 0;
    this.body = null;
    this.bodyLength = 0;
  }
}
