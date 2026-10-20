// Port of UltraViewerProtocol/LegacyCommandCipher.swift (+ the MD5 helper that PeerLookup,
// PartnerLoginMessage and MacRegistrationProfile each carry privately in Swift).
import forge from 'node-forge';

export type LegacyCommandCipherCode = 'malformedCiphertext' | 'invalidPadding' | 'cryptorFailed';

export class LegacyCommandCipherError extends Error {
  readonly code: LegacyCommandCipherCode;
  constructor(code: LegacyCommandCipherCode, message: string = code) {
    super(message);
    this.name = 'LegacyCommandCipherError';
    this.code = code;
  }
}

const BLOCK_SIZE = 8; // kCCBlockSize3DES

function toBinary(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

function fromBinary(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function sha1Binary(binary: string): string {
  return forge.md.sha1.create().update(binary).digest().getBytes();
}

/**
 * VFunction.EncryptData/DecryptData (0x06001472/0x06001473), using an explicit password.
 * This legacy server-command cipher is distinct from P2P AES.
 * 3DES-EDE3-CBC, PKCS7; no IV, length or transport prefix is prepended.
 */
export class LegacyCommandCipher {
  private readonly key: string;
  private readonly iv: string;

  constructor(password: string) {
    // 0x06001485 hashes .NET Encoding.Unicode (UTF-16LE), then resizes the 20-byte SHA1
    // digest to the 24-byte TripleDES key, zero-extending it. IV = SHA1("")[0..8].
    let utf16le = '';
    for (let i = 0; i < password.length; i++) {
      const unit = password.charCodeAt(i);
      utf16le += String.fromCharCode(unit & 0xff, unit >> 8);
    }
    this.key = sha1Binary(utf16le) + '\0\0\0\0';
    this.iv = sha1Binary('').slice(0, BLOCK_SIZE);
  }

  encrypt(plaintext: Uint8Array): Uint8Array {
    const cipher = forge.cipher.createCipher('3DES-CBC', this.key);
    cipher.start({ iv: this.iv });
    cipher.update(forge.util.createBuffer(toBinary(plaintext)));
    if (!cipher.finish()) throw new LegacyCommandCipherError('cryptorFailed');
    return fromBinary(cipher.output.getBytes());
  }

  decrypt(ciphertext: Uint8Array): Uint8Array {
    if (ciphertext.length === 0 || ciphertext.length % BLOCK_SIZE !== 0) {
      throw new LegacyCommandCipherError('malformedCiphertext');
    }
    const decipher = forge.cipher.createDecipher('3DES-CBC', this.key);
    decipher.start({ iv: this.iv });
    decipher.update(forge.util.createBuffer(toBinary(ciphertext)));
    // Padding is validated below exactly as Swift does; forge's own unpad is bypassed.
    // (@types/node-forge omits the legacy `pad` argument of BlockCipher.finish.)
    const finish = decipher.finish as (pad?: () => boolean) => boolean;
    if (!finish.call(decipher, () => true)) throw new LegacyCommandCipherError('cryptorFailed');
    const output = fromBinary(decipher.output.getBytes());
    if (output.length === 0) throw new LegacyCommandCipherError('invalidPadding');
    const padding = output[output.length - 1]!;
    if (padding < 1 || padding > BLOCK_SIZE || padding > output.length) {
      throw new LegacyCommandCipherError('invalidPadding');
    }
    for (let i = output.length - padding; i < output.length; i++) {
      if (output[i] !== padding) throw new LegacyCommandCipherError('invalidPadding');
    }
    return output.slice(0, output.length - padding);
  }
}

/**
 * `LegacyCommandCipher.desktopServerCommands`: static command-cipher configuration observed at
 * desktop VA 0x635a8c. A bundled protocol constant, not a partner/session credential.
 */
export const commandCipher = new LegacyCommandCipher(String.fromCharCode(5, 10, 15, 20, 25));

/**
 * MD5 of the UTF-8 bytes of `s` as hex. Swift call sites (PeerLookup.md5, PartnerLoginMessage.md5)
 * use lowercase (`%02x`); MacRegistrationProfile.deviceIdentity uses uppercase (`%02X`) over raw
 * bytes, available here as `{upper: true}`.
 */
export function md5Hex(s: string, options: { upper?: boolean } = {}): string {
  const hex = forge.md.md5.create().update(s, 'utf8').digest().toHex();
  return options.upper ? hex.toUpperCase() : hex;
}
