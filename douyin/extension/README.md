# Douyin Cookie Bridge

Extension nhỏ để tool [Douyin Downloader](../) lấy được cookie `douyin.com` của
chính bạn — thứ mà trang web không tự đọc được vì `sessionid` là cookie
`HttpOnly`.

Không có cookie, Douyin chỉ trả **~42 video mới nhất** mỗi kênh cho khách vãng lai.

## Cài (Chrome / Edge / Arc / Brave)

1. Mở `chrome://extensions` (Edge: `edge://extensions`).
2. Bật **Developer mode** ở góc trên bên phải.
3. Bấm **Load unpacked** rồi chọn đúng thư mục này (`douyin/extension`).
4. Đăng nhập `douyin.com` trong cùng trình duyệt đó.

Xong. Mở tool, ô Cookie sẽ có thêm nút **Lấy cookie tự động** — bấm một cái là
điền xong, không phải copy tay.

## Nó làm gì

| | |
|---|---|
| Quyền xin | `cookies` + truy cập `https://*.douyin.com/*` |
| Chạy trên | trang tool (`tranhuongk.github.io/douyin/*`, `localhost`) |
| Khi được gọi | đọc cookie mà trình duyệt sẽ gửi cho `www.douyin.com`, trả về trang tool |

Extension **không** tự gửi cookie đi đâu cả — nó chỉ trả lời khi bạn bấm nút.
Cookie sau đó nằm trong `localStorage` của trang tool và được gửi kèm request
quét (trong POST body, không phải query string). Muốn dọn thì bấm **Xoá cookie**
trên tool và gỡ extension.

Cookie đăng nhập Douyin là chìa khoá vào tài khoản của bạn — đừng dán nó cho ai.

## Gỡ

`chrome://extensions` → **Remove**.
