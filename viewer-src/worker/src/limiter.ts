import { DurableObject } from 'cloudflare:workers';

/**
 * A lease not renewed within this window is presumed leaked (Worker evicted or redeployed
 * before it could release) and ignored. Live pipes renew every few minutes (see index.ts).
 */
const LEASE_TTL_MS = 15 * 60 * 1000;

/**
 * Counts concurrent pipes for ONE client IP (the Durable Object is named after the SHA-256
 * of the IP, so the raw address is never stored). Leases are keyed by connection id.
 */
export class ConnLimiter extends DurableObject {
  async acquire(connId: string, max: number): Promise<boolean> {
    const now = Date.now();
    const leases = await this.ctx.storage.list<number>({ prefix: 'l:' });
    let active = 0;
    for (const [key, startedAt] of leases) {
      if (now - startedAt > LEASE_TTL_MS) await this.ctx.storage.delete(key);
      else active++;
    }
    if (active >= max) return false;
    await this.ctx.storage.put(`l:${connId}`, now);
    return true;
  }

  async renew(connId: string): Promise<void> {
    await this.ctx.storage.put(`l:${connId}`, Date.now());
  }

  async release(connId: string): Promise<void> {
    await this.ctx.storage.delete(`l:${connId}`);
  }
}
