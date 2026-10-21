// LIVE check (ruling R3): needs `npx wrangler dev` running in viewer-src/worker (no token).
// Run: LIVE=1 npx vitest run src/net/live.test.ts   (WORKER=ws://127.0.0.1:<port> to override)
import { describe, expect, test } from 'vitest';
import { DEV_WORKER_URL } from '../config';
import { probeCommandTls } from '../spike/probe';

// Relays behind functions3 serve different leaves: 146.59.55.107 still serves the one that
// expired 2026-05-01 (fixtures/relay-chain.pem); the others (2026-10-20) serve a valid one.
const EXPIRED_RELAY = '146.59.55.107';

async function probe(ip?: string) {
  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
    console.log(`[live${ip ? ` ${ip}` : ''}] ${line}`);
  };
  const result = await probeCommandTls({ workerUrl: process.env.WORKER ?? DEV_WORKER_URL, log, ip });
  return result;
}

describe.skipIf(!process.env.LIVE)('LIVE: browser TLS to the command relay through the worker', () => {
  test('DoH -> pipe to the first A record -> TLS(SNI ultraviewer) -> HTTP preamble header', async () => {
    const result = await probe();
    expect(result.headerReceived).toBe(true);
  }, 45_000);

  test('the relay serving the expired certificate is accepted and reported expired', async () => {
    const result = await probe(EXPIRED_RELAY);
    expect(result.ip).toBe(EXPIRED_RELAY);
    expect(result.expired).toBe(true);
    expect(result.headerReceived).toBe(true);
  }, 45_000);

  test('a private target surfaces the worker close code 4403', async () => {
    const err = await probeCommandTls({
      workerUrl: process.env.WORKER ?? DEV_WORKER_URL,
      log: () => {},
      ip: '192.168.1.1',
    }).catch((e: unknown) => e);
    console.log(`[live forbidden target] ${(err as Error).name}: ${(err as Error).message}`);
    expect((err as Error).message).toContain('4403');
  }, 45_000);
});
