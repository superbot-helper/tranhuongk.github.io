import { describe, expect, test } from 'vitest';
import { PartnerLoginError, loginBytes, loginText, type LoginContext } from './login';
import { enc, expectError } from './test-utils';

function syntheticLoginContext(): LoginContext {
  return {
    screenPixelWidth: 1920, screenPixelHeight: 1080, desktopMetric: 7,
    screenTwipsPerPixelXText: '15', screenTwipsPerPixelYText: '15',
    formVerticalInset: 30, formHorizontalInset: 16,
    localID: '111222333', displayName: 'Mac: Viewer!', controlMode: 1,
    clearControlMode: false, localUserSID: 'S-1-5-21-1-2-3-1001',
    connectionHashKey: 'connection-key', displayColors: 32, displayQuality: 7,
    remoteWallpaperDisabled: -1, hasDesktopToken: true,
    partnerSecretToken: 'peer-secret', clientVersion: '6.0.0', desktopCounter: 42,
  };
}

// Ported from PartnerLoginMessageTests.swift (vectors unchanged).
describe('partner login (PartnerLoginMessageTests.swift)', () => {
  test('partnerLoginMatchesIndependentSyntheticFixture', () => {
    const cred = { password: 'test-pass', nonce: '12345678' };
    // MD5 values generated independently with Python hashlib from ASCII bytes:
    // b"12345678test-pass" and b" " * 32 + b"test-pass".
    const expected = 'login:12345678:c10f3394b41ec5b86060e0285e0dd306:' +
      '1920:1080:7:15:15:30:16:111222333:Mac Viewer:1:' +
      '85347ba7a403ffed52d311b7c5b6b549:S-1-5-21-1-2-3-1001:connection-key:32:7:-1:1:' +
      'peer-secret:6.0.0:42';
    expect(loginText(cred, syntheticLoginContext())).toBe(expected);
    expect(loginBytes(cred, syntheticLoginContext())).toEqual(enc(expected));
    expect(expected.split(':').length).toBe(23);
  });

  test('alternativeCredentialPreservesRecoveredBranchAndEmptyFields', () => {
    const context = syntheticLoginContext();
    context.clearControlMode = true;
    context.hasDesktopToken = false;
    context.partnerSecretToken = '';
    context.displayName = 'x'.repeat(30);
    const fields = loginText({ verbatim: 'opaque-proof' }, context).split(':');
    expect(fields.length).toBe(23);
    expect(fields[1]).toBe(' '.repeat(32));
    expect(fields[2]).toBe('opaque-proof');
    expect(fields[11]).toBe('x'.repeat(20));
    expect(fields[12]).toBe('0');
    expect(fields[13]).toBe('opaque-proof');
    expect(fields[19]).toBe('0');
    expect(fields[20]).toBe('');
  });

  test('partnerLoginRejectsAmbiguousEncodingAndFieldInjection', () => {
    for (const nonce of ['', '1234567', '123456789', '12:45678', '１２３４５６７８']) {
      expectError(
        () => loginText({ password: 'test', nonce }, syntheticLoginContext()), PartnerLoginError, 'invalidNonce');
    }
    expectError(
      () => loginText({ password: 'café', nonce: '12345678' }, syntheticLoginContext()),
      PartnerLoginError, 'unsupportedEncoding');
    const context = syntheticLoginContext();
    context.localID = 'id:extra-field';
    expectError(() => loginText({ password: 'test', nonce: '12345678' }, context), PartnerLoginError, 'invalidField');
    expectError(
      () => loginText({ verbatim: 'proof\nextra' }, syntheticLoginContext()), PartnerLoginError, 'invalidField');
  });

  test('display name: removed characters and non-ASCII', () => {
    const context = { ...syntheticLoginContext(), displayName: '!#$&?:/\\*,.@<>;\'"=ok' };
    expect(loginText({ password: 'p', nonce: '00000000' }, context).split(':')[11]).toBe('ok');
    expectError(
      () => loginText({ password: 'p', nonce: '00000000' }, { ...syntheticLoginContext(), displayName: 'café' }),
      PartnerLoginError, 'unsupportedEncoding');
  });

  test('login plaintext never contains the plain password', () => {
    expect(loginText({ password: 'test-pass', nonce: '12345678' }, syntheticLoginContext())).not.toContain('test-pass');
  });
});
