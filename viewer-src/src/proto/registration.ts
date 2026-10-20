// Port of UltraViewerProtocol/ClientRegistration.swift.
// Initial desktop command 3, reconstructed from frmMain.InitMyPassword at 0x67cb00.
// This codec does not discover a server or authenticate a peer.
import { commandCipher, type LegacyCommandCipher } from './crypto';
import { encodeSystem, parseIPv4 } from './envelope';
import { encodeFrame } from './frame';

export type RegistrationErrorCode =
  | 'unsupportedEncoding' | 'invalidField' | 'payloadTooLarge' | 'tooManyFields' | 'missingFields'
  | 'invalidCommand' | 'invalidPort' | 'invalidID' | 'invalidAddress' | 'invalidStatus';

export class RegistrationError extends Error {
  readonly code: RegistrationErrorCode;
  /** Swift's `invalidField(Int)` associated value: the wire-field index. null for other codes. */
  readonly field: number | null;
  constructor(code: RegistrationErrorCode, field: number | null = null) {
    super(field === null ? code : `${code}(${field})`);
    this.name = 'RegistrationError';
    this.code = code;
    this.field = field;
  }
}

/**
 * Windows-specific identity/configuration inputs are explicit (see client-defaults.ts for the
 * web viewer's values). Numbers are the Swift Int32/Int16 fields. `localAddress` is dotted
 * decimal; it is validated (and canonicalized) when the text is built.
 */
export interface RegistrationRequest {
  /** Desktop global 0x7e20dc; 32 uppercase hex. */
  deviceIdentity: string;
  password: string;
  localAddress: string;
  /** Output of VFunction.EncodeUTF8Base64(GetComputerName()). */
  computerNameUTF8Base64: string;
  clientVersion: string;
  macAddress: string;
  /** Desktop global 0x7e211c. Colons become hyphens on serialization. */
  diskIdentity: string;
  /** GetOSVersionCombine: Build|Major|MajorRevision|Minor|MinorRevision|Revision. */
  operatingSystem: string;
  /** Desktop global 0x7e2124 (Int32). */
  installerReferral: number;
  customPassword: string;
  /** VTCPNhanLenh.UsingProxy (DISPID 0x2a), independent of TLS. */
  usesProxy: boolean;
  /** Desktop global 0x7e2118; normally empty without quick-support config. */
  quickSupportMetadata: string;
  /** Already encoded output of EncodeBase64IfNotASCII(Environ("USERNAME")). */
  userNameWireValue: string;
  activeSessionID: number;
  processSessionID: number;
  /** Preserve the caller's VB Double-compatible text without locale guesses. */
  preferredIDText: string;
  referralIDText: string;
  /** Int16. */
  automaticUpdate: number;
  /** UTC .NET DateTime ticks, or the observed helper failure value "0". */
  systemFolderCreationTicks: string;
  programFilesCreationTicks: string;
  systemVolumeInformationCreationTicks: string;
  /** Unnamed license-context strings from globals 0x7e2100 / 0x7e2104. */
  licenseContext1: string;
  licenseContext2: string;
  /** Desktop global 0x7e21dc; empty until its CAPTCHA callback supplies it. */
  captchaToken: string;
}

export interface RegistrationOptions {
  maximumPayloadBytes?: number;
}

const DEFAULT_MAXIMUM_PAYLOAD_BYTES = 65_536;
const encoder = new TextEncoder();

function utf8Length(s: string): number {
  return encoder.encode(s).length;
}

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) >= 128) return false;
  return true;
}

function isPrintableAscii(s: string, allowColon: boolean): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c > 126 || (!allowColon && c === 58)) return false;
  }
  return true;
}

function validateField(value: string, index: number): void {
  if (!isAscii(value)) throw new RegistrationError('unsupportedEncoding');
  if (!isPrintableAscii(value, false)) throw new RegistrationError('invalidField', index);
}

/**
 * The timestamp composite contributes three wire fields. There are 28 fields, including the
 * command and every empty field, in this branch.
 */
export function registrationText(r: RegistrationRequest, options: RegistrationOptions = {}): string {
  const maximumPayloadBytes = options.maximumPayloadBytes ?? DEFAULT_MAXIMUM_PAYLOAD_BYTES;
  const localAddress = Array.from(parseIPv4(r.localAddress)).join('.');
  const fields = [
    '3', r.deviceIdentity, r.password, '0', localAddress, '0',
    r.computerNameUTF8Base64, r.clientVersion, r.macAddress,
    r.diskIdentity.replaceAll(':', '-'), r.operatingSystem,
    String(r.installerReferral), '', r.customPassword, r.usesProxy ? '-1' : '0',
    r.quickSupportMetadata, r.userNameWireValue, String(r.activeSessionID),
    String(r.processSessionID), r.preferredIDText, r.referralIDText, String(r.automaticUpdate),
    r.systemFolderCreationTicks, r.programFilesCreationTicks,
    r.systemVolumeInformationCreationTicks, r.licenseContext1, r.licenseContext2, r.captchaToken,
  ];
  let byteCount = fields.length - 1;
  if (maximumPayloadBytes < byteCount) throw new RegistrationError('payloadTooLarge');
  fields.forEach((field, index) => {
    validateField(field, index);
    if (utf8Length(field) > maximumPayloadBytes - byteCount) throw new RegistrationError('payloadTooLarge');
    byteCount += utf8Length(field);
  });
  return fields.join(':');
}

/** ASCII is an exact subset of the desktop's Windows ANSI conversion. */
export function registrationBytes(r: RegistrationRequest, options: RegistrationOptions = {}): Uint8Array {
  return encoder.encode(registrationText(r, options));
}

/**
 * Inner command envelope: 01 00 followed by configured 3DES ciphertext. The second byte is the
 * explicit TCP-v2 format flag; it is not part of the encrypted plaintext.
 */
export function registrationEnvelope(
  r: RegistrationRequest,
  cipher: LegacyCommandCipher = commandCipher,
  options: RegistrationOptions = {},
): Uint8Array {
  return encodeSystem(cipher.encrypt(registrationBytes(r, options)), false);
}

export function registrationFramed(
  r: RegistrationRequest,
  cipher: LegacyCommandCipher = commandCipher,
  options: RegistrationOptions = {},
): Uint8Array {
  return encodeFrame(registrationEnvelope(r, cipher, options));
}

/**
 * Plain server command 3 after the outer relay kind byte has been stripped.
 * A parsed registration reply establishes no partner authentication claim.
 */
export interface RegistrationReply {
  publicPort: number;
  assignedID: bigint;
  /** Canonical dotted decimal. */
  publicAddress: string;
  status: number;
  /** All original fields, including empty/unknown fields and future tails. */
  fields: string[];
  assignedIDText: string;
  pingList: string;
  /** The desktop only consumes field 9 when its socket uses TLS. */
  pingHostNameList: string;
  opaqueServerToken: string;
  requestsOldVersionWarning: boolean;
  /** dd/MM/yyyy text preserved verbatim; null when status is -1. No license meaning inferred. */
  statusDateText: string | null;
}

export interface RegistrationReplyOptions {
  maximumPayloadBytes?: number;
  maximumFieldCount?: number;
}

const UNSIGNED_DECIMAL = /^[0-9]+$/;
const UINT64_MAX = 0xffffffffffffffffn;
const INT32_MIN = -0x80000000;
const INT32_MAX = 0x7fffffff;
// Swift: Int32(text) succeeds and String(status) == text, i.e. canonical decimal.
const CANONICAL_INT = /^(0|-?[1-9][0-9]*)$/;

/**
 * Budgets are local defenses, not recovered protocol limits. The native branch indexes field 10
 * unconditionally, so at least 11 fields are required.
 */
export function parseRegistrationReply(plain: Uint8Array, options: RegistrationReplyOptions = {}): RegistrationReply {
  const maximumPayloadBytes = options.maximumPayloadBytes ?? DEFAULT_MAXIMUM_PAYLOAD_BYTES;
  const maximumFieldCount = options.maximumFieldCount ?? 128;
  if (maximumPayloadBytes < 0 || plain.length > maximumPayloadBytes) throw new RegistrationError('payloadTooLarge');
  if (!plain.every((b) => b >= 32 && b <= 126)) throw new RegistrationError('unsupportedEncoding');
  if (maximumFieldCount <= 0) throw new RegistrationError('tooManyFields');
  let fieldCount = 1;
  for (const byte of plain) {
    if (byte !== 58) continue;
    if (fieldCount >= maximumFieldCount) throw new RegistrationError('tooManyFields');
    fieldCount++;
  }
  if (fieldCount < 11) throw new RegistrationError('missingFields');
  const fields = new TextDecoder().decode(plain).split(':');
  if (fields[0] !== '3') throw new RegistrationError('invalidCommand');
  const portText = fields[1]!;
  const port = UNSIGNED_DECIMAL.test(portText) ? Number(portText) : NaN;
  if (!(port >= 1 && port <= 0xffff)) throw new RegistrationError('invalidPort');
  const idText = fields[2]!;
  const id = UNSIGNED_DECIMAL.test(idText) ? BigInt(idText) : 0n;
  if (id === 0n || id > UINT64_MAX) throw new RegistrationError('invalidID');
  let address: string;
  try {
    address = Array.from(parseIPv4(fields[3]!)).join('.');
  } catch {
    throw new RegistrationError('invalidAddress');
  }
  const statusText = fields[7]!;
  const status = CANONICAL_INT.test(statusText) ? Number(statusText) : NaN;
  if (!(status >= INT32_MIN && status <= INT32_MAX)) throw new RegistrationError('invalidStatus');
  return {
    publicPort: port,
    assignedID: id,
    publicAddress: address,
    status,
    fields,
    assignedIDText: id.toString(),
    pingList: fields[6]!,
    pingHostNameList: fields[9]!,
    opaqueServerToken: fields[10]!,
    requestsOldVersionWarning: fields[5] === '1',
    statusDateText: status === -1 ? null : fields[8]!,
  };
}
