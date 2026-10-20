// Port of UltraViewerProtocol/PeerLookup.swift.
// Colon-delimited command 8 plaintext, before the separate command cipher and transport
// envelope. No operation here connects or authenticates a peer.
// DirectDetails (LAN direct) is not ported: the web viewer never sends it, so request field 16
// is always empty. Reply field 21 (`directDetailsField`) is still preserved.
import { md5Hex } from './crypto';

export type PeerLookupErrorCode =
  | 'unsupportedEncoding' | 'invalidField' | 'invalidReply' | 'invalidNumber' | 'payloadTooLarge';

export class PeerLookupError extends Error {
  readonly code: PeerLookupErrorCode;
  /** Swift's `invalidNumber(field:)` associated value. null for other codes. */
  readonly field: number | null;
  constructor(code: PeerLookupErrorCode, field: number | null = null) {
    super(field === null ? code : `${code}(field: ${field})`);
    this.name = 'PeerLookupError';
    this.code = code;
    this.field = field;
  }
}

export type LookupCredential =
  | { kind: 'password'; value: string }
  /** The native PasswordType != 0 branch sends this value verbatim. */
  | { kind: 'verbatim'; value: string };

export interface LookupRequest {
  targetID: string;
  credential: LookupCredential;
  clientVersion: string;
  /** Desktop global 0x7e2100: license-context text, exact meaning unresolved. */
  licenseContext: string;
  /** Desktop global 0x7e2104: license-context text, exact meaning unresolved. */
  additionalLicenseContext: string;
  localID: string;
  /** Main form's txtPassword.Text, used only to form the local MD5 proof. */
  localPassword: string;
  /** Int32. */
  targetSessionID: number;
  /** Original desktop's Form hwnd, serialized as a signed Long (Int32). */
  correlationNumber: number;
  isReconnect: boolean;
  /** Preserve native VB Double-to-text formatting as an explicit input. */
  referralIDText: string;
  paymentTypeText: string;
  dateTimeOffsetMinutes: number;
  objectDictionaryCount: number;
  fixedPingList: string;
}

const MAXIMUM_PAYLOAD_BYTES = 65_536;
const encoder = new TextEncoder();

function validateASCII(value: string): void {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) >= 128) throw new PeerLookupError('unsupportedEncoding');
  }
}

function validateField(value: string): void {
  validateASCII(value);
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 32 || c > 126 || c === 58) throw new PeerLookupError('invalidField');
  }
}

export function lookupText(r: LookupRequest): string {
  let peerProof: string;
  if (r.credential.kind === 'password') {
    validateASCII(r.credential.value);
    peerProof = md5Hex(' '.repeat(32) + r.credential.value);
  } else {
    validateField(r.credential.value);
    peerProof = r.credential.value;
  }
  validateASCII(r.localPassword);
  const fields = [
    '8', r.targetID, peerProof, r.clientVersion, r.licenseContext,
    r.additionalLicenseContext, r.localID, md5Hex(r.localID + r.localPassword),
    String(r.targetSessionID), String(r.correlationNumber),
    r.isReconnect ? '-1' : '0', r.referralIDText, r.paymentTypeText,
    String(r.dateTimeOffsetMinutes), String(r.objectDictionaryCount),
    r.fixedPingList, '',
  ];
  for (const field of fields) validateField(field);
  const result = fields.join(':');
  if (encoder.encode(result).length > MAXIMUM_PAYLOAD_BYTES) throw new PeerLookupError('payloadTooLarge');
  return result;
}

export function lookupBytes(r: LookupRequest): Uint8Array {
  return encoder.encode(lookupText(r));
}

export interface PeerInfo {
  lanIP: string;
  publicIP: string;
  publicPort: number;
  lanPort: number;
  commandPort: number;
  /** Native DecodeUTF8Base64 consumes field 8; the codec preserves it raw. */
  computerNameField: string;
  /**
   * Native TargetTCPPort, reply field 9: used with publicIP for relay forwarding and public P2P
   * targeting. The relay listener Connect port comes separately from configuration.
   */
  targetTCPPort: number;
  /** Native TargetTCPServerIP, reply field 11: relay Connect host. */
  relayIP: string;
  /** Numeric Boolean text, usually 0 or -1 (Int16). */
  matchedCustomPassword: number;
  targetSessionID: number;
  relayHostname: string;
  partnerSecretToken: string | null;
  /** Native code reads field 21; its detailed subformat remains separate. */
  directDetailsField: string | null;
}

export interface LookupReply {
  /** Preserves unknown fields and optional suffixes. */
  fields: string[];
  status: number;
  /** The last field as Int32, or null. The native dispatcher uses it as a collection key. */
  correlationNumber: number | null;
  /**
   * Status 1 enters native peer-context setup. It is a lookup result, before transport
   * connection, Login, and application acceptance.
   */
  peerInfo(): PeerInfo | null;
}

/** Swift `Int32(text)` / `Int16(text)`: optional sign, decimal digits, in range; otherwise null. */
function parseSwiftInt(text: string, min: number, max: number): number | null {
  if (!/^[+-]?[0-9]+$/.test(text)) return null;
  const value = Number(text);
  return value >= min && value <= max ? value : null;
}

const int32 = (text: string): number | null => parseSwiftInt(text, -0x80000000, 0x7fffffff);

export function parseLookupReply(plain: Uint8Array): LookupReply {
  if (plain.length > MAXIMUM_PAYLOAD_BYTES) throw new PeerLookupError('payloadTooLarge');
  if (!plain.every((b) => b >= 32 && b <= 126)) throw new PeerLookupError('unsupportedEncoding');
  const fields = new TextDecoder().decode(plain).split(':');
  const status = fields.length >= 2 ? int32(fields[1]!) : null;
  if (fields.length < 2 || fields.length > 128 || fields[0] !== '8' || status === null) {
    throw new PeerLookupError('invalidReply');
  }
  const last = fields[fields.length - 1]!;
  return {
    fields,
    status,
    correlationNumber: int32(last),
    peerInfo(): PeerInfo | null {
      if (status !== 1) return null;
      if (fields.length < 15) throw new PeerLookupError('invalidReply');
      const number = (index: number): number => {
        const value = int32(fields[index]!);
        if (value === null) throw new PeerLookupError('invalidNumber', index);
        return value;
      };
      const matched = parseSwiftInt(fields[12]!, -0x8000, 0x7fff);
      if (matched === null) throw new PeerLookupError('invalidNumber', 12);
      return {
        lanIP: fields[2]!,
        publicIP: fields[4]!,
        publicPort: number(5),
        lanPort: number(6),
        commandPort: number(7),
        computerNameField: fields[8]!,
        targetTCPPort: number(9),
        relayIP: fields[11]!,
        matchedCustomPassword: matched,
        targetSessionID: number(13),
        relayHostname: fields[14]!,
        partnerSecretToken: fields.length > 20 ? fields[20]! : null,
        directDetailsField: fields.length > 21 ? fields[21]! : null,
      };
    },
  };
}
