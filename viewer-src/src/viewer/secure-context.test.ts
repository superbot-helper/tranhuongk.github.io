import { describe, expect, test } from 'vitest';
import { INSECURE_CONTEXT_NOTICE, insecureContextNotice } from './secure-context';

describe('insecureContextNotice', () => {
  test('secure context with crypto.subtle: no notice', () => {
    expect(insecureContextNotice({ isSecureContext: true, crypto: { subtle: {} } })).toBeNull();
  });

  test('a non-secure context (http://<LAN-IP>) gives the Vietnamese notice', () => {
    const notice = insecureContextNotice({ isSecureContext: false, crypto: { subtle: undefined } });
    expect(notice).toBe(INSECURE_CONTEXT_NOTICE);
    expect(notice).toContain('HTTPS hoặc localhost');
    expect(notice).toContain('adb reverse');
  });

  test('crypto.subtle missing is enough, even if isSecureContext is unknown', () => {
    expect(insecureContextNotice({ crypto: {} })).toBe(INSECURE_CONTEXT_NOTICE);
    expect(insecureContextNotice({})).toBe(INSECURE_CONTEXT_NOTICE);
  });
});
