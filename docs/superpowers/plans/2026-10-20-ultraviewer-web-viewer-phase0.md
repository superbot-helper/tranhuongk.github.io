# UltraViewer Web Viewer — Giai đoạn 0 (spike go/no-go) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trang thử trong trình duyệt kết nối qua Cloudflare Worker tới relay UltraViewer, đăng ký client, tra ID, đăng nhập vào máy Windows thật của chủ repo và **vẽ được frame màn hình đầu tiên** lên canvas; đồng thời đo phiên dài ≥ 30 phút qua Worker gói free.

**Architecture:** Front-end TypeScript (Vite) chạy toàn bộ giao thức trong browser: TLS (node-forge) chạy trên một ống byte WebSocket do Worker nối thẳng sang TCP `IPv4:443`. Giao thức là bản port 1-1 từ Swift `MacViewer/Sources/UltraViewerProtocol` (chỉ phía controller, bỏ LAN direct). zstd và (sau này) G.722 biên dịch từ mã C của MacViewer sang WASM bằng emscripten, file `.wasm` commit sẵn.

**Tech Stack:** TypeScript 5, Vite, Vitest, node-forge 1.4 (TLS 1.1 + 3DES + MD5), emscripten 6 (zstd 1.5.7 → WASM), Cloudflare Workers + wrangler.

**Spec:** `docs/superpowers/specs/2026-10-20-ultraviewer-web-viewer-design.md`

**Nguồn port:** MacViewer `v0.3.21` (commit `237c446`), clone tại `$MV` =
`/private/tmp/claude-502/-Users-huongtran7-Desktop-tranhuongk-all-payments/b2843a12-abee-4229-8d16-2fe518436325/scratchpad/macviewer/repo`
(nếu mất: `git clone https://github.com/DeanOpen/MacViewer $MV && git -C $MV checkout 237c446`).

## Global Constraints

- Repo `tranhuongk/tranhuongk.github.io`, Pages kiểu **legacy** (nhánh `master`, thư mục gốc, có Jekyll). Không thêm `.nojekyll` ở gốc, không đổi cách deploy, không sửa thư mục nào ngoài `viewer/`, `viewer-src/`, `docs/superpowers/`.
- Mã nguồn ở `viewer-src/`; bản build tĩnh commit vào `viewer/`. Không file/thư mục nào trong `viewer/` bắt đầu bằng `_`.
- Trang có `<meta name="robots" content="noindex,nofollow">`; không link từ trang chủ.
- **Không secret trong repo** (repo public). Token Worker chỉ ở Worker secret và trên thiết bị người dùng.
- Token gửi qua header `Sec-WebSocket-Protocol`, **không bao giờ trong URL/query**.
- ID/mật khẩu UltraViewer chỉ xử lý trong browser; log chẩn đoán không chứa mật khẩu, token, proof MD5.
- Worker: chỉ cổng `443`, chỉ IPv4 công khai; tối đa 2 token hợp lệ (`TOKEN_A`, `TOKEN_B`).
- TLS tới relay: SNI `ultraviewer`; kiểm tên chứng chỉ theo `functions3.ultraviewer.net` (command) hoặc `relayHostname` field 14 (data, rỗng → `functions3.ultraviewer.net`); **chấp nhận chứng chỉ hết hạn** nhưng vẫn bắt buộc chuỗi tin cậy + đúng tên.
- Trust anchors: Sectigo Public Server Authentication Root R46 (SHA-256 `7BB647A62AEEAC88BF257AA522D01FFEA395E0AB45C73F93F65654EC38F25A06`), USERTrust RSA Certification Authority, AAA Certificate Services — xuất từ `/System/Library/Keychains/SystemRootCertificates.keychain`.
- `8bit.dat`: 112.640 byte, SHA-256 `9aa45789d9ff9d329a623a685d57b67e33c777019de9ce1f273f21860e4bfe6b`, dictionary ID `0x3da0bd10`; commit vào repo (chủ repo đã chấp nhận).
- zstd: windowLogMax 27, giới hạn output 128 MiB/frame; frame mạng ≤ 16 MiB.
- Client version `6.6.133`; twips `"15"`; các trường giả lập Windows giữ nguyên như Swift.
- Không LAN direct: không gửi `DirectDetails`, không port `TCPDirectPeerTransport`.
- Danh tính client: ô "Nhớ trên thiết bị này" mặc định **không tích** → `sessionStorage`; tích → `localStorage`; nút "Quên thiết bị này" xoá hết.
- Giữ MIT notice của MacViewer + notice zstd trong `viewer-src/THIRD_PARTY_NOTICES.md` và trong bản build.
- **Không `git commit`/`git push` khi chủ repo chưa duyệt** (rule của chủ repo). Bước "Checkpoint" = `git add` + trình bày file/diff tóm tắt, chờ duyệt rồi mới commit.

## Review Focus

1. **Chứng chỉ relay đã hết hạn (thực tế hiện nay: hết hạn 2026-05-01)** → phải kết nối được; nhưng sai tên, tự ký, hoặc chuỗi không về anchor → phải từ chối. (Task 4)
2. **Người lạ gọi Worker** không token / sai token / IP private / cổng ≠ 443 / IPv6 / hostname → bị từ chối trước khi mở TCP. (Task 2)
3. **Byte TCP bị cắt/gộp tuỳ ý** qua WebSocket và bản ghi TLS (một frame chia 3 message, hoặc 3 frame trong 1 message, header HTTP bị cắt giữa CRLF) → giải khung đúng. (Task 3)
4. **Sai mật khẩu đối tác** (lookup status `2`) hoặc ID không tồn tại → hiện lỗi rõ ràng trên trang, đóng cả hai kết nối, không tự thử lại. (Task 7)
5. **Tab bị ẩn/điện thoại khoá màn hình** làm WebSocket rớt → trang báo "mất kết nối" trong ≤ 20 s, không treo im lặng. (Task 7)

---

## Cấu trúc file

```
viewer-src/
  package.json  tsconfig.json  vite.config.ts  index.html   THIRD_PARTY_NOTICES.md
  scripts/build-wasm.sh            # emscripten → src/codec/zstd.{js,wasm}
  fixtures/relay-chain.pem         # chuỗi cert relay thật (public), 3 cert
  fixtures/roots/*.pem             # 3 trust anchor
  src/
    net/pipe.ts        # WebSocket tới Worker → BytePipe
    net/dns.ts         # DoH resolve A record
    net/trust.ts       # kiểm chuỗi cert (cho phép hết hạn)
    net/tls.ts         # forge TLS client trên BytePipe → ByteChannel
    proto/frame.ts     # LengthPrefixedFrame
    proto/envelope.ts  # RelayIPv4Address, RelayEnvelope, RelayHTTPPreamble(+Decoder), RelayKeepalive
    proto/multipart.ts # MultipartPayload
    proto/crypto.ts    # LegacyCommandCipher (3DES), md5Hex
    proto/registration.ts  proto/lookup.ts  proto/login.ts
    proto/screen-message.ts  proto/screen-renderer.ts  proto/pixels.ts
    codec/zstd.ts  codec/zstd.js  codec/zstd.wasm  codec/8bit.dat
    session/identity.ts    # deviceIdentity, client password, fake IP/MAC, storage mode
    session/relay-session.ts
    spike/main.ts          # UI trang thử: form, log chẩn đoán, canvas
  worker/
    wrangler.toml  src/index.ts  src/guard.ts  test/guard.test.ts
viewer/                    # output build (commit)
```

Quy ước port: mỗi `proto/*.ts` port từ file Swift cùng tên; test `*.test.ts` đặt cạnh, port các test Swift tương ứng trong `$MV/Tests/UltraViewerProtocolTests/` **giữ nguyên vector byte**. Dùng `Uint8Array` thay `Data`, lỗi là `class XError extends Error { code: string }` với `code` = tên case Swift.

---

### Task 1: Khung dự án `viewer-src/` + build ra `viewer/`

**Files:**
- Create: `viewer-src/package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/spike/main.ts`, `THIRD_PARTY_NOTICES.md`, `test/build.test.ts`
- Create (output): `viewer/index.html`, `viewer/assets/*`

**Interfaces:**
- Produces: `npm run build` (vite → `../viewer`, `base: '/viewer/'`, `emptyOutDir: true`), `npm test` (vitest), `npm run dev`.

- [ ] **Step 1: Viết test build**

```ts
// test/build.test.ts — chạy sau `npm run build`
test('build output is Jekyll-safe and noindex', () => {
  const files = walk('../viewer');                      // đệ quy, đường dẫn tương đối
  expect(files).toContain('index.html');
  expect(files.filter(f => f.split('/').some(s => s.startsWith('_')))).toEqual([]);
  expect(read('../viewer/index.html')).toContain('<meta name="robots" content="noindex,nofollow">');
});
```

- [ ] **Step 2:** `cd viewer-src && npm i -D vite typescript vitest && npm i node-forge @types/node-forge` → `npx vitest run test/build.test.ts` → FAIL (chưa có `../viewer`).
- [ ] **Step 3:** Cấu hình Vite: `rollupOptions.output` đặt `entryFileNames/chunkFileNames/assetFileNames` dạng `assets/[name]-[hash].[ext]` và hàm `sanitizeFileName` bỏ `_` đầu tên. `index.html` có meta noindex, tiêu đề "UV Web Viewer (spike)". `THIRD_PARTY_NOTICES.md` chép MIT của MacViewer + mục zstd/8bit.dat từ `$MV/THIRD_PARTY_NOTICES.md`; Vite copy nó vào `viewer/` (thư mục `public/`).
- [ ] **Step 4:** `npm run build && npx vitest run test/build.test.ts` → PASS. Kiểm tra `git status` chỉ có `viewer/` và `viewer-src/` mới.
- [ ] **Step 5: Checkpoint** — `git add viewer-src viewer`, trình bày, chờ duyệt commit `feat(viewer): scaffold web viewer build`.

---

### Task 2: Cloudflare Worker — ống dẫn WS⇄TCP có bảo vệ

**Files:**
- Create: `viewer-src/worker/wrangler.toml`, `src/index.ts`, `src/guard.ts`, `test/guard.test.ts`, `package.json`

**Interfaces:**
- Produces (HTTP): `GET wss://<worker>/tcp?ip=<IPv4>&port=443` với header `Sec-WebSocket-Protocol: uvpipe, <token>`; server trả subprotocol `uvpipe`; message nhị phân hai chiều = byte TCP thô. Đóng WS khi TCP đóng và ngược lại. Mã đóng: `4401` token sai, `4403` đích bị cấm, `4429` quá số kết nối, `4502` connect TCP lỗi.
- Produces (code): `parseTarget(ip: string|null, port: string|null): {ip: string, port: 443} | null`; `isPublicIPv4(ip: string): boolean`; `tokenFromProtocols(header: string|null): string|null`; `tokenValid(token: string, env: {TOKEN_A?: string, TOKEN_B?: string}): Promise<boolean>` (so sánh constant-time trên SHA-256 của hai chuỗi).

- [ ] **Step 1: Test guard**

```ts
test.each(['10.0.0.1','172.16.5.4','192.168.1.1','127.0.0.1','169.254.1.1','100.64.0.1','0.1.2.3','224.0.0.1','255.255.255.255','::1','functions3.ultraviewer.net','1.2.3','1.2.3.256'])
  ('rejects %s', ip => expect(parseTarget(ip, '443')).toBeNull());
test('accepts relay IP on 443', () => expect(parseTarget('146.59.55.107','443')).toEqual({ip:'146.59.55.107', port:443}));
test('rejects other ports', () => { expect(parseTarget('146.59.55.107','80')).toBeNull(); expect(parseTarget('146.59.55.107',null)).toBeNull(); });
test('token parsing', () => { expect(tokenFromProtocols('uvpipe, abc')).toBe('abc'); expect(tokenFromProtocols('abc')).toBeNull(); expect(tokenFromProtocols(null)).toBeNull(); });
test('token check uses either secret, rejects empty', async () => {
  const env = { TOKEN_A: 'a'.repeat(32), TOKEN_B: 'b'.repeat(32) };
  expect(await tokenValid('a'.repeat(32), env)).toBe(true);
  expect(await tokenValid('b'.repeat(32), env)).toBe(true);
  expect(await tokenValid('c'.repeat(32), env)).toBe(false);
  expect(await tokenValid('', { TOKEN_A: '' })).toBe(false);
});
```

- [ ] **Step 2:** `npx vitest run` → FAIL.
- [ ] **Step 3:** Cài `guard.ts`; `index.ts` dùng `connect({hostname: ip, port: 443})` từ `cloudflare:sockets`, `WebSocketPair`, bơm byte hai chiều không đọc nội dung; giới hạn 4 kết nối đồng thời mỗi token bằng một Durable Object đếm (hoặc bỏ giới hạn ở spike và ghi lại — chọn Durable Object nếu gói free cho phép, nếu không thì ghi chú trong log task). Không `console.log` nội dung hay token.
- [ ] **Step 4:** `npx vitest run` → PASS. `npx wrangler dev` + `websocat`/script node gửi sai token → nhận đóng `4401`; IP `192.168.1.1` → `4403`.
- [ ] **Step 5 (cùng chủ repo):** chủ repo chạy `npx wrangler login` trên trình duyệt; sinh token 32 byte ngẫu nhiên (`openssl rand -hex 32` — chỉ ký tự hex; base64 có `/`, `+`, `=` không hợp lệ trong subprotocol), `wrangler secret put TOKEN_A`; `wrangler deploy`. Ghi URL `*.workers.dev` vào `viewer-src/src/config.ts` (`WORKER_URL`, không phải secret). Token đưa cho chủ repo, **không ghi vào repo**.
- [ ] **Step 6: Checkpoint** — `git add viewer-src/worker viewer-src/src/config.ts`, chờ duyệt commit `feat(viewer): websocket-to-tcp worker pipe`.

---

### Task 3: Khung byte — frame, envelope, preamble, multipart

**Files:**
- Create: `src/proto/frame.ts`, `src/proto/envelope.ts`, `src/proto/multipart.ts` + `*.test.ts`
- Port từ: `$MV/Sources/UltraViewerProtocol/{LengthPrefixedFrame,RelayEnvelope,MultipartPayload}.swift`; test từ `FrameTests.swift`, `RelayEnvelopeTests.swift`, `MultipartPayloadTests.swift`.

**Interfaces:**
- Produces:
  - `encodeFrame(payload: Uint8Array): Uint8Array`; `class FrameDecoder { constructor(maxPayload = 16*1024*1024); push(chunk: Uint8Array): Uint8Array[] }`
  - `parseIPv4(s: string): Uint8Array /*4 byte*/`; `type RelayEnvelope = {kind:'forward', address: string, port: number, formatFlag: boolean, payload: Uint8Array} | {kind:'system', formatFlag: boolean|null, payload: Uint8Array}`; `encodeEnvelope(e): Uint8Array`; `encodeSystem(payload, formatFlag?: boolean|null): Uint8Array`; `decodeEnvelope(b): RelayEnvelope`; `keepaliveCommandEnvelope(): Uint8Array` (nội dung theo `RelayKeepalive`).
  - `httpPreamble(host: string, method: 'POST'|'GET' = 'POST'): Uint8Array`; `class PreambleDecoder { constructor(maxHeader = 32768); push(chunk): Uint8Array /*byte sau CRLFCRLF, rỗng nếu chưa hết header*/ }`
  - `encodeMultipart(parts: Uint8Array[]): Uint8Array`; `decodeMultipart(payload: Uint8Array): Uint8Array[]`

- [ ] **Step 1:** Port toàn bộ test Swift ba file trên sang Vitest, giữ nguyên byte. Thêm test Review Focus 3:

```ts
test('frame decoder handles arbitrary splits and coalescing', () => {
  const frames = [new Uint8Array([1]), new Uint8Array(70000).fill(7), new Uint8Array(0)];
  const wire = concat(...frames.map(encodeFrame));
  for (const cuts of [[1],[3,4,5],[70001],[wire.length-1]]) {
    const d = new FrameDecoder(); const out = splitAt(wire, cuts).flatMap(c => d.push(c));
    expect(out).toEqual(frames);
  }
});
test('preamble decoder returns body bytes even if CRLFCRLF is split', () => {
  const d = new PreambleDecoder();
  expect(d.push(enc('HTTP/1.1 200 OK\r\nX: y\r'))).toEqual(new Uint8Array());
  expect(d.push(enc('\n\r\nABC'))).toEqual(enc('ABC'));
  expect(d.push(enc('D'))).toEqual(enc('D'));
});
test('frame over 16 MiB throws payloadTooLarge', () => { /* header 0x01000001 LE */ });
```

- [ ] **Step 2:** `npx vitest run src/proto` → FAIL.
- [ ] **Step 3:** Port ba file Swift (hành vi y hệt, kể cả mã lỗi và giới hạn).
- [ ] **Step 4:** `npx vitest run src/proto` → PASS.
- [ ] **Step 5: Checkpoint** — chờ duyệt commit `feat(viewer): relay framing primitives`.

---

### Task 4: Mạng — DNS, ống WS, kiểm chứng chỉ, TLS (forge)

**Files:**
- Create: `src/net/dns.ts`, `src/net/pipe.ts`, `src/net/trust.ts`, `src/net/tls.ts`, `src/net/trust.test.ts`, `fixtures/relay-chain.pem`, `fixtures/roots/{sectigo-r46,usertrust-rsa,aaa-certificate-services}.pem`
- Nguồn chuỗi cert: `scratchpad/relay-chain.pem` (đã lấy từ `146.59.55.107:443`, 3 cert; leaf `CN=*.ultraviewer.net`, hết hạn 2026-05-01).

**Interfaces:**
- Produces:
  - `resolveIPv4(host: string): Promise<string[]>` — DoH `https://cloudflare-dns.com/dns-query?name=<host>&type=A` header `accept: application/dns-json`; trả các bản ghi `type 1`.
  - `interface BytePipe { send(b: Uint8Array): void; onData(cb: (b: Uint8Array) => void): void; onClose(cb: (reason: string) => void): void; close(): void }`
  - `openPipe(o: {workerUrl: string, token: string, ip: string, port: 443}): Promise<BytePipe>` — `new WebSocket(url, ['uvpipe', token])`, `binaryType='arraybuffer'`; reject khi đóng trước `open` (kèm mã đóng 44xx).
  - `type ChainCheck = {ok: true, expired: boolean} | {ok: false, reason: 'untrusted'|'name'|'parse'}`
  - `checkServerChain(chainDer: Uint8Array[], certName: string, now: Date): ChainCheck`
  - `interface ByteChannel extends BytePipe {}`; `openTls(pipe: BytePipe, o: {sni: 'ultraviewer', certName: string, now?: () => Date}): Promise<ByteChannel>` — `forge.tls.createConnection({server:false, virtualHost: sni, verify, ...})`; `verify` gọi `checkServerChain` và **bỏ qua lỗi hết hạn của forge**, mọi lỗi khác → từ chối.

- [ ] **Step 1: Test trust (Review Focus 1)**

```ts
const chain = pemChain('fixtures/relay-chain.pem');
test('accepts the real, expired relay chain for its name', () =>
  expect(checkServerChain(chain, 'functions3.ultraviewer.net', new Date('2026-10-20'))).toEqual({ok:true, expired:true}));
test('accepts bare domain from SAN', () =>
  expect(checkServerChain(chain, 'ultraviewer.net', new Date('2026-10-20')).ok).toBe(true));
test('rejects wrong name', () =>
  expect(checkServerChain(chain, 'evil.example.com', new Date('2026-10-20'))).toEqual({ok:false, reason:'name'}));
test('wildcard does not match two labels', () =>
  expect(checkServerChain(chain, 'a.b.ultraviewer.net', new Date())).toEqual({ok:false, reason:'name'}));
test('rejects chain without its intermediates', () =>
  expect(checkServerChain([chain[0]], 'functions3.ultraviewer.net', new Date())).toEqual({ok:false, reason:'untrusted'}));
test('rejects self-signed leaf', () =>
  expect(checkServerChain([selfSignedFor('*.ultraviewer.net')], 'functions3.ultraviewer.net', new Date()).ok).toBe(false));
```

- [ ] **Step 2:** `npx vitest run src/net` → FAIL.
- [ ] **Step 3:** Xuất 3 root từ keychain hệ thống (`security find-certificate -a -c "<CN>" -p /System/Library/Keychains/SystemRootCertificates.keychain`), kiểm fingerprint R46 khớp Global Constraints. Cài `trust.ts`: dựng chuỗi leaf→…→anchor bằng kiểm chữ ký forge (`issuer.verify(child)`), kiểm `notBefore/notAfter` chỉ để báo `expired`, tên khớp theo SAN DNS (wildcard một nhãn). Cài `dns.ts`, `pipe.ts`, `tls.ts`.
- [ ] **Step 4:** `npx vitest run src/net` → PASS.
- [ ] **Step 5 (thử sống, trong spike page tạm):** nút "Thử TLS command" → resolve `functions3.ultraviewer.net` → `openPipe` → `openTls(certName:'functions3.ultraviewer.net')` → gửi `httpPreamble('functions3.ultraviewer.net')` → log "TLS OK (cert expired: true), HTTP header received". Chạy `npm run dev` trên localhost.
- [ ] **Step 6: Checkpoint** — chờ duyệt commit `feat(viewer): in-browser TLS to relay through worker`.

---

### Task 5: Mật mã lệnh + đăng ký + tra ID + đăng nhập (encoder/parser)

**Files:**
- Create: `src/proto/crypto.ts`, `src/proto/registration.ts`, `src/proto/lookup.ts`, `src/proto/login.ts` + `*.test.ts`; `src/session/identity.ts` + test
- Port từ: `LegacyCommandCipher.swift`, `ClientRegistration.swift`, `PeerLookup.swift`, `PartnerLoginMessage.swift`; test từ các file `*Tests.swift` cùng tên. Trường mặc định của registration lấy theo `$MV/Sources/MacViewer/MacRegistrationProfile.swift:96-134,201-211`.

**Interfaces:**
- Produces:
  - `md5Hex(s: string): string` (uppercase/lowercase đúng như Swift dùng); `commandCipher: {encrypt(b: Uint8Array): Uint8Array, decrypt(b: Uint8Array): Uint8Array}` (= `.desktopServerCommands`, 3DES-EDE3-CBC/PKCS7 bằng `forge.cipher.createCipher('3DES-CBC', …)`).
  - `type RegistrationRequest` (mọi trường của `ClientRegistration.Request`); `registrationText(r): string`; `registrationEnvelope(r): Uint8Array`; `parseRegistrationReply(plain: Uint8Array): {assignedIDText: string, …}`.
  - `type LookupRequest`; `lookupText(r): string`; `parseLookupReply(plain): {status: number, correlationNumber: number, peerInfo(): PeerInfo|null}`; `type PeerInfo = {publicIP: string, targetTCPPort: number, relayIP: string, relayHostname: string, partnerSecretToken: string|null, computerNameField: string, …}`.
  - `loginText(cred: {password: string, nonce: string}, ctx: LoginContext): string`.
  - `type ClientIdentity = {deviceIdentity: string /*32 HEX*/, password: string /*8 digits*/, localAddress: string, macAddress: string}`; `loadIdentity(): ClientIdentity|null`; `createIdentity(): ClientIdentity`; `saveIdentity(id, remember: boolean): void`; `forgetDevice(): void`.

- [ ] **Step 1:** Port test Swift của 4 file (giữ vector). Thêm:

```ts
test('identity: fake but well-formed and stable per storage', () => {
  const id = createIdentity();
  expect(id.deviceIdentity).toMatch(/^[0-9A-F]{32}$/);
  expect(id.password).toMatch(/^\d{8}$/);
  expect(id.localAddress).toMatch(/^192\.168\.1\.(\d+)$/);          // octet cuối 2..254
  expect(parseInt(id.macAddress.split(':')[0], 16) & 0b11).toBe(0b10); // unicast, locally administered
});
test('remember=false keeps identity in sessionStorage only', () => {
  saveIdentity(createIdentity(), false);
  expect(localStorage.length).toBe(0); expect(loadIdentity()).not.toBeNull();
});
test('forgetDevice clears both storages', () => { saveIdentity(createIdentity(), true); forgetDevice(); expect(loadIdentity()).toBeNull(); });
```

- [ ] **Step 2:** `npx vitest run src/proto src/session` → FAIL (môi trường `jsdom` cho storage).
- [ ] **Step 3:** Port 4 file Swift + cài `identity.ts` (khoá storage `uvweb.identity`). `localScreenWidth/Height` lấy `screen.width*devicePixelRatio`, `screen.height*devicePixelRatio` (làm tròn) — truyền vào ở Task 7, không đọc trong `login.ts`.
- [ ] **Step 4:** `npx vitest run` → PASS.
- [ ] **Step 5: Checkpoint** — chờ duyệt commit `feat(viewer): registration, lookup and login messages`.

---

### Task 6: Giải mã màn hình — zstd WASM + renderer

**Files:**
- Create: `viewer-src/scripts/build-wasm.sh`, `src/codec/zstd.ts`, `src/codec/zstd.js`, `src/codec/zstd.wasm`, `src/codec/8bit.dat`, `src/proto/screen-message.ts`, `src/proto/screen-renderer.ts`, `src/proto/pixels.ts` + `*.test.ts`
- Port từ: `ZstdScreenDecoder.swift`, `ModernScreenMessage.swift`, `ModernScreenRenderer.swift`, `ScreenPixelStorage.swift`, `ScreenRectangleBuffer.swift`, `UltraViewerScreenDictionary.swift`; test từ `ZstdScreenDecoderTests`, `ModernScreenTests`, `ScreenPixelStorageTests`, `ScreenRectangleTests`.

**Interfaces:**
- Produces:
  - `build-wasm.sh`: `emcc` biên dịch `$MV/ThirdParty/zstd` (chỉ phần decompress + dictBuilder không cần) với cờ như `Package.swift` (`ZSTD_LEGACY_SUPPORT=4`), export `ZSTD_createDStream, ZSTD_initDStream, ZSTD_DCtx_loadDictionary, ZSTD_DCtx_setParameter, ZSTD_DCtx_reset, ZSTD_decompressStream, ZSTD_isError, ZSTD_getErrorName, ZSTD_freeDStream, malloc, free`; `-sMODULARIZE -sEXPORT_ES6 -sALLOW_MEMORY_GROWTH -sMAXIMUM_MEMORY=512MB`; output `src/codec/zstd.{js,wasm}` (commit).
  - `class ZstdScreenDecoder { static create(dict: Uint8Array, maxOut = 128*1024*1024): Promise<ZstdScreenDecoder>; reset(): void; append(c: Uint8Array): Uint8Array; finish(): void; get hasIncompleteFrame(): boolean }`
  - `loadScreenDictionary(): Promise<Uint8Array>` — fetch `8bit.dat`, kiểm SHA-256 bằng WebCrypto, sai → throw `unexpectedResource`.
  - `decodeInitialization(parts: Uint8Array[]): ModernScreenInitialization`; `decodeFrameMessage(parts): ModernScreenFrameMessage`; `class ModernScreenRenderer { static create(o: {width, height, tileSize, displayColors: 2, lastFrameNumber, dictionary}): Promise<ModernScreenRenderer>; apply(m): ScreenBitmap }`; `type ScreenBitmap = {width: number, height: number, rgba: Uint8ClampedArray /*sẵn cho ImageData*/}`.
  - JPEG tile: `createImageBitmap(new Blob([bytes], {type:'image/jpeg'}))` vẽ lên `OffscreenCanvas` rồi đọc pixel → `apply` là `async` nếu cần (`apply(m): Promise<ScreenBitmap>`).

- [ ] **Step 1:** `brew install emscripten` (chỉ máy dev). Port test Swift 4 file trên. Thêm: `loadScreenDictionary` với file sai 1 byte → throw; `ZstdScreenDecoder` từ chối frame có window > 2^27.
- [ ] **Step 2:** `npx vitest run src/codec src/proto/screen*` → FAIL.
- [ ] **Step 3:** Viết `build-wasm.sh`, chạy, port các file Swift. Copy `$MV/Sources/UltraViewerProtocol/Resources/8bit.dat` → `src/codec/8bit.dat`.
- [ ] **Step 4:** `npx vitest run` → PASS; `npm run build` vẫn qua test Task 1 (tên file `.wasm`/`.dat` không bắt đầu bằng `_`).
- [ ] **Step 5: Checkpoint** — chờ duyệt commit `feat(viewer): screen decoder with zstd wasm`.

---

### Task 7: Phiên relay + trang thử chẩn đoán → frame đầu tiên

**Files:**
- Create: `src/session/relay-session.ts`, `src/session/relay-session.test.ts`, `src/spike/main.ts`, `index.html` (form + log + canvas)
- Port từ: `UltraViewerRelaySession.swift` các đoạn `begin` (299-321), `consumeCommand` (323-364), `beginPeer` (576-604), `login` (606-636), `consumePeer`/`consumeApplication` nhánh `case 0` và `case 1` (638-830), `sendToPeer` (861-874), `armDeadline` (876-885), `sendHeartbeat` (887-920). **Bỏ** mọi nhánh LAN direct, file, chat, clipboard, audio, cursor (để giai đoạn sau; message lạ → log `ignored <id>`).

**Interfaces:**
- Consumes: Task 3 (frame/envelope/multipart), Task 4 (`resolveIPv4`, `openPipe`, `openTls`), Task 5 (messages, `commandCipher`, identity), Task 6 (`ModernScreenRenderer`, `loadScreenDictionary`).
- Produces:
  - `type SessionEvent = {type:'status', text:string} | {type:'accepted', peer: Peer} | {type:'frame', bitmap: ScreenBitmap} | {type:'closed', reason: SessionFailure|null}`
  - `type SessionFailure = 'wrongPassword'|'lookupRejected'|'invalidLookupRoute'|'unsupportedVersion'|'deadline'|'transportClosed'|'tls'|'workerRefused'`
  - `class RelaySession { constructor(deps: {openChannel(ip: string, certName: string): Promise<ByteChannel>, resolve(host: string): Promise<string[]>, now(): number}); connect(o: {identity: ClientIdentity, partnerID: string, password: string, screenW: number, screenH: number, displayName: string}, on: (e: SessionEvent) => void): void; close(): void }`
  - Pha: `registering → lookup → login → active → closed`; deadline handshake 20 s mỗi pha; heartbeat relay `ping` + peer `"20"` mỗi 10 s; command `"2"` (mã hoá) mỗi 60 s; mỗi frame giải xong gửi `"18"`; sau init gửi `"17"`.

- [ ] **Step 1: Test phiên với kênh giả** (deps.openChannel trả cặp ByteChannel in-memory; server giả phát lại reply `3:`/`8:` dựng từ test vector Task 5):

```ts
test('happy path reaches active and acks frames', async () => { /* … expect events: status×n, accepted, frame; expect peer channel received "17" then "18" */ });
test('lookup status 2 → closed(wrongPassword), both channels closed, no reconnect', async () => {
  /* Review Focus 4 */ expect(last(events)).toEqual({type:'closed', reason:'wrongPassword'});
  expect(fake.command.closed && fake.peer?.closed !== false).toBe(true); expect(fake.openCount).toBe(1);
});
test('no reply within 20 s → closed(deadline)', async () => { vi.useFakeTimers(); /* advance 20_001 */ });
test('peer channel drops while active → closed(transportClosed) within 1 tick', async () => { /* Review Focus 5 */ });
test('ignores lookup reply with foreign correlation number', async () => { /* như Swift */ });
```

- [ ] **Step 2:** `npx vitest run src/session` → FAIL.
- [ ] **Step 3:** Port state machine. `spike/main.ts`: form (Worker token + ô "Nhớ trên thiết bị này", ID đối tác, mật khẩu, nút "Quên thiết bị này"), bảng log chẩn đoán từng bước (DNS, WS, TLS + `expired`, đăng ký → ID được cấp, lookup status, relay IP, login gửi, init width×height + version, số frame, ms giải mã trung bình), canvas vẽ `ImageData` frame mới nhất, bộ đếm thời gian phiên. Lắng nghe `visibilitychange`/`pagehide` để log. **Không** log mật khẩu/token/proof.
- [ ] **Step 4:** `npx vitest run` → PASS; `npm run build` → test Task 1 PASS.
- [ ] **Step 5: Checkpoint** — chờ duyệt commit `feat(viewer): relay session and spike page`.

---

### Task 8: Chạy go/no-go cùng chủ repo và ghi kết quả

**Files:**
- Create: `docs/superpowers/specs/2026-10-20-ultraviewer-web-viewer-phase0-result.md`

- [ ] **Step 1 (localhost):** `npm run dev`; chủ repo mở trang, nhập token, **tự gõ** ID + mật khẩu máy Windows (đang mở UltraViewer, ghi phiên bản UltraViewer từ Help/About). Tiêu chí: log đi hết tới "frame đầu tiên", canvas hiện đúng màn hình Windows.
- [ ] **Step 2 (Pages):** sau khi chủ repo duyệt commit + push (`master`), mở `https://tranhuongk.github.io/viewer/` trên **điện thoại** (4G, không Wi-Fi nhà) và lặp lại Step 1.
- [ ] **Step 3 (phiên dài):** để phiên trên desktop chạy ≥ 30 phút, cho màn hình Windows thay đổi liên tục (ví dụ phát video); ghi: có rớt không, thời điểm rớt, mã đóng WS, `wrangler tail` (chỉ mã lỗi, không nội dung), CPU-time/limit từ dashboard Workers.
- [ ] **Step 4:** Ghi file kết quả: GO/NO-GO cho từng tiêu chí (frame đầu localhost, frame đầu điện thoại, phiên 30 phút), phiên bản UltraViewer trên Windows, số liệu đo, vấn đề còn lại. NO-GO → đề xuất phương án (Workers Paid / ống dẫn trên VPS hoặc Mac) cho chủ repo chọn.
- [ ] **Step 5: Checkpoint** — chờ duyệt commit `docs(viewer): phase 0 go/no-go result`.

---

## Quyết định trong kế hoạch (Claude tự chọn, chủ repo xem lại)

- **TLS bằng node-forge (TLS 1.1, `TLS_RSA_WITH_AES_256_CBC_SHA`)**: đã thử relay chấp nhận tổ hợp này (2026-10-20). Không có forward secrecy; đặt sau interface `openTls` để giai đoạn sau thay bằng TLS 1.2 ECDHE (rustls/mbedTLS WASM) mà không đổi code giao thức.
- **zstd tự biên dịch bằng emscripten** từ mã C trong MacViewer, vì gói npm sẵn có (`@bokuweb/zstd-wasm`) không có API giải nén luồng + dictionary.
- **Trust anchors chỉ họ Sectigo/USERTrust/AAA** (relay dùng Sectigo) thay vì cả bộ Mozilla — nhẹ hơn; đổi relay sang CA khác thì phải thêm root.
- IP giả `192.168.1.x`, MAC giả locally-administered; không gửi `DirectDetails`.
- Token trong `Sec-WebSocket-Protocol`, không trong URL.
