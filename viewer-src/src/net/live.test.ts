// LIVE check (ruling R3): needs `npx wrangler dev` running in viewer-src/worker with a dev
// token in worker/.dev.vars. Run: LIVE=1 npx vitest run src/net/live.test.ts
// The token is read from the git-ignored file and never printed.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { DEV_WORKER_URL } from '../config';
import { probeCommandTls } from '../spike/probe';

// Relays behind functions3 serve different leaves: 146.59.55.107 still serves the one that
// expired 2026-05-01 (fixtures/relay-chain.pem); the others (2026-10-20) serve a valid one.
const EXPIRED_RELAY = '146.59.55.107';

function devToken(): string {
  const vars = readFileSync(new URL('../../worker/.dev.vars', import.meta.url), 'utf8');
  const token = /^TOKEN_A=(.+)$/m.exec(vars)?.[1]?.trim();
  if (!token) throw new Error('TOKEN_A missing in worker/.dev.vars');
  return token;
}

async function probe(ip?: string) {
  const token = devToken();
  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
    console.log(`[live${ip ? ` ${ip}` : ''}] ${line}`);
  };
  const result = await probeCommandTls({ workerUrl: process.env.WORKER ?? DEV_WORKER_URL, token, log, ip });
  expect(lines.join('\n')).not.toContain(token);
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

  test('a wrong token surfaces the worker close code 4401', async () => {
    const err = await probeCommandTls({
      workerUrl: process.env.WORKER ?? DEV_WORKER_URL,
      token: '00'.repeat(32),
      log: () => {},
      ip: EXPIRED_RELAY,
    }).catch((e: unknown) => e);
    console.log(`[live bad token] ${(err as Error).name}: ${(err as Error).message}`);
    expect((err as Error).message).toContain('4401');
  }, 45_000);
});
