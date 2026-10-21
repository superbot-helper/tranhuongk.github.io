import { describe, expect, test } from 'vitest';
import { isPublicIPv4, parseTarget } from '../src/guard';

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
