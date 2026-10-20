// DEV ONLY (`vite dev`, `?fake`): a local stand-in for RelaySession so the viewer UI can be
// driven without a Windows machine or credentials. Never part of the production build
// (imported behind `import.meta.env.DEV`). It draws a two-monitor virtual desktop
// (monitor 1 left of the primary, negative coordinates), marks where the last pointer
// message landed, and lists what the page sent. `?fake&old` = UltraViewer 6.2.12 (no
// keyboard packets), `?fake&viewonly` = host starts in view-only. `window.uvFake` exposes
// the sent log and `permission(allowed)` / `end()` to simulate commands 49 and 27. The remote
// pointer follows the last mouse message: shape 1001 (red DIB arrow) while the button is up,
// 1002 (green PNG-in-CUR ring) while it is down; shapes are only sent when the page asks (`4|||hash`).
import { commandPayload, type RemoteCommand, type RemoteMonitor } from '../proto/commands';
import type { ScreenBitmap } from '../proto/screen-renderer';
import {
  RelaySessionError,
  type ConnectOptions,
  type Peer,
  type SessionDiagnostics,
  type SessionEvent,
  type SessionPhase,
} from '../session/relay-session';
import type { ViewerDeps, ViewerSession } from './viewer';

const MONITOR_W = 1280;
const MONITOR_H = 720;
const MONITORS: RemoteMonitor[] = [
  { index: 1, left: -MONITOR_W, top: 0, right: 0, bottom: MONITOR_H },
  { index: 2, left: 0, top: 0, right: MONITOR_W, bottom: MONITOR_H },
];
const VIRTUAL_LEFT = -MONITOR_W;
const SHAPE_ARROW = 1001;
const SHAPE_RING = 1002;

/** One-image CUR file around an image resource (directory entry at 6, resource at 22). */
function curFromResource(resource: Uint8Array, size: number, hotX: number, hotY: number): Uint8Array {
  const out = new Uint8Array(22 + resource.length);
  const v = new DataView(out.buffer);
  v.setUint16(2, 2, true);
  v.setUint16(4, 1, true);
  out[6] = size;
  out[7] = size;
  v.setUint16(10, hotX, true);
  v.setUint16(12, hotY, true);
  v.setUint32(14, resource.length, true);
  v.setUint32(18, 22, true);
  out.set(resource, 22);
  return out;
}

/** 16x16 32-bit DIB cursor: a red triangle whose tip is the hotspot (0,0). */
function arrowCur(): Uint8Array {
  const size = 16;
  const maskStride = 4;
  const dib = new Uint8Array(40 + size * size * 4 + maskStride * size);
  const v = new DataView(dib.buffer);
  v.setUint32(0, 40, true);
  v.setInt32(4, size, true);
  v.setInt32(8, size * 2, true);
  v.setUint16(12, 1, true);
  v.setUint16(14, 32, true);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = 40 + ((size - 1 - y) * size + x) * 4; // bottom-up rows, BGRA
      if (x <= y * 0.7 && x < 11) dib.set([40, 40, 230, 255], o);
    }
  }
  return curFromResource(dib, size, 0, 0);
}

/** 24x24 PNG cursor: a green ring centred on the hotspot (12,12). */
async function ringCur(): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = 24;
  canvas.height = 24;
  const ctx = canvas.getContext('2d')!;
  ctx.strokeStyle = '#34c759';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(12, 12, 9, 0, Math.PI * 2);
  ctx.stroke();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('toBlob failed');
  return curFromResource(new Uint8Array(await blob.arrayBuffer()), 24, 12, 12);
}

interface FakeHooks {
  sent: string[];
  permission(allowed: boolean): void;
  end(): void;
}

declare global {
  interface Window {
    uvFake?: FakeHooks;
  }
}

function describeSent(bytes: Uint8Array): string {
  if (bytes.length === 11 && bytes[0] === 30) {
    const char = bytes[8]! | (bytes[9]! << 8);
    return `key kind=${bytes[4]} vk=0x${bytes[5]!.toString(16)} scan=0x${(bytes[6]! | (bytes[7]! << 8)).toString(16)} char=${char}`;
  }
  return new TextDecoder().decode(bytes);
}

class DevFakeSession implements ViewerSession {
  private state: SessionPhase = 'closed';
  private on: (e: SessionEvent) => void = () => {};
  private timer: ReturnType<typeof setInterval> | null = null;
  private pointer = { x: 0, y: 0, down: false };
  private readonly canvas = document.createElement('canvas');
  private readonly peer: Peer;
  private readonly diag: SessionDiagnostics = {
    registrationAccepted: true, assignedID: '000000000', lookupStatus: 1, peerTransportOpened: true,
    loginSent: true, peerAccepted: false, decodedFrames: 0, decodeMsTotal: 0, decodeMsMax: 0,
    screenPayloadBytes: 0, screenRefreshes: 0, lastScreenFailure: null, relayKeepalivesSent: 0,
    commandKeepalivesSent: 0, relayPongs: 0, relayRttMs: 12, peerRttMs: null, ignoredMessages: 0,
    ignoredSources: 0,
  };

  constructor(
    private readonly hooks: FakeHooks,
    params: URLSearchParams,
  ) {
    const old = params.has('old');
    this.peer = {
      displayName: 'DEMO-PC (giả lập)',
      version: old ? '6.2.12' : '6.6.0',
      width: MONITOR_W * 2,
      height: MONITOR_H,
      virtualLeft: VIRTUAL_LEFT,
      virtualTop: 0,
      supportsBinaryKeyboard: !old,
      allowsRemoteInput: !params.has('viewonly'),
      monitors: MONITORS,
    };
    this.canvas.width = this.peer.width;
    this.canvas.height = this.peer.height;
    hooks.permission = (allowed) => {
      if (this.state === 'active') this.on({ type: 'inputPermission', allowed });
    };
    hooks.end = () => this.finish('partnerEnded');
  }

  get phase(): SessionPhase {
    return this.state;
  }

  get diagnostics(): Readonly<SessionDiagnostics> {
    return this.diag;
  }

  connect(o: ConnectOptions, on: (e: SessionEvent) => void): void {
    this.on = on;
    this.state = 'registering';
    on({ type: 'status', text: `[giả lập] kết nối tới ${o.partnerID} (không có mạng)` });
    setTimeout(() => this.accept(), 300);
  }

  async send(bytes: Uint8Array, formatFlag = false): Promise<void> {
    if (this.state !== 'active' && this.state !== 'login') throw new RelaySessionError('notConnected');
    const text = describeSent(bytes);
    this.hooks.sent.push(formatFlag ? `unicode ${text}` : text);
    const mouse = /^8\|\|\|(\d+)\|\|\|(-?\d+)\|\|\|(-?\d+)(?:\|\|\|(-?\d+))?$/.exec(text);
    if (mouse) {
      const msg = Number(mouse[1]);
      if (msg === 0x200) this.pointer = { ...this.pointer, x: Number(mouse[3]), y: Number(mouse[4]) };
      if (msg === 0x201 || msg === 0x204 || msg === 0x207) this.pointer.down = true;
      if (msg === 0x202 || msg === 0x205 || msg === 0x208) this.pointer.down = false;
      this.emitCursor();
      this.render();
    }
    const request = /^4\|\|\|(-?\d+)$/.exec(text);
    if (request) setTimeout(() => void this.sendShape(Number(request[1])), 40);
  }

  async sendCommand(c: RemoteCommand, opts: { requiresControl: boolean }): Promise<void> {
    if (this.state !== 'active') throw new RelaySessionError('notConnected');
    if (opts.requiresControl && !this.peer.allowsRemoteInput) throw new RelaySessionError('viewOnly');
    for (const m of commandPayload(c)) {
      const text = m.formatFlag ? new TextDecoder('utf-16le').decode(m.bytes) : new TextDecoder().decode(m.bytes);
      this.hooks.sent.push(`command ${c.type} ${text}`);
    }
    this.render();
  }

  async refreshScreen(): Promise<void> {
    if (this.state !== 'active') throw new RelaySessionError('notConnected');
    this.state = 'login';
    this.on({ type: 'inputPermission', allowed: false });
    this.on({ type: 'status', text: '[giả lập] làm mới màn hình…' });
    setTimeout(() => this.accept(), 300);
  }

  close(): void {
    if (this.state === 'active') this.hooks.sent.push('19');
    this.finish(null);
  }

  private accept(): void {
    if (this.state === 'closed') return;
    this.state = 'active';
    this.diag.peerAccepted = true;
    this.on({ type: 'accepted', peer: this.peer });
    this.shown = 0;
    this.emitCursor();
    this.timer ??= setInterval(() => this.render(), 1000);
    this.render();
  }

  private shown = 0;

  /** Commands 3 (selection, on change) and 28 (position) as the Windows host would send them. */
  private emitCursor(): void {
    const hash = this.pointer.down ? SHAPE_RING : SHAPE_ARROW;
    if (hash !== this.shown) {
      this.shown = hash;
      this.on({ type: 'cursor', event: { type: 'select', hash } });
    }
    this.on({ type: 'cursor', event: { type: 'position', x: this.pointer.x, y: this.pointer.y } });
  }

  private async sendShape(hash: number): Promise<void> {
    if (this.state !== 'active') return;
    if (hash !== SHAPE_ARROW && hash !== SHAPE_RING) return;
    const cur = hash === SHAPE_ARROW ? arrowCur() : await ringCur();
    if (this.state === 'active') this.on({ type: 'cursor', event: { type: 'shape', hash, cur } });
  }

  private finish(reason: 'partnerEnded' | null): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.on({ type: 'closed', reason });
  }

  private render(): void {
    if (this.state !== 'active') return;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const { width, height } = this.canvas;
    ctx.fillStyle = '#1d3557';
    ctx.fillRect(0, 0, MONITOR_W, height);
    ctx.fillStyle = '#2a6f4e';
    ctx.fillRect(MONITOR_W, 0, MONITOR_W, height);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '12px monospace';
    for (let x = 0; x <= width; x += 100) {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, height);
      ctx.stroke();
      ctx.fillText(String(x + VIRTUAL_LEFT), x + 2, 12);
    }
    for (let y = 0; y <= height; y += 100) {
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(width, y + 0.5);
      ctx.stroke();
      ctx.fillText(String(y), 2, y + 24);
    }
    ctx.font = 'bold 28px sans-serif';
    ctx.fillText('Màn hình 1 (x < 0)', 40, 80);
    ctx.fillText('Màn hình 2 (chính)', MONITOR_W + 40, 80);
    const px = this.pointer.x - VIRTUAL_LEFT;
    const py = this.pointer.y;
    ctx.strokeStyle = this.pointer.down ? '#ff3b30' : '#ffd60a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px - 15, py);
    ctx.lineTo(px + 15, py);
    ctx.moveTo(px, py - 15);
    ctx.lineTo(px, py + 15);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.font = '16px monospace';
    ctx.fillStyle = '#fff';
    ctx.fillText(`con trỏ ${this.pointer.x},${this.pointer.y}${this.pointer.down ? ' (giữ nút)' : ''}`, MONITOR_W + 40, 130);
    this.hooks.sent.slice(-12).forEach((line, i) => ctx.fillText(line, MONITOR_W + 40, 170 + i * 22));
    const image = ctx.getImageData(0, 0, width, height);
    const bitmap: ScreenBitmap = { width, height, rgba: image.data };
    this.diag.decodedFrames++;
    this.on({ type: 'frame', bitmap });
  }
}

export function createDevFakeSession(params: URLSearchParams): ViewerDeps['createSession'] {
  const hooks: FakeHooks = { sent: [], permission: () => {}, end: () => {} };
  window.uvFake = hooks;
  return () => new DevFakeSession(hooks, params);
}
