import { describe, expect, test } from 'vitest';
import {
  CLIENT_VERSION,
  LOGIN_DEFAULTS,
  LOOKUP_DEFAULTS,
  TWIPS_PER_PIXEL_TEXT,
  makeRegistrationRequest,
} from './client-defaults';
import { loginText } from './login';
import { lookupText } from './lookup';
import { registrationText } from './registration';

const identity = {
  deviceIdentity: '0123456789ABCDEF0123456789ABCDEF', password: '12345678',
  localAddress: '192.168.1.77', macAddress: 'A2B3C4D5E6F7',
};

describe('client defaults (MacRegistrationProfile.swift / UltraViewerRelaySession.swift values)', () => {
  test('constants', () => {
    expect(CLIENT_VERSION).toBe('6.6.133');
    expect(TWIPS_PER_PIXEL_TEXT).toBe('15');
  });

  test('default registration request passes the registration codec validation', () => {
    const fields = registrationText(makeRegistrationRequest(identity)).split(':');
    expect(fields.length).toBe(28);
    expect(fields[0]).toBe('3');
    expect(fields[1]).toBe(identity.deviceIdentity);
    expect(fields[2]).toBe(identity.password);
    expect(fields[4]).toBe('192.168.1.77');
    expect(fields[7]).toBe('6.6.133');
    expect(fields[8]).toBe('A2B3C4D5E6F7');
    expect(fields[9]).toBe(''); // diskIdentity
    expect(fields[14]).toBe('0'); // usesProxy false
    expect(fields.slice(17, 22)).toEqual(['0', '0', '0', '0', '0']);
    expect(fields.slice(22, 25)).toEqual(['0', '0', '0']);
  });

  test('default lookup/login fields yield well-formed messages', () => {
    const lookup = lookupText({
      ...LOOKUP_DEFAULTS, targetID: '123456789', credential: { kind: 'password', value: 'pw' },
      clientVersion: CLIENT_VERSION, localID: '111222333', localPassword: identity.password,
      correlationNumber: 7, dateTimeOffsetMinutes: -420,
    }).split(':');
    expect(lookup.length).toBe(17);
    expect(lookup.slice(8, 10)).toEqual(['-1', '7']);
    expect(lookup.slice(11, 17)).toEqual(['0', '0', '-420', '1', '', '']);
    const login = loginText({ password: 'pw', nonce: '12345678' }, {
      ...LOGIN_DEFAULTS, screenPixelWidth: 1920, screenPixelHeight: 1080, localID: '111222333',
      connectionHashKey: 'k', partnerSecretToken: '', controlMode: 1, clearControlMode: false,
    }).split(':');
    expect(login.length).toBe(23);
    expect(login[6]).toBe('15');
    expect(login[7]).toBe('15');
    expect(login[21]).toBe('6.6.133');
  });
});
