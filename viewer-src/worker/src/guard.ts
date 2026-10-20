/** Request guards for the WS⇄TCP pipe. Pure functions; never touch payload bytes. */

export const SUBPROTOCOL = 'uvpipe';
export const ALLOWED_PORT = 443;

export interface TokenEnv {
  TOKEN_A?: string;
  TOKEN_B?: string;
}

const DOTTED_QUAD = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;

function parseIPv4(ip: string): [number, number, number, number] | null {
  const m = DOTTED_QUAD.exec(ip);
  if (!m) return null;
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (o.some((n) => n > 255)) return null;
  return o as [number, number, number, number];
}

/** True only for a canonical dotted-quad IPv4 outside every special-use range. */
export function isPublicIPv4(ip: string): boolean {
  const o = parseIPv4(ip);
  if (!o) return false;
  const [a, b, c] = o;
  if (a === 0 || a === 10 || a === 127) return false; // this-net, private, loopback
  if (a >= 224) return false; // multicast, reserved, broadcast
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // private 172.16/12
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF 192.0.0/24, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking 198.18/15
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  return true;
}

/** Validates `ip`/`port` query values. Only public IPv4 literals on 443 pass. */
export function parseTarget(
  ip: string | null,
  port: string | null,
): { ip: string; port: 443 } | null {
  if (ip === null || port === null) return null;
  if (port !== String(ALLOWED_PORT)) return null;
  if (!isPublicIPv4(ip)) return null;
  return { ip, port: ALLOWED_PORT };
}

/** Extracts the token from `Sec-WebSocket-Protocol: uvpipe, <token>`. */
export function tokenFromProtocols(header: string | null): string | null {
  if (!header) return null;
  const parts = header.split(',').map((p) => p.trim());
  if (!parts.includes(SUBPROTOCOL)) return null;
  const token = parts.find((p) => p !== '' && p !== SUBPROTOCOL);
  return token ?? null;
}

async function sha256(text: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(text);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Constant-time (over SHA-256 digests) comparison against both configured secrets. */
export async function tokenValid(token: string, env: TokenEnv): Promise<boolean> {
  if (token === '') return false;
  const presented = await sha256(token);
  let ok = false;
  for (const secret of [env.TOKEN_A, env.TOKEN_B]) {
    if (!secret) continue; // unset or empty secret never matches
    ok = constantTimeEqual(presented, await sha256(secret)) || ok;
  }
  return ok;
}
