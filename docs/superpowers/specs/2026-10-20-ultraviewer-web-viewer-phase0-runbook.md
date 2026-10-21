# UV Web Viewer — giai đoạn 0: runbook cho chủ repo (Task 8)

Các bước chủ repo tự chạy. Token Worker và mật khẩu UltraViewer **không bao giờ** ghi vào repo, chat, log hay ảnh chụp.

## 0. Tạo token (một lần)

```sh
openssl rand -hex 32
```

- Dùng `-hex`, **không** dùng `-base64`: token đi qua `Sec-WebSocket-Protocol`, nên `/`, `+`, `=` không hợp lệ.
- Trang kiểm tra trước khi kết nối: token phải có ≥ 16 ký tự trong `A-Z a-z 0-9 _ -`.

## A. Chạy local (Mac, Chrome desktop)

**Terminal 1 — Worker:**

```sh
cd viewer-src/worker
# Lần đầu: cp .dev.vars.example .dev.vars, rồi sửa dòng TOKEN_A=<token hex>
npx wrangler dev --port 8787 --ip 127.0.0.1
```

`.dev.vars` đã được git-ignore. Không commit file này.

**Terminal 2 — trang:**

```sh
cd viewer-src
npx vite --host 127.0.0.1
```

Mở URL được in ra (ví dụ `http://127.0.0.1:5173/viewer/`). Ở chế độ dev, Worker URL mặc định là `ws://127.0.0.1:8787` (xem trong **Diagnostics**).

**Trên trang:**

| Ô | Nhập gì |
|---|---|
| Worker token | giá trị `TOKEN_A` |
| Nhớ trên thiết bị này | để trống (mặc định) |
| ID đối tác | ID UltraViewer trên máy Windows |
| Mật khẩu đối tác | mật khẩu UltraViewer trên máy Windows (tự gõ) |

Bấm **Kết nối**. Ghi lại phiên bản UltraViewer trên Windows (Help → About).

**Thành công** khi log đi tới dòng `frame đầu tiên: W×H, giải mã X ms, Y byte` và canvas hiện đúng màn hình Windows.

Các dòng log mong đợi, theo thứ tự:

1. `DNS …`
2. `command: TLS OK …`
3. `Đăng ký OK`
4. `lookup status 1`
5. `data: TLS OK`
6. `Đã gửi login`
7. `init W×H …`
8. `frame đầu tiên …`

## A2. Thử trên điện thoại

Trang chỉ kết nối được trong **secure context** (HTTPS hoặc `localhost`): kiểm tra SHA-256 của từ điển màn hình dùng `crypto.subtle`, mà trình duyệt chỉ bật ở secure context. Mở `http://<IP-LAN>:5173` trên điện thoại sẽ không có `crypto.subtle`; trang hiện thông báo `Trang cần chạy qua HTTPS hoặc localhost …` và từ chối kết nối (không hạ kiểm tra SHA-256). Địa chỉ Worker `ws://127.0.0.1:8787` cũng sẽ trỏ vào chính điện thoại. Hai cách dùng được:

1. **Android + cáp USB (Chrome, bật USB debugging):** chuyển cổng của điện thoại về Mac, rồi mở `http://localhost:5173/viewer/` trên điện thoại (localhost là secure context):

   ```sh
   adb reverse tcp:5173 tcp:5173
   adb reverse tcp:8787 tcp:8787
   ```

   Giữ Terminal 1 và 2 của mục A đang chạy; Worker URL mặc định `ws://127.0.0.1:8787` giờ trỏ về Mac qua `adb reverse`.
2. **Bản đã deploy:** mở `https://tranhuongk.github.io/viewer/` (xem mục B) và dán URL `wss://uv-web-viewer-pipe.<subdomain>.workers.dev` vào ô Worker URL trong **Diagnostics** nếu `PROD_WORKER_URL` chưa được điền.

iPhone/iPad không có `adb reverse`: dùng cách 2.

## B. Deploy (chủ repo, cần trình duyệt)

```sh
cd viewer-src/worker
npx wrangler login               # đăng nhập Cloudflare trên trình duyệt
npx wrangler secret put TOKEN_A  # dán token hex khi được hỏi
npx wrangler deploy              # in ra https://uv-web-viewer-pipe.<subdomain>.workers.dev
```

Sau khi deploy:

1. Mở `viewer-src/src/config.ts` và ghi `PROD_WORKER_URL = 'wss://uv-web-viewer-pipe.<subdomain>.workers.dev'`. URL này không phải secret.
2. Build lại và kiểm tra bản build:

   ```sh
   cd viewer-src
   npm run test:build
   ```

   Lệnh này build lại `viewer/` và chạy test của bản build.
3. Commit `viewer-src/src/config.ts` và `viewer/`.
4. **Chỉ push sau khi chủ repo duyệt.** Pages sẽ phục vụ trang tại `https://tranhuongk.github.io/viewer/`.

Ghi chú:

- `wrangler.toml` đã đặt `[observability] enabled = false`. Không bật lại tính năng này, vì log sẽ chứa header `Sec-WebSocket-Protocol`, tức là chứa token.
- Thử trên điện thoại: mở trang Pages qua 4G (tắt Wi-Fi nhà) và lặp lại các bước ở mục A. Khi khoá màn hình lúc đang kết nối, trang phải báo `Mất kết nối.` trong vòng ≤ 20 s.

## C. Phiên dài 30 phút

- Để **tab ở foreground** suốt phiên. Không ẩn tab, không khoá máy: Chrome bóp timer của tab ẩn, nên relay có thể cắt kết nối.
- Cho màn hình Windows thay đổi liên tục, ví dụ phát một video.
- Theo dõi Worker bằng:

  ```sh
  npx wrangler tail --format pretty
  ```

  **Không bao giờ** dùng `--format json`, vì JSON có header request, tức là có token.
- Ghi lại các thông tin sau:
  - phiên có rớt không, và rớt ở phút nào;
  - mã đóng WS;
  - dòng stats cuối cùng;
  - CPU-time của Worker (dashboard Workers).
- **Lỗi 4429** (quá nhiều kết nối, tối đa 4 cho mỗi token):
  - Nếu Worker bị kill hoặc redeploy giữa chừng, lease có thể kẹt tới **15 phút**.
  - Chờ đủ 15 phút rồi mới thử lại. Đừng bấm kết nối liên tục.
- Nếu màn hình đứng mà không báo lỗi, xem dòng stats:
  - `bỏ qua … tin / N từ nguồn lạ` có N tăng dần, hoặc log có dòng `nguồn lạ addr:port`, nghĩa là relay đã đổi nguồn (lệnh 26).
  - Giai đoạn 0 chưa hỗ trợ trường hợp này. Hãy ghi nó lại trong kết quả.

## C2. Ghi chú thử giai đoạn 2 (chat, clipboard, file, âm thanh, chụp/quay)

- **Tốc độ file là bình thường khi chậm.** Mỗi lần chờ ack chỉ có tối đa 2 mảnh × 32.000 byte trên đường bay, nên qua Worker tốc độ khoảng 200–400 KB/s. File 200 MB mất khoảng 8–16 phút. Đó không phải treo: thanh tiến độ vẫn nhích và hiện tốc độ.
- **Nhận file lớn:** theo dõi bộ nhớ của tab trong Chrome Task Manager (Shift+Esc). Chrome/Edge lưu thẳng ra đĩa (File System Access); Safari/Firefox gom trong bộ nhớ, tối đa 512 MiB, phần quá bị từ chối bằng thông báo rõ.
- **File nhận xong mà chưa bấm "Tải về"** thì khi ngắt kết nối sẽ có thông báo "Tải về N file đã nhận"; mỗi lần bấm tải một file.
- **iPhone:** gạt công tắc im lặng sang chế độ im lặng rồi bật "Âm thanh"; âm thanh vẫn phải nghe được (Safari 16.4+; bản cũ hơn bị công tắc tắt tiếng).
- **Điện thoại không có phím tắt dán:** dùng nút nổi "Dán" hoặc nút "Dán sang Windows" trong Chat → Clipboard (cần bật Clipboard, trình duyệt có thể hỏi quyền "Dán").
- **Video quay bằng Chrome là MP4 phân mảnh (fragmented):** mở thử bằng QuickTime trên Mac để chắc nó chạy được.

## D. Gửi lại cho builder

**Được gửi:**

- các dòng log (từ `Trang sẵn sàng` tới `Phiên kết thúc`);
- dòng stats;
- dòng `frame đầu tiên …`;
- mã đóng WS;
- output của `wrangler tail --format pretty`, chỉ phần mã lỗi;
- phiên bản UltraViewer trên Windows;
- loại thiết bị và trình duyệt;
- mạng đã dùng (Wi-Fi hay 4G).

**Không bao giờ gửi:**

- token;
- mật khẩu UltraViewer;
- nội dung `.dev.vars`;
- ảnh chụp có ô token hoặc ô mật khẩu đang hiện chữ.

ID đối tác là tuỳ chọn. Có thể che bớt ID trước khi gửi.
