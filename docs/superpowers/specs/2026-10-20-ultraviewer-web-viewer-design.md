# UltraViewer Web Viewer — thiết kế

Ngày: 2026-10-20 · Trạng thái: chờ duyệt

## 1. Mục đích và lý do

Chủ repo muốn điều khiển máy Windows **đang cài sẵn UltraViewer** từ **bất kỳ thiết bị nào**
(điện thoại, iPad, máy mượn) **chỉ bằng một link web**, không cài gì ở thiết bị điều khiển và
không cài thêm gì trên máy Windows.

Hiện có [MacViewer](https://github.com/DeanOpen/MacViewer) (MIT, Swift, macOS) đã viết lại phía
client của giao thức UltraViewer. Dự án này **port phía điều khiển (controller) của MacViewer
sang chạy trong trình duyệt**.

- Link: `https://tranhuongk.github.io/viewer/`
- Người dùng: chỉ chủ repo (dùng riêng). Không phải dịch vụ công khai.

## 2. Mục tiêu

Đạt tương đương **phía điều khiển** của MacViewer:

| Nhóm | Tính năng |
|---|---|
| Kết nối | Nhập ID + mật khẩu UltraViewer của máy Windows → đăng nhập qua relay của UltraViewer |
| Màn hình | Hiển thị màn hình, chọn monitor, scale (vừa khung / 100%), chọn chất lượng, tắt wallpaper, hiện con trỏ từ xa |
| Điều khiển | Bật/tắt Control; chuột (click trái/phải/giữa, kéo, cuộn), bàn phím (map ⌘→Win, ⌥→Alt, ⌃→Ctrl), phím đặc biệt (Ctrl+Alt+Del…) |
| Cảm ứng | Dùng được trên điện thoại/iPad: chế độ trackpad (chạm = click, hai ngón = chuột phải/cuộn, pinch zoom cục bộ), bàn phím ảo |
| Gõ tiếng Việt | Gõ bằng bộ gõ của thiết bị điều khiển (Telex/VNI, bàn phím iOS/Android) → gửi ký tự Unicode đúng sang Windows |
| Âm thanh | Phát âm thanh máy Windows (G.722) |
| Chụp/quay | Chụp màn hình (chọn vùng, chú thích như MacViewer) và quay video phiên |
| Chat | Khung chat hai chiều |
| Clipboard | Đồng bộ clipboard hai chiều, bật/tắt được |
| File | Gửi file (chọn hoặc kéo thả) và nhận file (bấm Save → tải về) |
| Tiện ích | Danh sách máy gần đây + nickname; tuỳ chọn nhớ mật khẩu; giao diện Tiếng Việt / English |

## 3. Không làm (non-goals)

- **Chế độ chia sẻ máy này (Share/host):** trình duyệt không cho máy khác điều khiển chuột/phím.
- **Kết nối LAN trực tiếp:** cần mở cổng TCP lắng nghe, trình duyệt không làm được → luôn đi relay.
- Truy cập không cần duyệt (unattended), micro/voice chat — MacViewer cũng chưa có.
- Nhiều tài khoản người dùng, đăng ký, quản trị.
- Tự kiểm tra cập nhật (web luôn là bản mới nhất).

## 4. Điều không được xảy ra (anti-goals)

1. **Worker trở thành open proxy** cho người lạ mượn mở TCP tới bất kỳ đâu.
2. **ID/mật khẩu UltraViewer đi qua server ở dạng đọc được.** Chúng chỉ được xử lý trong trình
   duyệt; Worker chỉ thấy byte TLS đã mã hoá.
3. **Làm hỏng các trang khác** đang có trên `tranhuongk.github.io` (douyin, game, policies…).
4. Trang bị index/tìm thấy công khai: thêm `noindex`, không link từ trang chủ.

## 5. Kiến trúc

```
Trình duyệt (tranhuongk.github.io/viewer)                Cloudflare Worker            UltraViewer
┌──────────────────────────────────────────┐   WSS    ┌──────────────────┐  TCP   ┌──────────────────┐
│ UI (canvas, input, chat, file…)          │◄────────►│ ống dẫn WS⇄TCP   │◄──────►│ functions3 (cmd) │
│ Giao thức UV (port từ MacViewer)         │ (byte TLS│ - kiểm token     │  :443  │ relay IP (data)  │
│ TLS client (WASM/JS) ─ SNI "ultraviewer" │  thô)    │ - chỉ IPv4:443   │        └──────────────────┘
│ zstd+dict, 3DES, MD5, G.722 (WASM/JS)    │          │ - chặn IP private│
└──────────────────────────────────────────┘          └──────────────────┘
```

### 5.1 Hai kết nối mỗi phiên (theo khảo sát source MacViewer)

| Kết nối | Đích | Dùng cho |
|---|---|---|
| A. Command | IP của `functions3.ultraviewer.net`, cổng 443, TLS | Đăng ký client, tra ID đối tác, keepalive `"2"` mỗi 60 s |
| B. Relay data | `relayIP` (IPv4 thô, field 11 của reply lookup), cổng 443, TLS | Đăng nhập, màn hình, input, chat, clipboard, file, audio — tất cả in-band |

Không có UDP, không có socket phụ. Timer: ping mỗi 10 s, deadline handshake 20 s — đều thoải mái
cho trình duyệt.

### 5.2 Cloudflare Worker (ống dẫn)

- Endpoint WSS: nhận đích `IPv4:port` + token; mở `connect()` tới đích; chuyển byte hai chiều.
  Không parse, không giải mã, không log nội dung.
- **Bảo vệ:** token bí mật (Worker secret, so sánh constant-time); **chỉ cổng 443**; **chỉ IPv4
  công khai** (chặn 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 100.64/10, 0/8, multicast…);
  giới hạn số kết nối đồng thời mỗi token (ví dụ 4).
- Phân giải DNS `functions3.ultraviewer.net`: browser dùng DNS-over-HTTPS (Cloudflare `1.1.1.1`
  JSON API) rồi gửi IP cho Worker, hoặc Worker tự resolve — builder chọn.
- Deploy bằng `wrangler` lên `*.workers.dev` của tài khoản Cloudflare chủ repo.
- Lý do không giới hạn theo hostname: relay được cấp dưới dạng IP thô, không có tên miền tương ứng.

### 5.3 TLS trong trình duyệt

Bắt buộc làm ở browser (không dùng `startTls` của Worker) vì:

- SNI phải là nhãn `ultraviewer` (không phải FQDN), còn tên kiểm chứng chứng chỉ là
  `relayHostname` (field 14) hoặc `functions3.ultraviewer.net`.
- Phải **chấp nhận chứng chỉ hết hạn** nhưng vẫn kiểm chuỗi tin cậy + tên.
- Phải tin thêm root **Sectigo Public Server Authentication Root R46**
  (SHA-256 `7BB647A6…F25A06`) như MacViewer.
- Giữ yêu cầu (2) ở mục 4: Worker không thấy plaintext.

Thư viện TLS (rustls→WASM, node-forge, hoặc khác) do builder chọn, với điều kiện: TLS 1.2 trở lên,
đặt được SNI tuỳ ý, tự kiểm chuỗi chứng chỉ theo luật trên. Bộ root tin cậy: Sectigo R46 + bộ root
công khai phổ biến (ví dụ danh sách Mozilla) gói kèm.

### 5.4 Giao thức (port từ `Sources/UltraViewerProtocol`, chỉ phần controller ≈ 5.300 dòng Swift)

- Sau TLS: preamble HTTP giả (`POST /UVService/ …`), bỏ header phản hồi tới CRLFCRLF; sau đó
  khung `u32 LE length + payload`; envelope kind 0 = forward, 1 = system.
- Mã hoá kênh command: 3DES-EDE3-CBC + PKCS7, key/IV hằng số (precompute được). WebCrypto không có
  3DES → dùng thư viện JS/WASM.
- MD5 cho các proof đăng nhập/lookup và device identity → thư viện JS.
- Màn hình: zstd (RGB555, dictionary `8bit.dat` 112.640 byte, pin SHA-256), JPEG atlas tile (dùng
  decoder JPEG của browser), scroll-copy, tile cache ≤ 1000, frame phải tuần tự, ack `"18"` mỗi
  frame. Con trỏ: file .CUR (có thể nén zstd). zstd và G.722 nên biên dịch từ chính mã C trong
  `ThirdParty/` sang WASM để khớp hành vi.
- Giới hạn bộ nhớ như MacViewer: frame ≤ 16 MiB, cache 64 MiB, giải nén ≤ 128 MiB.
- Nguồn tham chiếu: MacViewer bản `v0.3.21` (commit `237c446`). Test fixtures của MacViewer
  (`Tests/Fixtures`, `Tests/UltraViewerProtocolTests`) dùng làm dữ liệu đối chiếu khi port.

### 5.5 Danh tính client và trạng thái lưu trên trình duyệt

- Mỗi phiên phải đăng ký client trước. Lưu trong `localStorage`: `deviceIdentity` (32 hex), mật
  khẩu client 8 số — tương đương `registration.json` của MacViewer → ID của web viewer ổn định giữa
  các lần mở trên cùng thiết bị.
- Trình duyệt không biết IP LAN và MAC → **tạo giá trị giả, sinh một lần, lưu cố định**. Chọn IP
  sao cho phía controller không kích hoạt nhánh LAN direct. Spike (mục 7) phải xác nhận server chấp
  nhận các giá trị này.
- Các trường giả lập Windows (OS string, twips `15`, client version `6.6.133`…) giữ như MacViewer.
- **Token Worker và danh tính client trên máy mượn** (chủ repo đã chốt): màn hình nhập token có ô
  **"Nhớ trên thiết bị này"**, mặc định **không tích**.
  - Không tích: token, `deviceIdentity`, mật khẩu client chỉ ở `sessionStorage` — đóng tab là mất.
  - Có tích: lưu `localStorage`.
  - Có nút **"Quên thiết bị này"** xoá toàn bộ dữ liệu của viewer.
  - Worker hỗ trợ **đổi token** (thu hồi token cũ) mà không cần sửa code, ví dụ bằng
    `wrangler secret put`; cho phép tối đa 2 token hợp lệ cùng lúc để đổi không gián đoạn.
- Mật khẩu đối tác: mặc định **không lưu**; nếu bật "nhớ mật khẩu" thì lưu `localStorage` kèm
  cảnh báo (không có Keychain trên web).

## 6. Ràng buộc

- **Hosting front-end:** GitHub Pages của repo `tranhuongk/tranhuongk.github.io`, kiểu build
  **legacy** (nhánh `master`, thư mục gốc, có Jekyll). Không có bước build trên server → **commit
  sẵn bản build tĩnh** vào `viewer/`. Không đổi cách deploy của cả site.
  - Jekyll bỏ qua file/thư mục bắt đầu bằng `_` → cấu hình bundler không sinh tên như vậy.
  - Không thêm `.nojekyll` ở gốc (ảnh hưởng toàn site).
- **Mã nguồn:** đặt trong cùng repo (ví dụ `viewer-src/`, gồm cả Worker). Vì repo public nên mã
  nguồn cũng public — **không được có secret trong repo**.
- **Trình duyệt mục tiêu:** Safari iOS/iPadOS, Chrome Android, Chrome/Safari/Edge desktop bản hiện
  hành.
- **Giấy phép:** giữ MIT notice của MacViewer và notice của zstd, G.722 (theo
  `THIRD_PARTY_NOTICES.md`).
- **`8bit.dat`:** từ điển zstd do UltraViewer cung cấp, **chưa có giấy phép phân phối lại**
  (MacViewer `THIRD_PARTY_NOTICES.md`). Chủ repo đã quyết định **commit thẳng vào repo public** và
  phục vụ cùng bản build, chấp nhận rủi ro này. Khi tải vẫn kiểm SHA-256
  `9aa45789…e6b` (dictionary ID `0x3da0bd10`).
- Không đổi gì ở các thư mục khác của site.

## 7. Thứ tự làm và điểm dừng

**Giai đoạn 0 — spike khả thi (go/no-go):** Worker ống dẫn + TLS trong browser (SNI `ultraviewer`,
chấp nhận cert hết hạn) + đăng ký client với IP/MAC giả + lookup + login + **hiện được frame màn
hình đầu tiên** từ máy Windows thật của chủ repo. Đồng thời đo: Worker gói free có giữ được phiên
dài (≥ 30 phút) và băng thông màn hình không (giới hạn CPU/kết nối của Workers). Nếu không đạt →
dừng, báo lại để chọn phương án khác (Workers Paid, chạy ống dẫn trên VPS/Mac).

Cách chạy giai đoạn 0 (chủ repo đã đồng ý làm cùng):
- Chủ repo đăng nhập `wrangler` một lần trên trình duyệt; builder deploy Worker và đặt secret.
- Chủ repo giữ máy Windows mở UltraViewer và **tự gõ ID + mật khẩu** vào trang thử (builder không
  nhập mật khẩu thay). Ghi lại phiên bản UltraViewer trên máy đó.
- Trang thử có **bảng log chẩn đoán** (từng bước: DNS, WS, TLS + chứng chỉ, đăng ký, lookup, login,
  frame đầu) để builder đọc và sửa; log không chứa mật khẩu.
- Chạy thử trang ở `localhost` trước, rồi mới bản trên `tranhuongk.github.io`.

**Giai đoạn 1 — xem + điều khiển:** màn hình đầy đủ, chuột/phím/cảm ứng, monitor, scale, chất
lượng, con trỏ, gõ tiếng Việt.

**Giai đoạn 2 — công cụ phiên:** chat, clipboard, gửi/nhận file, âm thanh, chụp/quay màn hình.

**Giai đoạn 3 — tiện ích:** máy gần đây, nickname, nhớ mật khẩu, i18n VI/EN, hoàn thiện mobile UX.

## 8. Rủi ro đã biết

- **Không chính thức:** dùng hạ tầng relay của UltraViewer ngoài sản phẩm chính thức → có thể trái
  điều khoản, có thể bị chặn bất cứ lúc nào. Chủ repo chấp nhận vì chỉ dùng riêng.
- **Giao thức đổi:** UltraViewer cập nhật có thể làm hỏng; theo dõi MacViewer để cập nhật theo.
- **Giới hạn Cloudflare Workers** (CPU, thời lượng WebSocket, deploy làm rớt kết nối) — kiểm ở
  giai đoạn 0.
- **Clipboard trên web** cần thao tác người dùng/quyền; Safari iOS hạn chế đọc clipboard.

## 9. Để builder quyết

Framework UI (hoặc không framework), bundler, cấu trúc thư mục trong `viewer-src/`, thư viện TLS/
3DES/MD5, chiến lược render (Canvas 2D/WebGL), cách tổ chức test/đối chiếu, cách resolve DNS, cách
giới hạn kết nối trong Worker.

## 10. Quyết định do Claude tự chọn (chủ repo xem lại)

- Link `tranhuongk.github.io/viewer/`, mã nguồn ở `viewer-src/`, build commit vào `viewer/`.
- Bỏ Share và LAN direct (lý do ở mục 3).
- Worker bảo vệ bằng token + chỉ IPv4 công khai cổng 443.
- Không lưu mật khẩu đối tác mặc định.
- Token đổi được, tối đa 2 token hợp lệ cùng lúc; mặc định không nhớ trên thiết bị.
- Trang thử giai đoạn 0 có bảng log chẩn đoán, chạy `localhost` trước.
- Làm theo 4 giai đoạn, có điểm dừng go/no-go sau spike.
