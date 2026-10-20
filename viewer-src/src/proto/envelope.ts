// Port of UltraViewerProtocol/RelayEnvelope.swift (RelayIPv4Address, RelayEnvelope,
// RelayKeepalive, RelayHTTPPreamble, RelayHTTPPreambleDecoder).
// DirectPeerEnvelope is not ported: the web viewer has no LAN direct path.

function makeError<C extends string>(name: string) {
  return class extends Error {
    readonly code: C;
    constructor(code: C, message: string = code) {
      super(message);
      this.name = name;
      this.code = code;
    }
  };
}

export class RelayIPv4AddressError extends makeError<'invalidAddress'>('RelayIPv4AddressError') {}

export class RelayEnvelopeError extends makeError<'emptyEnvelope' | 'truncatedForward' | 'unknownKind'>('RelayEnvelopeError') {
  /** The offending kind byte for `unknownKind` (Swift's associated value). */
  readonly kind: number | null;
  constructor(code: 'emptyEnvelope' | 'truncatedForward' | 'unknownKind', kind: number | null = null) {
    super(code);
    this.kind = kind;
  }
}

export class RelayHTTPPreambleError extends makeError<'invalidHost'>('RelayHTTPPreambleError') {}

export class RelayHTTPPreambleDecoderError extends makeError<'headerTooLarge'>('RelayHTTPPreambleDecoderError') {}

const DECIMAL_OCTET = /^[0-9]{1,3}$/;

/** Dotted decimal -> 4 octets in display order (a.b.c.d). Leading zeros are accepted. */
export function parseIPv4(s: string): Uint8Array {
  const parts = s.split('.');
  if (parts.length !== 4) throw new RelayIPv4AddressError('invalidAddress');
  const out = new Uint8Array(4);
  parts.forEach((part, i) => {
    if (!DECIMAL_OCTET.test(part)) throw new RelayIPv4AddressError('invalidAddress');
    const octet = Number(part);
    if (octet > 255) throw new RelayIPv4AddressError('invalidAddress');
    out[i] = octet;
  });
  return out;
}

export type RelayEnvelope =
  | { kind: 'forward'; address: string; port: number; formatFlag: boolean; payload: Uint8Array }
  | { kind: 'system'; formatFlag: boolean | null; payload: Uint8Array };

/** `formatFlag == null` matches Send's default (no flag byte); a boolean includes the flag byte. */
export function encodeSystem(payload: Uint8Array, formatFlag: boolean | null = null): Uint8Array {
  const headerLength = formatFlag === null ? 1 : 2;
  const result = new Uint8Array(headerLength + payload.length);
  result[0] = 1;
  if (formatFlag !== null) result[1] = formatFlag ? 1 : 0;
  result.set(payload, headerLength);
  return result;
}

export function encodeEnvelope(e: RelayEnvelope): Uint8Array {
  if (e.kind === 'system') return encodeSystem(e.payload, e.formatFlag);
  if (!Number.isInteger(e.port) || e.port < 0 || e.port > 0xffff) throw new RangeError('port out of range');
  const octets = parseIPv4(e.address);
  const result = new Uint8Array(8 + e.payload.length);
  result[0] = 0;
  result[1] = e.formatFlag ? 1 : 0;
  // The IP integer a*256^3+b*256^2+c*256+d is written little-endian: d,c,b,a.
  result[2] = octets[3]!;
  result[3] = octets[2]!;
  result[4] = octets[1]!;
  result[5] = octets[0]!;
  result[6] = e.port & 0xff;
  result[7] = e.port >> 8;
  result.set(e.payload, 8);
  return result;
}

export function decodeEnvelope(b: Uint8Array): RelayEnvelope {
  const kind = b[0];
  if (kind === undefined) throw new RelayEnvelopeError('emptyEnvelope');
  switch (kind) {
    case 0:
      if (b.length < 8) throw new RelayEnvelopeError('truncatedForward');
      return {
        kind: 'forward',
        address: `${b[5]}.${b[4]}.${b[3]}.${b[2]}`,
        port: b[6]! | (b[7]! << 8),
        formatFlag: b[1]! > 0,
        payload: b.slice(8),
      };
    case 1:
      // The receiver leaves a system command's optional flag for the application parser.
      return { kind: 'system', formatFlag: null, payload: b.slice(1) };
    default:
      throw new RelayEnvelopeError('unknownKind', kind);
  }
}

/** `RelayKeepalive.relayEnvelope`: raw system envelope carrying ASCII "ping". */
export function keepaliveRelayEnvelope(): Uint8Array {
  return encodeSystem(new TextEncoder().encode('ping'));
}

// RelayKeepalive.commandEnvelope() encrypts "2" with LegacyCommandCipher.desktopServerCommands
// (3DES-CBC, static key/IV derived from a bundled constant), so the ciphertext is a constant.
// Bytes are the independent OpenSSL fixture asserted in RelayEnvelopeTests.swift; envelope.test.ts
// re-derives them with node:crypto. Replace with crypto.ts once LegacyCommandCipher is ported.
const KEEPALIVE_COMMAND_CIPHERTEXT = [0x2d, 0x93, 0x29, 0x71, 0xdd, 0x9d, 0xcb, 0x2d];

/** `RelayKeepalive.commandEnvelope()`: system envelope, explicit flag false, encrypted "2". */
export function keepaliveCommandEnvelope(): Uint8Array {
  return encodeSystem(new Uint8Array(KEEPALIVE_COMMAND_CIPHERTEXT), false);
}

const HOST_PATTERN = /^[\x21-\x7e]+$/;

/** Exact streaming HTTP request headers from VTCPClient 0x06000e25. */
export function httpPreamble(host: string, method: 'POST' | 'GET' = 'POST'): Uint8Array {
  // Input validation prevents a user-provided host from adding headers.
  if (!HOST_PATTERN.test(host)) throw new RelayHTTPPreambleError('invalidHost');
  const lines = [
    `${method} /UVService/ HTTP/1.1`,
    'User-Agent: Mozilla/4.0 (compatible; MSIE5.01; Windows NT)',
    'Content-Type: application/octet-stream',
    'Connection: Keep-Alive',
    'Content-length: 8589934590',
    `Host: ${host}`,
    '',
    '',
  ];
  return new TextEncoder().encode(lines.join('\r\n'));
}

/**
 * Bounded equivalent of VTCPClient's first-response CRLFCRLF stripping. Recognizes the
 * header boundary only; does not validate HTTP status. After the header, all bytes pass through.
 */
export class PreambleDecoder {
  readonly maximumHeaderBytes: number;
  hasReceivedHeader = false;
  /** Diagnostic only. null for unrecognized or non-HTTP headers. */
  responseStatusCode: number | null = null;
  private readonly header: Uint8Array;
  private headerLength = 0;

  constructor(maximumHeaderBytes: number = 32768) {
    if (!Number.isInteger(maximumHeaderBytes) || maximumHeaderBytes < 4) {
      throw new RangeError('maximumHeaderBytes must be >= 4');
    }
    this.maximumHeaderBytes = maximumHeaderBytes;
    this.header = new Uint8Array(maximumHeaderBytes);
  }

  /** Returns only bytes following the first complete header (empty until the header ends). */
  push(chunk: Uint8Array): Uint8Array {
    if (this.hasReceivedHeader) return chunk;
    for (let cursor = 0; cursor < chunk.length; ) {
      if (this.headerLength >= this.maximumHeaderBytes) {
        this.headerLength = 0;
        throw new RelayHTTPPreambleDecoderError('headerTooLarge');
      }
      this.header[this.headerLength++] = chunk[cursor++]!;
      const n = this.headerLength;
      if (n >= 4 && this.header[n - 4] === 13 && this.header[n - 3] === 10 &&
          this.header[n - 2] === 13 && this.header[n - 1] === 10) {
        this.hasReceivedHeader = true;
        this.responseStatusCode = parseStatusCode(this.header.subarray(0, n));
        this.headerLength = 0;
        return chunk.slice(cursor);
      }
    }
    return new Uint8Array();
  }

  reset(): void {
    this.headerLength = 0;
    this.hasReceivedHeader = false;
    this.responseStatusCode = null;
  }
}

function parseStatusCode(header: Uint8Array): number | null {
  let end = 0;
  while (end < header.length && header[end] !== 13 && header[end] !== 10) end++;
  const line = new TextDecoder().decode(header.subarray(0, end));
  const fields = line.split(' ').filter((f) => f.length > 0);
  const status = fields[1];
  if (fields.length >= 2 && fields[0]!.startsWith('HTTP/') && status !== undefined && /^[0-9]{3}$/.test(status)) {
    return Number(status);
  }
  return null;
}
