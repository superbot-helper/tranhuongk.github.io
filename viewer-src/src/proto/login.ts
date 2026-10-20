// Port of UltraViewerProtocol/PartnerLoginMessage.swift.
// Partner authentication text reconstructed from desktop Form1.Login, 0x6d6a50. This is the
// application payload before routing, optional AES, and TCP framing. Several desktop globals
// remain unnamed; callers supply those values (defaults in client-defaults.ts).
import { md5Hex } from './crypto';

export type PartnerLoginErrorCode = 'invalidNonce' | 'unsupportedEncoding' | 'invalidField';

export class PartnerLoginError extends Error {
  readonly code: PartnerLoginErrorCode;
  constructor(code: PartnerLoginErrorCode) {
    super(code);
    this.name = 'PartnerLoginError';
    this.code = code;
  }
}

/**
 * `{password, nonce}`: PasswordType == 0, an eight-digit client nonce and two MD5 proofs.
 * `{verbatim}`: PasswordType != 0, the desktop sends this value in both proof fields; the
 * meaning and origin of this alternative credential are unverified.
 */
export type LoginCredential = { password: string; nonce: string } | { verbatim: string };

export interface LoginContext {
  /** Task 7: round(screen.width * devicePixelRatio). Not read here. */
  screenPixelWidth: number;
  screenPixelHeight: number;
  /** Desktop helper 0x70f650: smaller taskbar rectangle span scaled by TwipsPerPixel. */
  desktopMetric: number;
  /** Preserve the original Single-to-text representation. */
  screenTwipsPerPixelXText: string;
  screenTwipsPerPixelYText: string;
  formVerticalInset: number;
  formHorizontalInset: number;
  localID: string;
  displayName: string;
  /** Form1.Login's first ByRef Integer; its second Boolean can clear it. */
  controlMode: number;
  clearControlMode: boolean;
  /** Windows user SID from the TokenUser SID, stored at desktop VA 0x7e208c. */
  localUserSID: string;
  connectionHashKey: string;
  displayColors: number;
  displayQuality: number;
  /** VB6 Integer representation (normally 0 or -1). */
  remoteWallpaperDisabled: number;
  /** Whether the unnamed BSTR at desktop VA 0x7e20fc is nonempty. */
  hasDesktopToken: boolean;
  partnerSecretToken: string;
  /** App major.minor.revision text, stored at desktop VA 0x7e20c8. */
  clientVersion: string;
  /** Unnamed mGlobal Long at desktop VA 0x7e210c. */
  desktopCounter: number;
}

function validateASCII(value: string): void {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) >= 128) throw new PartnerLoginError('unsupportedEncoding');
  }
}

function validateField(value: string): void {
  validateASCII(value);
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 32 || c > 126 || c === 58) throw new PartnerLoginError('invalidField');
  }
}

// Native helper 0x6cb240 removes these ASCII characters and takes Left(20).
const REMOVED_FROM_DISPLAY_NAME = new Set('!#$&?:/\\*,.@<>;\'"=');

export function loginText(cred: LoginCredential, ctx: LoginContext): string {
  let nonce: string;
  let firstProof: string;
  let secondProof: string;
  if ('verbatim' in cred) {
    validateField(cred.verbatim);
    nonce = ' '.repeat(32);
    firstProof = cred.verbatim;
    secondProof = cred.verbatim;
  } else {
    if (!/^[0-9]{8}$/.test(cred.nonce)) throw new PartnerLoginError('invalidNonce');
    validateASCII(cred.password);
    nonce = cred.nonce;
    firstProof = md5Hex(nonce + cred.password);
    secondProof = md5Hex(' '.repeat(32) + cred.password);
  }
  validateASCII(ctx.displayName);
  const displayName = Array.from(ctx.displayName).filter((c) => !REMOVED_FROM_DISPLAY_NAME.has(c)).join('').slice(0, 20);
  const fields = [
    'login', nonce, firstProof,
    String(ctx.screenPixelWidth), String(ctx.screenPixelHeight),
    String(ctx.desktopMetric), ctx.screenTwipsPerPixelXText, ctx.screenTwipsPerPixelYText,
    String(ctx.formVerticalInset), String(ctx.formHorizontalInset),
    ctx.localID, displayName,
    String(ctx.clearControlMode ? 0 : ctx.controlMode), secondProof,
    ctx.localUserSID, ctx.connectionHashKey,
    String(ctx.displayColors), String(ctx.displayQuality),
    String(ctx.remoteWallpaperDisabled), ctx.hasDesktopToken ? '1' : '0',
    ctx.partnerSecretToken, ctx.clientVersion, String(ctx.desktopCounter),
  ];
  for (const field of fields) validateField(field);
  return fields.join(':');
}

/** ASCII is an exact subset of the original Windows ANSI conversion. */
export function loginBytes(cred: LoginCredential, ctx: LoginContext): Uint8Array {
  return new TextEncoder().encode(loginText(cred, ctx));
}
