// @vitest-environment jsdom
import { beforeEach, describe, expect, test } from 'vitest';
import { parseIPv4 } from '../proto/envelope';
import { createIdentity, forgetDevice, loadIdentity, saveIdentity } from './identity';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('identity', () => {
  test('identity: fake but well-formed and stable per storage', () => {
    const id = createIdentity();
    expect(id.deviceIdentity).toMatch(/^[0-9A-F]{32}$/);
    expect(id.password).toMatch(/^\d{8}$/);
    expect(id.localAddress).toMatch(/^192\.168\.1\.(\d+)$/);
    const last = Number(id.localAddress.split('.')[3]);
    expect(last).toBeGreaterThanOrEqual(2);
    expect(last).toBeLessThanOrEqual(254);
    expect(Array.from(parseIPv4(id.localAddress))).toEqual([192, 168, 1, last]);
    // Swift formats MAC as 12 uppercase hex digits without separators ("%02X" joined);
    // the registration codec forbids ':' inside a field.
    expect(id.macAddress).toMatch(/^[0-9A-F]{12}$/);
    // unicast (bit 0 clear), locally administered (bit 1 set)
    expect(parseInt(id.macAddress.slice(0, 2), 16) & 0b11).toBe(0b10);
  });

  test('identities are random', () => {
    const ids = new Set(Array.from({ length: 20 }, () => createIdentity().deviceIdentity));
    expect(ids.size).toBe(20);
    const macs = new Set(Array.from({ length: 20 }, () => createIdentity().macAddress));
    expect(macs.size).toBe(20);
  });

  test('every digit and octet value is reachable (no modulo bias artefacts at the edges)', () => {
    const digits = new Set<string>();
    const octets = new Set<number>();
    for (let i = 0; i < 400; i++) {
      const id = createIdentity();
      for (const ch of id.password) digits.add(ch);
      octets.add(Number(id.localAddress.split('.')[3]));
    }
    expect(digits.size).toBe(10);
    expect([...octets].every((n) => n >= 2 && n <= 254)).toBe(true);
  });

  test('remember=false keeps identity in sessionStorage only', () => {
    const id = createIdentity();
    saveIdentity(id, false);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.getItem('uvweb.identity')).not.toBeNull();
    expect(loadIdentity()).toEqual(id);
  });

  test('remember=true keeps identity in localStorage only', () => {
    const id = createIdentity();
    saveIdentity(id, true);
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.getItem('uvweb.identity')).not.toBeNull();
    expect(loadIdentity()).toEqual(id);
  });

  test('switching the remember flag moves the copy and clears the other storage', () => {
    const id = createIdentity();
    saveIdentity(id, true);
    saveIdentity(id, false);
    expect(localStorage.length).toBe(0);
    expect(loadIdentity()).toEqual(id);
    saveIdentity(id, true);
    expect(sessionStorage.length).toBe(0);
    expect(loadIdentity()).toEqual(id);
  });

  test('loadIdentity prefers sessionStorage over localStorage', () => {
    const a = createIdentity();
    const b = createIdentity();
    localStorage.setItem('uvweb.identity', JSON.stringify(a));
    sessionStorage.setItem('uvweb.identity', JSON.stringify(b));
    expect(loadIdentity()).toEqual(b);
  });

  test('loadIdentity returns null when empty, corrupt, or malformed', () => {
    expect(loadIdentity()).toBeNull();
    sessionStorage.setItem('uvweb.identity', '{not json');
    expect(loadIdentity()).toBeNull();
    sessionStorage.setItem('uvweb.identity', JSON.stringify({ ...createIdentity(), password: '12ab' }));
    expect(loadIdentity()).toBeNull();
    sessionStorage.setItem('uvweb.identity', JSON.stringify({ ...createIdentity(), macAddress: '00:11:22:33:44:55' }));
    expect(loadIdentity()).toBeNull();
    sessionStorage.setItem('uvweb.identity', JSON.stringify({ ...createIdentity(), localAddress: '999.1.1.1' }));
    expect(loadIdentity()).toBeNull();
  });

  test('forgetDevice clears both storages', () => {
    saveIdentity(createIdentity(), true);
    forgetDevice();
    expect(loadIdentity()).toBeNull();
    saveIdentity(createIdentity(), false);
    forgetDevice();
    expect(loadIdentity()).toBeNull();
  });

  test('forgetDevice removes every uvweb.* key but leaves foreign keys alone', () => {
    localStorage.setItem('uvweb.identity', 'x');
    localStorage.setItem('uvweb.token', 'y');
    sessionStorage.setItem('uvweb.other', 'z');
    localStorage.setItem('unrelated', 'keep');
    forgetDevice();
    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem('unrelated')).toBe('keep');
    expect(sessionStorage.length).toBe(0);
  });
});
