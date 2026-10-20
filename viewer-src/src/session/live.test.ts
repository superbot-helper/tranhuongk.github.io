// LIVE check (ruling R3, Task 7): needs `npx wrangler dev` running in viewer-src/worker with a
// dev token in worker/.dev.vars. Run: LIVE=1 npx vitest run src/session/live.test.ts
// Registers a fresh identity with the real UltraViewer service (validates the fake
// IP/MAC/OS/computer-name values, ruling R10) and looks up a partner ID that does not exist.
// The token is read from the git-ignored file and never printed.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { DEV_WORKER_URL } from '../config';
import { resolveIPv4 } from '../net/dns';
import { createIdentity } from './identity';
import { RelaySession, type SessionEvent } from './relay-session';
import { workerChannelOpener } from './worker-channel';

const NONEXISTENT_PARTNER = '999999999';
const DUMMY_PARTNER_SECRET = 'not-a-real-partner-secret';

function devToken(): string {
  const vars = readFileSync(new URL('../../worker/.dev.vars', import.meta.url), 'utf8');
  const token = /^TOKEN_A=(.+)$/m.exec(vars)?.[1]?.trim();
  if (!token) throw new Error('TOKEN_A missing in worker/.dev.vars');
  return token;
}

describe.skipIf(!process.env.LIVE)('LIVE: register + lookup through the worker', () => {
  test('fresh identity is registered (ID assigned); a non-existent partner is rejected', async () => {
    const token = devToken();
    const identity = createIdentity();
    const session = new RelaySession({
      openChannel: workerChannelOpener({ workerUrl: process.env.WORKER ?? DEV_WORKER_URL, token }),
      resolve: resolveIPv4,
      now: () => performance.now(),
    });
    const events: SessionEvent[] = [];
    const closed = new Promise<void>((resolve) => {
      session.connect(
        { identity, partnerID: NONEXISTENT_PARTNER, password: DUMMY_PARTNER_SECRET, screenW: 1920, screenH: 1080, displayName: 'WebViewer' },
        (e) => {
          events.push(e);
          if (e.type === 'status') console.log(`[live session] ${e.text}`);
          if (e.type === 'closed') {
            console.log(`[live session] closed: ${e.reason}`);
            resolve();
          }
        },
      );
    });
    await closed;
    const emitted = JSON.stringify(events);
    expect(emitted).not.toContain(token);
    expect(emitted).not.toContain(DUMMY_PARTNER_SECRET);
    expect(emitted).not.toContain(identity.password);
    const d = session.diagnostics;
    console.log(`[live session] registrationAccepted=${d.registrationAccepted} assignedID=${d.assignedID} lookupStatus=${d.lookupStatus}`);
    expect(d.registrationAccepted).toBe(true);
    expect(d.assignedID).toMatch(/^[0-9]+$/);
    expect(events.at(-1)).toMatchObject({ type: 'closed' });
    expect(['lookupRejected', 'wrongPassword']).toContain((events.at(-1) as { reason: string }).reason);
  }, 60_000);
});
