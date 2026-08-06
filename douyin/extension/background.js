// Chỉ có extension mới đọc được cookie HttpOnly như `sessionid` — trang web
// thường không cách nào chạm tới, kể cả khi bạn đang mở douyin.com ở tab khác.

const LOGIN_COOKIES = ["sessionid", "sessionid_ss", "sid_tt"];

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "GET_DOUYIN_COOKIE") return;

  // Lọc theo URL chứ không theo domain: lấy đúng bộ cookie mà trình duyệt sẽ
  // gửi kèm khi gọi www.douyin.com, không lẫn cookie của sso/live.
  chrome.cookies.getAll({ url: "https://www.douyin.com/" }, (cookies) => {
    if (chrome.runtime.lastError) {
      sendResponse({ error: chrome.runtime.lastError.message });
      return;
    }
    sendResponse({
      cookie: cookies.map((item) => `${item.name}=${item.value}`).join("; "),
      count: cookies.length,
      loggedIn: cookies.some((item) => LOGIN_COOKIES.includes(item.name) && item.value),
    });
  });

  return true; // giữ kênh mở cho callback bất đồng bộ
});
