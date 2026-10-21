// Test-only helpers shared by the jsdom viewer tests: a ViewerSession that records what the page
// sends (the tests drive session events by hand), a Peer factory and keyboard packet bytes.
import { expect } from 'vitest';
import { chatMessagePayload } from '../proto/chat';
import { clipboardPayload } from '../proto/clipboard';
import type { RemoteCommand } from '../proto/commands';
import {
  RelaySessionError,
  type ConnectOptions,
  type Peer,
  type SessionDiagnostics,
  type SessionEvent,
  type SessionPhase,
} from '../session/relay-session';
import type { ViewerSession } from './viewer';

export const DIAGNOSTICS: SessionDiagnostics = {
  registrationAccepted: false, assignedID: null, lookupStatus: null, peerTransportOpened: false,
  loginSent: false, peerAccepted: false, decodedFrames: 0, decodeMsTotal: 0, decodeMsMax: 0,
  screenPayloadBytes: 0, screenRefreshes: 0, lastScreenFailure: null, relayKeepalivesSent: 0,
  commandKeepalivesSent: 0, relayPongs: 0, relayRttMs: null, peerRttMs: null, ignoredMessages: 0,
  ignoredSources: 0,
};

/** Records what the viewer sends; the test drives session events by hand. */
export class TestSession implements ViewerSession {
  phase: SessionPhase = 'closed';
  readonly diagnostics = DIAGNOSTICS;
  /**
   * ASCII messages as text, binary keyboard packets as number arrays, and `clipboard <text>` for
   * sendClipboard (in order with the input, which is what the paste flow depends on).
   */
  readonly sent: Array<string | number[]> = [];
  readonly commands: Array<{ c: RemoteCommand; requiresControl: boolean }> = [];
  readonly chats: string[] = [];
  readonly typings: boolean[] = [];
  readonly sharing: boolean[] = [];
  refreshes = 0;
  closedAt = -1;
  options: ConnectOptions | null = null;
  tools = false;
  clipboardAllowed = false;
  /** Set to make the next sendChat reject. */
  failChat: Error | null = null;
  /** Set to make the next sendClipboard reject (after recording the attempt). */
  failClipboard: Error | null = null;
  private on: ((e: SessionEvent) => void) | null = null;

  connect(o: ConnectOptions, on: (e: SessionEvent) => void): void {
    this.options = o;
    this.on = on;
    this.phase = 'registering';
  }

  async send(bytes: Uint8Array, formatFlag = false): Promise<void> {
    if (this.phase === 'closed') throw new Error('notConnected');
    expect(formatFlag).toBe(false);
    this.sent.push(bytes[0] === 30 ? [...bytes] : new TextDecoder().decode(bytes));
  }

  async sendCommand(c: RemoteCommand, opts: { requiresControl: boolean }): Promise<void> {
    this.commands.push({ c, requiresControl: opts.requiresControl });
  }

  async refreshScreen(): Promise<void> {
    this.refreshes++;
  }

  canUseSessionTools(): boolean {
    return this.tools;
  }

  async sendChat(text: string): Promise<void> {
    if (!this.tools) throw new RelaySessionError('toolsUnavailable');
    chatMessagePayload(text);
    if (this.failChat) {
      const e = this.failChat;
      this.failChat = null;
      throw e;
    }
    this.chats.push(text);
  }

  async sendTyping(typing: boolean): Promise<void> {
    if (!this.tools) throw new RelaySessionError('toolsUnavailable');
    this.typings.push(typing);
  }

  setClipboardSharing(on: boolean): void {
    if (!this.tools) throw new RelaySessionError('toolsUnavailable');
    this.clipboardAllowed = on;
    this.sharing.push(on);
  }

  async sendClipboard(text: string): Promise<void> {
    if (!this.tools) throw new RelaySessionError('toolsUnavailable');
    if (!this.clipboardAllowed) throw new RelaySessionError('clipboardDisabled');
    clipboardPayload(text);
    this.sent.push(`clipboard ${text}`);
    if (this.failClipboard) {
      const e = this.failClipboard;
      this.failClipboard = null;
      throw e;
    }
  }

  close(): void {
    this.closedAt = this.sent.length;
    this.phase = 'closed';
    this.tools = false;
    this.on?.({ type: 'closed', reason: null });
  }

  emit(e: SessionEvent): void {
    if (e.type === 'accepted') this.phase = 'active';
    if (e.type === 'closed') {
      this.phase = 'closed';
      this.tools = false;
    }
    if (e.type === 'tools') this.tools = e.available;
    this.on?.(e);
  }
}

export function peer(over: Partial<Peer> = {}): Peer {
  return {
    displayName: 'PC',
    version: '6.6.0',
    width: 1920,
    height: 1080,
    virtualLeft: 0,
    virtualTop: 0,
    supportsBinaryKeyboard: true,
    allowsRemoteInput: true,
    monitors: [],
    ...over,
  };
}

/** Keyboard packet `[30,|,|,|, kind, vk, scanLE, charLE, caps]`. */
export const packet = (kind: number, vk: number, scan: number, char = 0) => [30, 124, 124, 124, kind, vk, scan & 0xff, scan >> 8, char & 0xff, char >> 8, 0];

export const settle = () => new Promise<void>((r) => setTimeout(r, 0));
