# UltraViewer Web Viewer — Giai đoạn 2 (công cụ phiên) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm vào viewer các công cụ phiên như MacViewer: chat (kèm báo đang gõ), clipboard hai chiều (bật/tắt), gửi/nhận file, nghe âm thanh máy Windows, chụp màn hình (toàn bộ / vùng / chú thích) và quay video phiên.

**Architecture:** Port 1-1 các bản tin và máy trạng thái phía controller của MacViewer (`ChatProtocol`, `ClipboardProtocol`, `FileTransferOffer`, `FileTransferEngine`, `ComputerAudioMessage`, `G722Decoder` + mã C `ThirdParty/g722` biên dịch WASM); mở rộng `RelaySession` với API/sự kiện tương ứng; UI mới trong `viewer/` dùng API trình duyệt (Clipboard API + sự kiện `paste`, File/Blob/File System Access, AudioWorklet, canvas `toBlob`, `MediaRecorder`).

**Tech Stack:** TypeScript, Vite, Vitest, emsdk (đã cài ở `~/.local/share/emsdk`), AudioWorklet, MediaRecorder, File System Access API (khi có).

**Spec:** `docs/superpowers/specs/2026-10-20-ultraviewer-web-viewer-design.md` (mục 2: Âm thanh, Chụp/quay, Chat, Clipboard, File). GĐ0/GĐ1 đã xong (ledger `.superpowers/sdd/2026-10-20-ultraviewer-web-viewer-phase{0,1}/progress.md`).

**Nguồn port:** `$MV` (MacViewer `v0.3.21`, `237c446`). P = `Sources/UltraViewerProtocol`, M = `Sources/MacViewer`, TP/TM = tests.

## Global Constraints

- Mọi ràng buộc chung của GĐ0/GĐ1 vẫn áp dụng (branch `feature/uv-web-viewer`, không push, Jekyll-safe `viewer/`, noindex, không secret, log không chứa mật khẩu/token/proof/nội dung chat/clipboard/tên file, port giữ nguyên vector byte Swift, lỗi `XError{code}`).
- **Cổng dùng công cụ:** chat, typing, clipboard, file chỉ khi `canUseSessionTools = peerAccepted && phase ∈ {active, login}` (Swift RS:170-172); **không** phụ thuộc quyền điều khiển (49). Âm thanh chỉ khi `phase == active`. Không có cổng theo phiên bản ngoài ≥ 6.0.0 sẵn có.
- **Chat:** gửi UTF-16LE `"12|||"+text` flag true; typing `"29"`/`"30"` UTF-16LE flag true; nhận multipart `[[12,0], UTF-16LE]`, `[[29|30,0]]`. Giới hạn 32 KiB (cả UTF-8 và UTF-16), từ chối `|||` khi gửi, từ chối ký tự điều khiển < 32 trừ tab/CR/LF; UI tối đa 16.384 đơn vị UTF-16; typing: debounce 0,25 s, gửi typing true rồi false sau 2 s không gõ, nháp rỗng → false; chỉ báo phía kia hết hạn sau 4 s; transcript ≤ 200 tin hoặc 1 MiB.
- **Clipboard:** chỉ văn bản. Gửi modern: ASCII `"33|||<số byte UTF-16>|||"` + **khung zstd** của UTF-16LE, flag false — web gửi khung zstd dạng **raw block** (stored, không nén; Swift test chứng minh host nhận) thay vì port bộ nén; rỗng → UTF-16LE `"5|||"` flag true. Nhận: modern `[[33], Int32LE byteCount, zstd]`, legacy `[[5], UTF-16LE]`. UTF-16 nghiêm ngặt, từ chối NUL, độ dài giải nén = khai báo. Giới hạn 1 MiB văn bản (524.288 đơn vị), payload 2 MiB. Một cờ `clipboardAllowed` cho cả hai chiều, **mặc định tắt**, không gửi gì khi bật/tắt; nhận khi tắt → bỏ im lặng. Chống vọng (echo): nhớ văn bản đã gửi/nhận gần nhất.
- **File:** mảnh 32.000 byte; offset **bắt đầu từ 1**; tối đa 2 mảnh chưa ack khi gửi; ≤ 16 phiên truyền (vào + ra); kích thước ≤ 999.999.999.999.999; id `[0-9A-Za-z_-]{1,64}`, id tự sinh `"3"` + 19 chữ số ngẫu nhiên; tên file không rỗng, ≤ 1024 byte UTF-8, không `|||`, không ký tự điều khiển. Nhận: offer `[[13,0], id, tên ANSI(CP1252 trước, UTF-8 sau), Double8LE size]` → chấp nhận UTF-16LE `"14|||id|||1"` flag true → mảnh `[[15,0], id, offset(Double8LE hoặc Int32LE), data ≤ 32000]` → ack UTF-16LE `"21|||id"` flag true mỗi mảnh → xong khi đủ size. Gửi: offer UTF-16LE `"13|||id|||name|||size"` flag true → host chấp nhận `[[14,0], id, Int32LE 1]` (chỉ nhận offset 1) → mảnh raw `"15|||id|||<offset thập phân>|||"+data` flag false → host ack `[[21,0], id]`. Huỷ: `16|||id` UTF-16LE flag true / nhận `[[16,0], id]`. Lỗi offset/độ dài/đọc/ghi → gửi huỷ + sự kiện failed với chuỗi Swift. Offer trùng id → bỏ; quá 16 → huỷ. File 0 byte xong ngay khi chấp nhận. Ngắt kết nối → reset mọi phiên truyền.
- **Âm thanh:** bật/tắt bằng lệnh `46|||-1` / `46|||0` (đã có trong `commands.ts`); nhận `[[43], G.722]` hoặc `[[42], Int32LE số byte PCM im lặng]` (0..262.144). G.722 64 kbit/s options 0; 1 byte → 2 mẫu Int16LE; PCM coi là 48 kHz stereo xen kẽ; **bản sửa tràn kiểu NAudio** trong `ThirdParty/g722/MacViewerG722.c` phải giữ nguyên. Decoder có trạng thái, tạo lười ở gói 43 đầu, giữ qua tạm dừng/im lặng, bỏ khi hết phiên. Hàng đợi phát ≤ 250 ms (12.000 frame); vượt → bỏ hết rồi phát lại; một gói quá lớn → giữ 250 ms mới nhất. Âm lượng 25/50/75/100 %. Mặc định tắt; bật cần thao tác người dùng (chính sách autoplay).
- **Chụp:** từ frame đã giải mã (đã crop theo monitor), không chụp cửa sổ. PNG tên `<máy> yyyy-MM-dd HH.mm.ss.png`. Trình chú thích: chọn vùng (kéo, chuẩn hoá, ≥ 2×2), bút tự do, hình chữ nhật, màu đỏ/vàng/xanh, nét `max(2, min(w,h)/350)` px nguồn, Undo, ≤ 200 nét, ≤ 50.000 điểm/nét, nút "Toàn ảnh".
- **Quay:** từ frame mới (không chụp cửa sổ), ≤ 1920×1080 giữ tỉ lệ, không phóng to, kích thước chẵn, nền đen; ≤ 15 fps; không có tiếng; bitrate `min(6 Mbps, max(500 kbps, w*h*3))`; giữ frame cuối tới lúc dừng; tự kết thúc khi ngắt kết nối. Định dạng theo trình duyệt: `video/mp4` nếu `MediaRecorder.isTypeSupported`, ngược lại `video/webm`.
- Chuỗi UI tiếng Việt; nội dung chat/clipboard/tên file không bao giờ vào log chẩn đoán.

## Review Focus

1. **Clipboard trên trình duyệt** không đọc ngầm được: gửi clipboard máy mình lên Windows khi người dùng dán (⌘V/Ctrl+V trong viewer — lấy văn bản từ sự kiện `paste`, gửi clipboard rồi gửi tổ hợp **Ctrl+V** sang Windows); khi Windows copy → cố `navigator.clipboard.writeText`, nếu trình duyệt từ chối (Safari cần thao tác người dùng) → hiện thông báo kèm nút "Sao chép". Không vọng vô hạn giữa hai bên. (Task 5)
2. **File lớn** không làm treo/tràn bộ nhớ tab: gửi đọc theo `File.slice` từng mảnh; nhận ghi luồng qua File System Access (`showSaveFilePicker`) khi có, ngược lại gom Blob tối đa 512 MiB rồi tải về và từ chối file lớn hơn bằng thông báo rõ. (Task 4, Task 6)
3. **Ngắt kết nối giữa chừng** khi đang truyền file/ghi âm/quay → huỷ sạch, file dở không bị lưu như hoàn chỉnh, video đã quay được hoàn tất và tải về. (Task 4, 6, 8)
4. **Âm thanh trễ dồn** hoặc rè khi mạng giật → giữ trần 250 ms, không phát chồng; tắt tiếng thì không giải mã sai trạng thái khi bật lại (decoder vẫn chạy). (Task 2, 7)
5. **Nội dung riêng tư** (chat, clipboard, tên file) không lọt vào log chẩn đoán hay bản build. (mọi task)

---

## Cấu trúc file

```
viewer-src/src/
  proto/chat.ts  proto/clipboard.ts  proto/file-offer.ts  proto/audio-message.ts        (+ test)
  codec/g722.ts  codec/g722.js  codec/g722.wasm   scripts/build-wasm.sh (thêm g722)       (+ test, fixture)
  session/file-engine.ts                                                                 (+ test)
  session/relay-session.ts (sửa)  session/control.ts (sửa)
  viewer/chat-panel.ts  viewer/clipboard-sync.ts  viewer/file-transfers.ts
  viewer/audio-player.ts  viewer/audio-worklet.ts  viewer/capture.ts  viewer/annotate.ts  viewer/recorder.ts
```

---

### Task 1: Bản tin chat, clipboard, file, âm thanh (port thuần)

**Files:** Create `src/proto/{chat,clipboard,file-offer,audio-message}.ts` + test. Port `P/{ChatProtocol,ClipboardProtocol,FileTransferOffer,ComputerAudioMessage}.swift`; test từ `TP/{ChatProtocolTests,ClipboardProtocolTests,FileTransferOfferTests}.swift` (+ phần message của `G722DecoderTests` nếu có) giữ nguyên vector.

**Interfaces — Produces:**
- `chatMessagePayload(text: string): {bytes, formatFlag: true}`; `chatTypingPayload(typing: boolean)`; `decodeChat(parts: Uint8Array[]): {type:'message', text} | {type:'typing', typing: boolean} | null`.
- `clipboardPayload(text: string): {bytes, formatFlag}` (modern, khung zstd raw block; rỗng → `5|||`); `clipboardPayloadLegacy(text)`; `decodeClipboard(parts, zstd: (b, expected) => Uint8Array): string | null`; `rawZstdFrame(data: Uint8Array): Uint8Array` (khung zstd chuẩn gồm các block raw ≤ 128 KiB; test: giải nén lại bằng `ZstdScreenDecoder` không dictionary ra đúng dữ liệu, và khớp header Swift `28 b5 2f fd a0 16 00 00 00 b1 00 00` cho fixture 22 byte).
- `fileOfferPayload(id, name, size)`, `fileAcceptPayload(id)`, `fileChunkPayload(id, offset, data)`, `fileAckPayload(id)`, `fileCancelPayload(id)`; `decodeFileMessage(parts): {type:'offer', id, name, size} | {type:'accept', id, offset} | {type:'chunk', id, offset, data} | {type:'ack', id} | {type:'cancel', id} | null`; `newTransferId(): string`; `validFileName(name: string): boolean`; CP1252 decode bảng đầy đủ.
- `decodeAudioMessage(parts): {type:'g722', data} | {type:'silence', bytes} | null`.
- [ ] Step 1: port toàn bộ test Swift → FAIL. Step 2: cài. Step 3: `npx vitest run src/proto`, `npm test`, `tsc` → PASS; commit `feat(viewer): chat, clipboard, file and audio messages`.

---

### Task 2: G.722 WASM + bộ phát âm thanh

**Files:** Modify `scripts/build-wasm.sh` (thêm target g722 từ `$MV/ThirdParty/g722`, giữ `MacViewerG722.c`); create `src/codec/{g722.ts,g722.js,g722.wasm}`, `src/viewer/{audio-player.ts,audio-worklet.ts}`, `test/fixtures/g722-windows.json` (copy từ `$MV/Tests/Fixtures`) + test.

**Interfaces — Produces:**
- `class G722Decoder { static create(): Promise<G722Decoder>; decode(encoded: Uint8Array): Int16Array /* 2 mẫu/byte */; dispose(): void }`.
- `class AudioPlayer { constructor(o?: {capFrames?: number /*12000*/}); start(): Promise<void> /* tạo AudioContext 48 kHz trong thao tác người dùng, nạp worklet */; push(pcm: Int16Array /* xen kẽ L,R */): void; silence(bytes: number): void; setVolume(v: 0.25|0.5|0.75|1): void; stop(): void }` — logic hàng đợi/cắt 250 ms viết thành hàm thuần `enqueue(state, frames)` có test.
- [ ] Step 1: test G.722 với fixture (một lần + mọi `SplitChunks` với decoder mới, so khớp PCMBase64 từng byte, gồm mẫu tràn 76 = -28446); test hàng đợi (vượt cap → bỏ hết; gói quá lớn → giữ 12.000 frame mới nhất; im lặng → chèn số 0) → FAIL. Step 2: build WASM + cài. Step 3: PASS, `npm run build && npm run test:build`; commit `feat(viewer): g722 decoder wasm and audio player`.

---

### Task 3: RelaySession — chat, clipboard, âm thanh

**Files:** Modify `src/session/relay-session.ts`, `src/session/control.ts` + test. Port Swift RS :249-292 (sendChat, sendTyping, setComputerAudioEnabled, setClipboardSharing, sendClipboard), :719-740 (42/43, 5/33, 12/29/30).

**Interfaces — Produces:** `canUseSessionTools(): boolean`; `sendChat(text): Promise<void>`; `sendTyping(typing): Promise<void>`; `setClipboardSharing(on: boolean): void`; `sendClipboard(text): Promise<void>` (reject `toolsUnavailable`/`clipboardDisabled`); `setComputerAudio(on: boolean): Promise<void>` (gửi 46; chỉ active). Sự kiện mới: `{type:'chat', text}`, `{type:'typing', typing}`, `{type:'clipboard', text}`, `{type:'audio', pcm: Int16Array}` (decoder G.722 tạo lười, chạy kể cả khi UI tắt tiếng; im lặng → Int16Array 0), `{type:'tools', available: boolean}` khi cổng công cụ đổi.
- [ ] Step 1: test kênh giả: chat gửi/nhận đúng byte; typing; clipboard tắt → nhận bị bỏ, gửi bị reject; bật → nhận phát sự kiện; 43 → sự kiện audio đúng mẫu (dùng fixture); 42 → im lặng; 46 gửi đúng; trước accepted → công cụ không dùng được → FAIL. Step 2: cài (tách logic dispatch sang `control.ts` để giữ `relay-session.ts` không phình). Step 3: PASS; commit `feat(viewer): session chat, clipboard and audio`.

---

### Task 4: Máy trạng thái truyền file

**Files:** Create `src/session/file-engine.ts` + test; modify `relay-session.ts` (định tuyến 13–16, 21; hàng đợi gửi file tuần tự; reset khi ngắt). Port `P/FileTransferEngine.swift`, test `TP/FileTransferEngineTests.swift` (khứ hồi hai chiều file 128.017 byte có `|||` và NUL; cửa sổ 2 mảnh).

**Interfaces — Produces:**
- `interface FileSource { size: number; read(offset0: number, length: number): Promise<Uint8Array> }` (bọc `File.slice`); `interface FileSink { write(chunk: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }`.
- `class FileTransferEngine { constructor(send: (p: {bytes, formatFlag}) => Promise<void>); offer(name: string, source: FileSource): string /*id*/; accept(id: string, sink: FileSink): Promise<void>; cancel(id: string): Promise<void>; handle(msg): Promise<void>; reset(): void; onEvent(cb: (e: FileEvent) => void) }`; `type FileEvent = {type:'incoming', id, name, size} | {type:'progress', id, bytes, total, direction:'in'|'out'} | {type:'completed', id} | {type:'canceled', id} | {type:'failed', id, reason}`.
- Session: `sendFile(name, source): string`, `acceptFile(id, sink)`, `cancelFile(id)`, sự kiện `{type:'file', event: FileEvent}`.
- [ ] Step 1: port test Swift + thêm: ngắt kết nối giữa chừng → sink.abort được gọi, sự kiện canceled; file 0 byte; offer thứ 17 → gửi huỷ; offset sai → huỷ + failed đúng chuỗi → FAIL. Step 2: cài. Step 3: PASS; commit `feat(viewer): file transfer engine`.

---

### Task 5: Giao diện chat + đồng bộ clipboard

**Files:** Create `src/viewer/{chat-panel,clipboard-sync}.ts` + test; modify `viewer.ts`, `toolbar.ts`, `index.html`.

Hành vi:
- Nút **Chat** trên toolbar mở bảng nổi (desktop: cạnh phải; điện thoại: trang trượt từ dưới) — transcript (tin của mình/của máy Windows, giờ), ô nhập (Enter gửi, Shift+Enter xuống dòng), chỉ báo "đang gõ…", số tin chưa đọc trên nút; tin đến khi bảng đóng → badge. Ô nhập chat không chuyển phím sang Windows.
- Nút **Clipboard** (bật/tắt, mặc định tắt, nhớ theo thiết bị nếu "Nhớ trên thiết bị này"). Khi bật (Review Focus 1):
  - Dán trong viewer (sự kiện `paste` trên textarea ẩn khi đang điều khiển, kích hoạt bởi ⌘V hoặc Ctrl+V): lấy `clipboardData.getData('text/plain')` → `sendClipboard` (nếu khác văn bản gần nhất) → gửi tổ hợp **Ctrl+V** (qua encoder) sang Windows; chặn ⌘V/Ctrl+V gốc đi đường phím.
  - Windows gửi clipboard → `navigator.clipboard.writeText` (nếu lỗi → toast "Máy Windows vừa copy văn bản" + nút **Sao chép**); ghi nhớ để không gửi ngược.
  - Lịch sử 20 mục gần nhất trong bảng chat (tab Clipboard), không lưu bền.
- [ ] Step 1: test jsdom: gửi chat; nhận chat → badge; typing debounce/hết hạn bằng fake timers; paste khi bật → `sendClipboard` + gói Ctrl down/V down/V up/Ctrl up; paste khi tắt → chỉ Ctrl+V; nhận clipboard → writeText được gọi; writeText reject → toast có nút; không vọng → FAIL. Step 2: cài. Step 3: PASS, build; commit `feat(viewer): chat panel and clipboard sync`.

---

### Task 6: Giao diện gửi/nhận file

**Files:** Create `src/viewer/file-transfers.ts` + test; modify `chat-panel.ts`, `viewer.ts`.

Hành vi (Review Focus 2, 3):
- Gửi: nút 📎 trong bảng chat (input file, chọn nhiều) và kéo-thả file vào bảng chat/vùng màn hình → `sendFile` với `FileSource` từ `File.slice`.
- Nhận: thẻ file trong chat (tên, cỡ, nút **Lưu**, **Huỷ**); Lưu → nếu có `showSaveFilePicker` → sink ghi luồng; ngược lại sink Blob trong bộ nhớ (tối đa 512 MiB, lớn hơn → nút Lưu bị vô hiệu kèm giải thích) rồi tải về bằng `<a download>` khi xong.
- Thanh tiến độ, tốc độ, Huỷ cho cả hai chiều; trạng thái xong/huỷ/lỗi; ngắt kết nối → mọi thẻ đang chạy thành "đã huỷ".
- [ ] Step 1: test jsdom với session giả: chọn file → sendFile; thẻ incoming → Lưu (fake showSaveFilePicker) → accept với sink ghi đủ byte; fallback Blob tạo link tải; file > 512 MiB không có FS Access → không cho Lưu; ngắt giữa chừng → abort + trạng thái huỷ → FAIL. Step 2: cài. Step 3: PASS, build; commit `feat(viewer): file transfer UI`.

---

### Task 7: Giao diện âm thanh

**Files:** Modify `viewer.ts`, `toolbar.ts` (+ test).

Hành vi: nút **Âm thanh** (bật/tắt, mặc định tắt; bật trong thao tác click → `AudioPlayer.start()` + `setComputerAudio(true)`), menu âm lượng 25/50/75/100 % (nhớ theo thiết bị). Tắt → `setComputerAudio(false)` + dừng phát (decoder phía session vẫn chạy theo Swift). Lỗi khởi tạo âm thanh → tự tắt + thông báo "Âm thanh máy tính đã dừng: …". Ngắt kết nối → dừng.
- [ ] Step 1: test jsdom với AudioPlayer giả: bật → start rồi 46|||-1; sự kiện audio → push; tắt → 46|||0 + stop; lỗi start → tắt + thông báo → FAIL. Step 2: cài. Step 3: PASS, build; commit `feat(viewer): computer audio toggle and volume`.

---

### Task 8: Chụp màn hình, chú thích, quay video

**Files:** Create `src/viewer/{capture,annotate,recorder}.ts` + test; modify `toolbar.ts`, `viewer.ts`.

Hành vi:
- Menu **Chụp**: "Chụp và chú thích…", "Chụp một vùng…", "Lưu toàn màn hình (PNG)", "Quay màn hình" ↔ "Dừng quay (m:ss)".
- Ảnh lấy từ frame hiện tại đã crop monitor (snapshot, không phải bitmap sống). Trình chú thích là modal toàn trang (dùng được trên điện thoại): công cụ Chọn vùng / Bút / Chữ nhật, 3 màu, Undo, Toàn ảnh, **Lưu PNG** (crop vùng rồi vẽ nét đã dời gốc), Đóng. Lưu: `canvas.toBlob('image/png')` → tải về tên chuẩn.
- Quay: canvas phụ ≤ 1920×1080 (tỉ lệ giữ, chẵn, nền đen, không phóng to) vẽ frame mới tối đa 15 fps, `captureStream(15)` + `MediaRecorder` (mp4 nếu hỗ trợ, ngược lại webm, `videoBitsPerSecond` theo công thức); dừng hoặc ngắt kết nối → hoàn tất và tải về `<máy> yyyy-MM-dd HH.mm.ss.<ext>`.
- [ ] Step 1: test thuần: tính kích thước quay (1920×1080 giữ, 2560×1440 → 1920×1080, 1366×768 giữ chẵn, 801×601 → 800×600 (làm tròn xuống số chẵn), 640×480 giữ nguyên (không phóng to)); bitrate; chuẩn hoá vùng kéo ngược, < 2×2 bị bỏ; nét = max(2, min/350); giới hạn 200 nét/50.000 điểm; tên file; jsdom: menu gọi đúng; ngắt khi đang quay → recorder.stop được gọi → FAIL. Step 2: cài. Step 3: PASS, build, thử tay bằng agent-browser với `?fake`; commit `feat(viewer): screenshots, annotation and recording`.

---

### Task 9: Thử thật cùng chủ repo (localhost)

- [ ] Chat hai chiều với UltraViewer trên Windows; copy/dán hai chiều (bật Clipboard); gửi 1 file nhỏ + 1 file ~200 MB sang Windows, nhận 1 file từ Windows (Lưu); bật âm thanh (phát nhạc trên Windows); chụp + chú thích; quay 30 giây. Ghi kết quả vào `docs/superpowers/specs/2026-10-21-ultraviewer-web-viewer-phase2-result.md`.

## Quyết định trong kế hoạch (Claude tự chọn, chủ repo xem lại)

- Clipboard từ máy mình lên Windows chỉ khi **dán trong viewer** (trình duyệt không cho đọc clipboard ngầm như MacViewer); dán sẽ tự gửi Ctrl+V sang Windows.
- Gửi clipboard bằng khung zstd **không nén** (raw block) thay vì port bộ nén zstd — clipboard ≤ 1 MiB nên không đáng kể.
- Nhận file lớn: Chrome/Edge ghi thẳng ra đĩa; Safari/Firefox giới hạn 512 MiB trong bộ nhớ.
- Video quay ra **mp4** khi trình duyệt hỗ trợ (Safari, Chrome mới), ngược lại **webm**; không có tiếng.
- Âm thanh, clipboard mặc định **tắt** như MacViewer.
