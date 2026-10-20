import { describe, expect, test } from 'vitest';
import { isPublicIPv4, parseTarget, tokenFromProtocols, tokenValid } from '../src/guard';

describe('parseTarget', () => {
  test.each([
    '10.0.0.1', '172.16.5.4', '192.168.1.1', '127.0.0.1', '169.254.1.1', '100.64.0.1',
    '0.1.2.3', '224.0.0.1', '255.255.255.255', '::1', 'functions3.ultraviewer.net', '1.2.3', '1.2.3.256',
  ])('rejects %s', (ip) => expect(parseTarget(ip, '443')).toBeNull());

  test.each([
    '172.15.0.1x', '01.2.3.4', '1.2.3.4.5', ' 1.2.3.4', '1.2.3.4 ', '+1.2.3.4', '0x7f.0.0.1', '1.2.3.-4', '', '[::1]',
    '::ffff:1.2.3.4', '2130706433',
  ])('rejects malformed %j', (ip) => expect(parseTarget(ip, '443')).toBeNull());

  test.each([
    '192.0.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '240.0.0.1', '172.31.255.255', '100.127.0.1',
  ])('rejects reserved %s', (ip) => expect(isPublicIPv4(ip)).toBe(false));

  test('accepts relay IP on 443', () =>
    expect(parseTarget('146.59.55.107', '443')).toEqual({ ip: '146.59.55.107', port: 443 }));

  test.each(['8.8.8.8', '172.32.0.1', '172.15.255.255', '100.128.0.1', '1.1.1.1'])('accepts public %s', (ip) =>
    expect(isPublicIPv4(ip)).toBe(true));

  test('rejects other ports', () => {
    expect(parseTarget('146.59.55.107', '80')).toBeNull();
    expect(parseTarget('146.59.55.107', null)).toBeNull();
    expect(parseTarget('146.59.55.107', '0443')).toBeNull();
    expect(parseTarget('146.59.55.107', '443 ')).toBeNull();
    expect(parseTarget(null, '443')).toBeNull();
  });
});

describe('tokenFromProtocols', () => {
  test('token parsing', () => {
    expect(tokenFromProtocols('uvpipe, abc')).toBe('abc');
    expect(tokenFromProtocols('abc')).toBeNull();
    expect(tokenFromProtocols(null)).toBeNull();
  });
  test('tolerates spacing and order, rejects empty', () => {
    expect(tokenFromProtocols('uvpipe,abc')).toBe('abc');
    expect(tokenFromProtocols('abc, uvpipe')).toBe('abc');
    expect(tokenFromProtocols('uvpipe, ')).toBeNull();
    expect(tokenFromProtocols('uvpipe')).toBeNull();
  });
});

describe('tokenValid', () => {
  test('token check uses either secret, rejects empty', async () => {
    const env = { TOKEN_A: 'a'.repeat(32), TOKEN_B: 'b'.repeat(32) };
    expect(await tokenValid('a'.repeat(32), env)).toBe(true);
    expect(await tokenValid('b'.repeat(32), env)).toBe(true);
    expect(await tokenValid('c'.repeat(32), env)).toBe(false);
    expect(await tokenValid('', { TOKEN_A: '' })).toBe(false);
  });
  test('unset secrets never match, even empty token', async () => {
    expect(await tokenValid('', {})).toBe(false);
    expect(await tokenValid('x', {})).toBe(false);
    expect(await tokenValid('a'.repeat(32), { TOKEN_B: 'b'.repeat(32) })).toBe(false);
  });
  test('prefix / different length does not match', async () => {
    const env = { TOKEN_A: 'a'.repeat(32) };
    expect(await tokenValid('a'.repeat(31), env)).toBe(false);
    expect(await tokenValid('a'.repeat(33), env)).toBe(false);
  });
});
