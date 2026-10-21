// The screen dictionary is pinned by SHA-256 (crypto.subtle) and the Worker is reached over
// wss://: both need a secure context (HTTPS or localhost). On http://<LAN-IP> (e.g. a phone
// opening the dev server) crypto.subtle is undefined, so say so up front instead of letting the
// session die later with a TypeError. The integrity check itself is never relaxed.

export const INSECURE_CONTEXT_NOTICE =
  'Trang cần chạy qua HTTPS hoặc localhost: trình duyệt không cho dùng mã hoá (crypto.subtle) trên địa chỉ http:// này, nên không thể kết nối. ' +
  'Hãy mở bản đã triển khai (HTTPS), hoặc trên điện thoại Android dùng "adb reverse tcp:5173 tcp:5173" và "adb reverse tcp:8787 tcp:8787" rồi mở http://localhost:5173.';

export interface SecureContextEnv {
  isSecureContext?: boolean;
  crypto?: { subtle?: unknown };
}

/** The Vietnamese notice when the page cannot verify the dictionary/talk to the Worker, else null. */
export function insecureContextNotice(env: SecureContextEnv = globalThis): string | null {
  return env.isSecureContext === false || !env.crypto?.subtle ? INSECURE_CONTEXT_NOTICE : null;
}
