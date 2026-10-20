// Browser-side client identity: the (fake but well-formed) device identity, 8-digit client
// password, LAN address and MAC that the registration command sends, plus where they live.
// Mirrors MacRegistrationProfile (newPassword, deviceIdentity) and its stored-profile validation.
//
// Storage: key `uvweb.identity` (JSON). remember=false -> sessionStorage only; remember=true ->
// localStorage only. The ID/password never leave the browser except in the registration command.
import { parseIPv4 } from '../proto/envelope';

export interface ClientIdentity {
  /** 32 uppercase hex digits (MD5-sized, like MacRegistrationProfile.deviceIdentity). */
  deviceIdentity: string;
  /** 8 decimal digits (MacRegistrationProfile.newPassword). */
  password: string;
  /** Fake private address 192.168.1.N, N in 2...254; passes RelayIPv4Address validation. */
  localAddress: string;
  /**
   * 12 uppercase hex digits, no separators (MacRegistrationProfile formats "%02X" joined; the
   * registration codec rejects ':' in a field). First byte has bit 0 clear (unicast) and bit 1
   * set (locally administered).
   */
  macAddress: string;
}

export const STORAGE_KEY_PREFIX = 'uvweb.';
export const IDENTITY_STORAGE_KEY = 'uvweb.identity';

function randomBytes(count: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(count));
}

/** Unbiased uniform integer in [0, range) by rejection sampling over bytes (range <= 256). */
function randomBelow(range: number): number {
  const limit = 256 - (256 % range);
  for (;;) {
    for (const byte of randomBytes(16)) if (byte < limit) return byte % range;
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export function createIdentity(): ClientIdentity {
  const mac = randomBytes(6);
  mac[0] = (mac[0]! & 0xfc) | 0x02;
  let password = '';
  for (let i = 0; i < 8; i++) password += String(randomBelow(10));
  return {
    deviceIdentity: toHex(randomBytes(16)),
    password,
    localAddress: `192.168.1.${2 + randomBelow(253)}`,
    macAddress: toHex(mac),
  };
}

function isIdentity(value: unknown): value is ClientIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.deviceIdentity !== 'string' || !/^[0-9A-F]{32}$/.test(v.deviceIdentity)) return false;
  if (typeof v.password !== 'string' || !/^[0-9]{8}$/.test(v.password)) return false;
  if (typeof v.macAddress !== 'string' || !/^[0-9A-F]{12}$/.test(v.macAddress)) return false;
  if (typeof v.localAddress !== 'string') return false;
  try {
    parseIPv4(v.localAddress);
  } catch {
    return false;
  }
  return true;
}

function readFrom(storage: Storage): ClientIdentity | null {
  try {
    const raw = storage.getItem(IDENTITY_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isIdentity(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** sessionStorage first, then localStorage. null if absent, unreadable or malformed. */
export function loadIdentity(): ClientIdentity | null {
  try {
    return readFrom(sessionStorage) ?? readFrom(localStorage);
  } catch {
    return null; // storage inaccessible (blocked site data)
  }
}

/** Writes the chosen storage first, then clears the other, so a failed write loses nothing. */
export function saveIdentity(id: ClientIdentity, remember: boolean): void {
  const json = JSON.stringify(id);
  const [target, other] = remember ? [localStorage, sessionStorage] : [sessionStorage, localStorage];
  target.setItem(IDENTITY_STORAGE_KEY, json);
  other.removeItem(IDENTITY_STORAGE_KEY);
}

function clearPrefixed(storage: Storage): void {
  for (let i = storage.length - 1; i >= 0; i--) {
    const key = storage.key(i);
    if (key !== null && key.startsWith(STORAGE_KEY_PREFIX)) storage.removeItem(key);
  }
}

/** "Quên thiết bị này": removes every `uvweb.*` key from both storages. */
export function forgetDevice(): void {
  for (const getStorage of [() => sessionStorage, () => localStorage]) {
    try {
      clearPrefixed(getStorage());
    } catch {
      // storage inaccessible: nothing was stored there
    }
  }
}
