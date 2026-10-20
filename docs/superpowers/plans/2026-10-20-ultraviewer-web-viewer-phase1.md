# UltraViewer Web Viewer — Giai đoạn 1 (xem + điều khiển) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Từ trang `viewer/`, điều khiển được máy Windows qua UltraViewer: chuột, bàn phím (kể cả gõ tiếng Việt), cảm ứng trên điện thoại/iPad, chọn monitor, scale, chất lượng, tắt wallpaper, con trỏ từ xa, Ctrl+Alt+Del và các phím đặc biệt.

**Architecture:** Port 1-1 các bản tin input của MacViewer (`MouseMessage`, `KeyboardMessage`, `RemoteControlCommands`, `CursorMessage`) sang `src/proto/`; mở rộng `RelaySession` với API gửi input/lệnh và các sự kiện quyền điều khiển, con trỏ; viết bộ mã hoá input của trình duyệt (`KeyboardEvent.code` → VK/scan, Pointer Events → bản tin chuột, composition/beforeinput → `VK_PACKET`) và giao diện viewer thay cho trang spike.

**Tech Stack:** TypeScript 5, Vite, Vitest, Pointer Events, KeyboardEvent/CompositionEvent/InputEvent, Fullscreen + Keyboard Lock API (khi có).

**Spec:** `docs/superpowers/specs/2026-10-20-ultraviewer-web-viewer-design.md` (mục 2 — nhóm Màn hình, Điều khiển, Cảm ứng, Gõ tiếng Việt). Giai đoạn 0 đã GO trên localhost (ledger `.superpowers/sdd/2026-10-20-ultraviewer-web-viewer-phase0/progress.md`).

**Nguồn port:** `$MV` như giai đoạn 0 (MacViewer `v0.3.21`, `237c446`). P = `Sources/UltraViewerProtocol`, M = `Sources/MacViewer`, TP = `Tests/UltraViewerProtocolTests`, TM = `Tests/MacViewerTests`.

## Global Constraints

- Mọi ràng buộc chung của giai đoạn 0 vẫn áp dụng (repo/branch `feature/uv-web-viewer`, không push, không `.nojekyll`, không `_` trong `viewer/`, noindex, không secret, token chỉ ở `Sec-WebSocket-Protocol`, log không chứa mật khẩu/token/proof, port giữ nguyên vector byte Swift, lỗi `XError{code}` theo tên case Swift).
- Chuột: text ASCII `8|||…` với `formatFlag=false`; nút chỉ gửi down/up (0x201/0x202, 0x204/0x205, 0x207/0x208), **không** gửi double-click; nhấn nút luôn gửi move trước; wParam cờ 0x01 trái, 0x02 phải, 0x10 giữa, 0x04 shift, 0x08 control; lParam = Int16 x thấp | Int16 y cao; wheel chỉ dọc, `wheelWParam = flags | Int16(delta) << 16`, 1 nấc = 120, tích luỹ phần lẻ, kẹp ±256 nấc/sự kiện.
- Toạ độ gửi = pixel trên canvas đã giải mã (kẹp `[0, w-1]`, `[0, h-1]`) + vùng crop của monitor đang chọn + `virtualLeft/virtualTop` (init part 9/10).
- Bàn phím: gói nhị phân 11 byte `[30, 0x7c,0x7c,0x7c, kind, vk, scanLE16, utf16LE, caps]`, `formatFlag=false`; kind 1/2 thường, 3/4 khi Alt đang giữ (và cho chính phím Alt); chỉ gửi khi peer ≥ 6.2.13 (`supportsBinaryKeyboard`), ngược lại tắt điều khiển phím và báo trên UI.
- Ánh xạ phím bổ trợ: Meta/⌘ → LWIN 0x5b/RWIN 0x5c (scan 0xe05b/0xe05c); Alt/⌥ → 0xa4/0xa5 (0x38/0xe038, kind 3/4); Ctrl → 0xa2/0xa3 (0x1d/0xe01d); Shift → 0xa0/0xa1 (0x2a/0x36).
- `character` của gói phím: chỉ đặt cho ký tự ASCII in được hoặc Enter 13, Tab 9, Backspace 8, Esc 27 khi không giữ Ctrl/Alt/Meta; ngược lại 0.
- Văn bản (IME, tiếng Việt, bàn phím ảo): mỗi đơn vị UTF-16 → cặp down/up với VK_PACKET 0xe7, scan 0, `character` = đơn vị đó; bỏ đơn vị < 0x20 và surrogate.
- Lệnh: Ctrl+Alt+Del = unicode `"22"` (`formatFlag=true`, UTF-16LE), Restart `"40"`, Lock `"53"`; chất lượng gửi `[32|||2, 31|||q]` (ascii) với preset tự động 45 / tốc độ 30 / chất lượng 70; wallpaper unicode `23|||-1` hiện / `23|||0` ẩn; con trỏ ascii `28|||1` bật (gửi ngay sau `accepted`); hỏi hình con trỏ ascii `4|||<hash>`.
- Quyền điều khiển: lệnh host 49 `[49][flag]` (1 = chỉ xem, 0 = cho điều khiển) chỉ xử lý ở pha active; khi mất quyền → `releaseAll` rồi khoá input. Nút "Điều khiển" là bật/tắt **cục bộ**, không gửi gì.
- Lệnh host 23 khi active → login lại `controlMode -1, clear false` (Swift RS:828-832).
- Chọn monitor **không gửi lệnh**: chỉ crop cục bộ theo bản ghi monitor init part 8 (`left:top:right:bottom|`, đánh số từ 1, 0 = tất cả); đổi monitor → `releaseAll` trước.
- Con trỏ từ xa: lệnh 3 (chọn hash), 4 (hình .CUR, zstd không dictionary), 28 (vị trí Int16 x,y theo toạ độ desktop ảo); bỏ qua hash 0xb84d1a70; cache LRU ≤ 64 hình, ≤ 16 MiB; vẽ lớp phủ tại `vị trí − hotspot − virtual − crop`, scale theo khung ảnh; không đổi con trỏ thật của trình duyệt khi không điều khiển.
- Giới hạn hàng đợi input: ≤ 8192 phần tử; tràn → `releaseAll` + tắt điều khiển + báo lỗi; gộp move liền kề còn chờ gửi.
- Trình duyệt mục tiêu: Chrome/Edge/Safari desktop, Safari iOS/iPadOS, Chrome Android.
- Chuỗi giao diện tiếng Việt.

## Review Focus

1. **Phím bị kẹt ở Windows** khi tab mất focus, đổi monitor, mất quyền (49), ngắt kết nối, hoặc người dùng thả phím ngoài trang (`blur`/`visibilitychange`) → luôn gửi `releaseAll` (phím thường, rồi nút chuột, rồi phím bổ trợ, theo thứ tự ngược). (Task 3, Task 4)
2. **Gõ tiếng Việt bằng Telex/VNI của macOS hoặc bàn phím iOS/Android** → Windows nhận đúng chữ có dấu, không gửi thêm ký tự thô của phím vật lý trong lúc đang composition (`isComposing`, `key === 'Process'`, keyCode 229). (Task 3, Task 5)
3. **Toạ độ sai khi canvas bị scale, letterbox, crop monitor, hoặc màn hình ảo có toạ độ âm** (monitor bên trái màn chính) → click đúng điểm. (Task 3, Task 4)
4. **Phím tắt của trình duyệt/hệ điều hành** (⌘W, ⌘Q, ⌘T, Ctrl+W, Backspace điều hướng, F5) khi đang điều khiển → không đóng/thoát trang; các tổ hợp trình duyệt không cho bắt được thì có nút thay thế. (Task 4)
5. **Peer < 6.2.13 hoặc chế độ chỉ xem** → không gửi gói phím, UI báo rõ, chuột vẫn theo quyền 49. (Task 2, Task 4)

---

## Cấu trúc file

```
viewer-src/src/
  proto/mouse.ts  proto/keyboard.ts  proto/commands.ts  proto/cursor.ts      (+ *.test.ts)
  input/keymap.ts        # KeyboardEvent.code → {vk, scan}
  input/encoder.ts       # trạng thái giữ phím/nút, releaseAll, wheel accumulator, text → VK_PACKET
  input/queue.ts         # hàng đợi gửi, gộp move, giới hạn 8192
  input/geometry.ts      # client point → remote point (fit/100%, crop, virtual offset)
  viewer/main.ts         # trang viewer (thay spike/main.ts làm entry)
  viewer/toolbar.ts  viewer/cursor-layer.ts  viewer/touch.ts  viewer/ime.ts  viewer/cur-decode.ts
  session/relay-session.ts  (sửa)
```

`spike/` được giữ lại dưới dạng mục "Diagnostics" của trang viewer (log, probe); entry chính đổi sang `viewer/main.ts`.

---

### Task 1: Bản tin input và lệnh điều khiển (port thuần)

**Files:** Create `src/proto/{mouse,keyboard,commands,cursor}.ts` + test. Port từ `P/{MouseMessage,KeyboardMessage,RemoteControlCommands,CursorMessage}.swift`; test từ `TP/{MouseMessageTests,KeyboardMessageTests,RemoteControlCommandsTests,CursorMessageTests}.swift` giữ nguyên vector.

**Interfaces — Produces:**
- `mouseMoveText(wParam: number, x: number, y: number): string`; `mouseButtonText(msg: MouseButtonMessage, wParam: number, lParam: number): string`; `mouseWheelText(wParam: number, lParam: number): string`; `packedPosition(x: number, y: number): number`; `wheelWParam(delta: number, flags: number): number`; `enum MouseButtonMessage { LeftDown=0x201, LeftUp=0x202, RightDown=0x204, RightUp=0x205, MiddleDown=0x207, MiddleUp=0x208 }` (+ 0x203/0x206/0x209 chỉ để validate như Swift).
- `keyboardPacket(k: {kind: 1|2|3|4, vk: number, scan: number, character: number, capsLock: boolean}): Uint8Array` (11 byte).
- `commandPayload(c: RemoteCommand): {bytes: Uint8Array, formatFlag: boolean}[]` với `type RemoteCommand = {type:'action', action:'ctrlAltDel'|'restart'|'lock'} | {type:'quality', preset:'auto'|'speed'|'quality'} | {type:'wallpaper', visible:boolean} | {type:'cursorPositions', enabled:boolean} | {type:'computerSound', enabled:boolean} | {type:'endSession'}`.
- `type RemoteMonitor = {index: number, left: number, top: number, right: number, bottom: number}`; `parseMonitors(bytes: Uint8Array): RemoteMonitor[]`; `monitorRegion(m: RemoteMonitor, virtualLeft: number, virtualTop: number, width: number, height: number): {x,y,w,h}` (throw như Swift khi ngoài biên).
- `type CursorEvent = {type:'select', hash: number} | {type:'shape', hash: number, cur: Uint8Array} | {type:'position', x: number, y: number}`; `decodeCursorMessage(parts: Uint8Array[], zstd: (b: Uint8Array, expected: number) => Uint8Array): CursorEvent | null` (null cho hash bị bỏ qua); `cursorShapeRequest(hash: number): Uint8Array`.

- [ ] Step 1: port toàn bộ test Swift 4 file (bỏ phần side-switch của RemoteControlCommandsTests — ngoài phạm vi), chạy `npx vitest run src/proto` → FAIL.
- [ ] Step 2: port 4 file Swift; zstd con trỏ dùng `ZstdScreenDecoder` không dictionary (Task 6 giai đoạn 0) qua tham số `zstd`.
- [ ] Step 3: `npx vitest run src/proto`, `npm test`, `npx tsc --noEmit` → PASS. Commit `feat(viewer): input, command and cursor messages`.

---

### Task 2: RelaySession — gửi input/lệnh, quyền điều khiển, con trỏ, login lại

**Files:** Modify `src/session/relay-session.ts`, `relay-session.test.ts`. Port từ `P/UltraViewerRelaySession.swift` :217-292 (send/sendCommand/refresh), :716-718 (3/4/28), :828-853 (23, 49).

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `send(bytes: Uint8Array, formatFlag?: boolean): Promise<void>` (chỉ pha active; ngược lại reject `notConnected`).
  - `sendCommand(c: RemoteCommand, opts: {requiresControl: boolean}): Promise<void>` (reject `viewOnly` khi `requiresControl` và đang chỉ xem; wallpaper và action cần control).
  - `refreshScreen(): Promise<void>` (login lại `clear true`, phát `inputPermission(false)` trước như Swift).
  - Sự kiện mới trong `SessionEvent`: `{type:'inputPermission', allowed: boolean}`, `{type:'cursor', event: CursorEvent}`; `Peer` thêm `supportsBinaryKeyboard: boolean`, `allowsRemoteInput: boolean`, `monitors: RemoteMonitor[]`, `virtualLeft: number`, `virtualTop: number`.
  - Sau `accepted`: tự gửi `28|||1`. Lệnh 4 với hash chưa có trong cache của UI: UI gọi `send(cursorShapeRequest(hash))`.
  - Lệnh 23 khi active → `login(-1, false)`; lệnh 26 vẫn chỉ log (không retarget).
- [ ] Step 1: test với kênh giả: (a) 49 flag 1 → `inputPermission(false)`, flag 0 → true, 49 trước active → bỏ qua; (b) `sendCommand(ctrlAltDel)` khi view-only → reject `viewOnly`, khi được phép → peer nhận envelope `formatFlag=true` payload UTF-16LE "22"; (c) sau accepted peer nhận `28|||1`; (d) 3/4/28 → sự kiện `cursor` đúng; (e) 23 khi active → peer nhận login mới với field 13 = `-1`; (f) `send` trước active → reject `notConnected`. → FAIL.
- [ ] Step 2: cài đặt; xoá 3/4/28/23/49 khỏi danh sách "ignored".
- [ ] Step 3: test xanh, `npm test`, `tsc`. Commit `feat(viewer): session control API, input permission and cursor events`.

---

### Task 3: Bộ mã hoá input của trình duyệt (thuần, không DOM)

**Files:** Create `src/input/{keymap,encoder,queue,geometry}.ts` + test. Port từ `M/MacRemoteInputEncoder.swift` (logic trạng thái), `M/RemoteInputBuffer.swift`, `M/RemoteScroll.swift`; test từ `TM/{MacRemoteInputEncoderTests,RemoteInputBufferTests,RemoteScrollTests}.swift` (vector byte giữ nguyên, đổi đầu vào từ kVK sang `KeyboardEvent.code`).

**Interfaces — Produces:**
- `keymap.ts`: `codeToKey(code: string): {vk: number, scan: number} | null` — bảng `KeyboardEvent.code` (chuẩn UI Events) → VK/scan, phủ đúng tập phím của bảng `MacRemoteInputEncoder.mapping` (M:272-382: chữ, số, dấu câu US, F1–F24, keypad, mũi tên, Home/End/PageUp/PageDown, Insert/Delete, Enter/Tab/Backspace/Esc/Space, CapsLock, ContextMenu, PrintScreen/ScrollLock/Pause, các phím bổ trợ trái/phải) với scan E0-extended dạng 0xE0xx.
- `encoder.ts`: `class InputEncoder { constructor(o: {binaryKeyboard: boolean}); keyDown(e: {code: string, key: string, ctrl: boolean, alt: boolean, meta: boolean, shift: boolean, capsLock: boolean, repeat: boolean}): Uint8Array[]; keyUp(e): Uint8Array[]; text(s: string): Uint8Array[]; pointerMove(p: {x,y}, buttons): string[]; pointerDown(button: 0|1|2, p): string[]; pointerUp(button: 0|1|2, p): string[]; wheel(deltaY: number, mode: 'pixel'|'line'|'page'): string[]; releaseAll(): (string|Uint8Array)[] }` — trả về bản tin sẵn gửi (chuỗi chuột / gói phím). Ánh xạ nút trình duyệt: 0 trái, 1 giữa, 2 phải. Wheel: chuyển `deltaY` về đơn vị nấc như `RemoteScroll` (pixel → /40, line → /3? theo Swift `precise ? 40 : 3`; page → 1 trang = 3 nấc), sensitivity mặc định 1, tích luỹ phần lẻ; hướng: deltaY dương (cuộn xuống) → delta âm.
- `queue.ts`: `class InputQueue { constructor(send: (m: string|Uint8Array) => Promise<void>, onOverflow: () => void, capacity = 8192); push(m): void; clear(): void }` — gộp move chuỗi `8|||512|||…` liền kề còn chờ; gửi tuần tự.
- `geometry.ts`: `type View = {canvasRect: {left,top,width,height}, imageW: number, imageH: number, crop: {x,y,w,h}, virtualLeft: number, virtualTop: number}`; `toRemote(clientX: number, clientY: number, v: View): {x: number, y: number} | null` — tính vùng ảnh thực (object-fit contain/letterbox), null khi ngoài ảnh (trừ khi đang giữ nút: kẹp vào biên).

- [ ] Step 1: test port từ TM (đổi đầu vào), cộng thêm: `codeToKey('KeyA') = {vk:0x41, scan:0x1e}`, `codeToKey('ArrowLeft') = {vk:0x25, scan:0xe04b}`, `codeToKey('MetaLeft') = {vk:0x5b, scan:0xe05b}`, `codeToKey('AltRight') = {vk:0xa5, scan:0xe038}`; giữ Alt → kind 3/4; `text('aệ')` → 4 gói VK 0xe7 char 0x61, 0x1ec7 (down/up/down/up); `text('😀')` → []; `releaseAll` sau khi giữ Shift+A + chuột trái → [keyUp A, chuột trái up, keyUp Shift]; geometry: canvas 960×540 hiển thị ảnh 1920×1080 → click (480,270) = (960,540); ảnh letterbox; crop monitor 2 (`-1920:0:0:1080|0:0:1920:1080|`, virtualLeft -1920) → toạ độ gửi cộng đúng; queue: 3 move liền kề khi đang gửi → chỉ gửi move cuối; tràn 8192 → `onOverflow` 1 lần. → FAIL.
- [ ] Step 2: cài đặt.
- [ ] Step 3: test xanh, `npm test`, `tsc`. Commit `feat(viewer): browser input encoder, keymap, queue and geometry`.

---

### Task 4: Trang viewer desktop — điều khiển chuột/phím, toolbar

**Files:** Create `src/viewer/{main,toolbar}.ts`; modify `index.html`, `src/spike/main.ts` (thành module Diagnostics được viewer gọi), `vite.config.ts` nếu đổi entry; test `src/viewer/*.test.ts` (jsdom).

**Interfaces:** Consumes Task 2 (`RelaySession` API), Task 3 (encoder/queue/geometry), Task 6 GĐ0 (frame scheduler).

Hành vi:
- Bố cục: thanh trên (form kết nối thu gọn sau khi đã kết nối), toolbar, vùng màn hình chiếm phần còn lại; mục Diagnostics thu gọn ở dưới.
- Toolbar: **Điều khiển** (bật/tắt cục bộ; mặc định bật khi `allowsRemoteInput`), **Màn hình** (Tất cả / 1 / 2 …), **Scale** (Vừa khung / 100% có cuộn), **Chất lượng** (Tự động/Tốc độ/Chất lượng), **Ẩn wallpaper**, **Phím** (Ctrl+Alt+Del, Win, Alt+Tab, Alt+F4, Ctrl+Esc, PrintScreen — tổ hợp gửi bằng chuỗi keyDown/keyUp qua encoder; Ctrl+Alt+Del dùng lệnh "22"), **Toàn màn hình** (Fullscreen API + `navigator.keyboard.lock()` khi có), **Làm mới**, **Ngắt**.
- Bắt sự kiện trên canvas khi Điều khiển bật và có quyền: `pointerdown/move/up` (pointer capture), `wheel` (passive:false, preventDefault), `contextmenu` preventDefault; bàn phím: focus vào một `<textarea>` ẩn phủ trên canvas (dùng chung với IME Task 5); `keydown` → `preventDefault` cho mọi phím có trong keymap trừ khi đang composition; keyup tương ứng.
- `blur`, `visibilitychange` ẩn, `pagehide`, đổi monitor, mất quyền 49, ngắt kết nối → `releaseAll` (Review Focus 1).
- `supportsBinaryKeyboard=false` → tắt gửi phím, hiện "Máy Windows dùng UltraViewer cũ (< 6.2.13): chỉ điều khiển chuột" (Review Focus 5).
- Con trỏ trình duyệt trên canvas: ẩn (`cursor:none`) khi đang điều khiển và có con trỏ từ xa (Task 6); ngược lại để mặc định.
- `beforeunload` khi đang kết nối → hỏi xác nhận (chặn ⌘W/Ctrl+W lỡ tay; Review Focus 4).
- [ ] Step 1: test jsdom: canvas giả lập 960×540/ảnh 1920×1080 → pointerdown trái tại giữa → session giả nhận `8|||512|||1|||960|||540` rồi `8|||513|||1|||<packed>`; keydown `KeyA` → gói phím kind 1 vk 0x41; `blur` khi đang giữ → releaseAll gửi đủ; toggle Điều khiển tắt → không gửi; 49 false → releaseAll + khoá; chọn monitor 2 → releaseAll và toạ độ dịch đúng; nút Ctrl+Alt+Del → `sendCommand(ctrlAltDel)`; peer cũ → không gửi phím + có thông báo. → FAIL.
- [ ] Step 2: cài đặt. `npm run build && npm run test:build`.
- [ ] Step 3: thử tay trên localhost với Chromium (agent-browser) bằng session giả nếu không có máy Windows; ghi kết quả. Commit `feat(viewer): desktop control UI with toolbar`.

---

### Task 5: Gõ văn bản — IME tiếng Việt, bàn phím ảo

**Files:** Create `src/viewer/ime.ts` + test; modify `viewer/main.ts`.

**Interfaces — Produces:** `attachTextInput(el: HTMLTextAreaElement, h: {key: (e: KeyboardEvent, down: boolean) => void, text: (s: string) => void}): () => void`.

Hành vi (Review Focus 2):
- Phím không phải văn bản (mũi tên, Enter, Backspace, Tab, Esc, F-keys, có Ctrl/Alt/Meta) → đường VK như Task 4.
- Ký tự in được không qua IME: nếu `e.key` là 1 ký tự ASCII khớp phím vật lý → đường VK (để Unikey trên Windows vẫn hoạt động khi người dùng tắt IME máy mình); nếu `e.key` là ký tự ngoài ASCII (bàn phím quốc tế, Option+key) → `text(e.key)`.
- Đang composition (`isComposing` hoặc `key==='Process'`/keyCode 229) → **không** gửi VK; chờ `compositionend` → `text(data)`; với trình duyệt di động không phát composition chuẩn → dùng `beforeinput` (`insertText`, `insertReplacementText`, `insertCompositionText` đã chốt) và `deleteContentBackward` → Backspace VK. Textarea được xoá sau mỗi lần gửi để không tích nội dung.
- Cập nhật chữ đang gõ dở (marked text) chỉ hiện cục bộ cạnh con trỏ (không gửi).
- [ ] Step 1: test jsdom phát chuỗi sự kiện mô phỏng: macOS Telex "Vieejt" (keydown isComposing… compositionend "Việt") → chỉ `text('Việt')`, không VK chữ; iOS (beforeinput insertText "ệ") → `text('ệ')`; Android Gboard (keydown 229 + beforeinput insertCompositionText + compositionend) → đúng một lần `text`; deleteContentBackward → Backspace VK down/up; phím 'a' không IME → VK. → FAIL.
- [ ] Step 2: cài đặt + nối vào viewer.
- [ ] Step 3: test xanh; thử tay trên Chromium với bộ gõ tiếng Việt nếu có. Commit `feat(viewer): text input with Vietnamese IME and soft keyboards`.

---

### Task 6: Con trỏ từ xa

**Files:** Create `src/viewer/cur-decode.ts`, `src/viewer/cursor-layer.ts` + test. Port `M/RemoteCursorPresenter.swift` (cache LRU 64 hình/16 MiB, hình mặc định mũi tên, giải mã CUR/DIB trực tiếp) và vector `TM/RemoteCursorPresenterTests.swift`.

**Interfaces — Produces:** `decodeCur(bytes: Uint8Array): {width, height, hotX, hotY, rgba: Uint8ClampedArray}` (throw như Swift); `class CursorLayer { constructor(canvas: HTMLCanvasElement /*overlay*/, requestShape: (hash: number) => void); onEvent(e: CursorEvent): void; setView(v: View): void; setVisible(b: boolean): void }`.

- [ ] Step 1: port test presenter + CUR; thêm: hash chưa có → gọi `requestShape` đúng một lần cho tới khi nhận shape; vị trí âm (monitor trái) với crop → vẽ đúng chỗ. → FAIL.
- [ ] Step 2: cài đặt; nối vào viewer (overlay canvas cùng kích thước khung ảnh).
- [ ] Step 3: test xanh. Commit `feat(viewer): remote cursor overlay`.

---

### Task 7: Cảm ứng — điện thoại/iPad

**Files:** Create `src/viewer/touch.ts` + test; modify `viewer/main.ts`, `index.html` (meta viewport `width=device-width, initial-scale=1, viewport-fit=cover`, `touch-action:none` trên vùng màn hình).

**Interfaces — Produces:** `attachTouch(el: HTMLElement, h: {move(p), down(button, p), up(button, p), wheel(deltaY), zoom(scale, center), showKeyboard()}, getView: () => View): () => void`.

Chế độ **trackpad** (mặc định trên thiết bị cảm ứng, `pointerType==='touch'`):
- Một ngón kéo → di chuyển con trỏ từ xa tương đối (gia tốc nhẹ); chạm nhanh (< 200 ms, < 10 px) → click trái tại vị trí con trỏ từ xa; chạm hai lần rồi giữ kéo → kéo-thả (giữ nút trái).
- Hai ngón chạm nhanh → click phải; hai ngón kéo dọc → wheel; chụm/mở hai ngón → zoom **cục bộ** (scale khung nhìn, không gửi gì), kéo hai ngón khi đã zoom → pan.
- Nút nổi "⌨" → focus textarea (Task 5) để bật bàn phím ảo; nút nổi "Phím" mở menu phím đặc biệt (Task 4).
- Bút/chuột thật trên iPad (`pointerType` mouse/pen) → hành vi như desktop.
- [ ] Step 1: test bằng PointerEvent giả: tap → down/up trái tại vị trí con trỏ hiện tại; kéo 1 ngón 100px → move tương đối; 2 ngón tap → click phải; 2 ngón kéo xuống 120px → wheel âm; pinch 2× → zoom 2, không gửi bản tin; tap-tap-kéo → down, move…, up. → FAIL.
- [ ] Step 2: cài đặt + nối vào viewer.
- [ ] Step 3: test xanh; `npm run build && npm run test:build`; thử trên giả lập mobile của Chromium (agent-browser, viewport 390×844, touch). Commit `feat(viewer): touch trackpad mode for phones and tablets`.

---

### Task 8: Thử thật cùng chủ repo (localhost)

- [ ] Chủ repo kết nối máy Windows (tự gõ ID/mật khẩu) qua trang localhost: click, kéo-thả, cuộn, gõ tiếng Anh, gõ tiếng Việt bằng Telex của macOS, Ctrl+Alt+Del, đổi monitor (nếu có 2 màn), đổi chất lượng, ẩn wallpaper, con trỏ từ xa, Toàn màn hình + Esc/Alt+Tab.
- [ ] Ghi kết quả từng mục (đạt/không đạt + dòng log) vào `docs/superpowers/specs/2026-10-20-ultraviewer-web-viewer-phase1-result.md`; lỗi → vòng sửa.

## Quyết định trong kế hoạch (Claude tự chọn, chủ repo xem lại)

- ⌘ (Mac) → phím Win như MacViewer; Ctrl giữ nguyên Ctrl. Người dùng Mac muốn copy/paste trên Windows dùng Ctrl+C/V.
- Phím tổ hợp trình duyệt không cho bắt (⌘Tab, ⌘Q…) → có nút trong menu "Phím" và chế độ Toàn màn hình + Keyboard Lock (Chrome/Edge desktop).
- Trên cảm ứng mặc định **trackpad** (con trỏ tương đối) thay vì chạm-trực-tiếp, vì chính xác hơn trên màn nhỏ; chưa làm chế độ chạm trực tiếp.
- Gõ ASCII không IME đi đường VK (giữ tương thích Unikey trên Windows); có IME/ngoài ASCII đi `VK_PACKET`.
- Giữ trang spike làm mục Diagnostics.
