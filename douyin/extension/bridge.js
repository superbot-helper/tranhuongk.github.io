// Cầu nối giữa trang tool và extension. Trang web không gọi thẳng
// `chrome.runtime` được, nên nó postMessage và content script chuyển tiếp.

window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.type !== "DOUYIN_COOKIE_REQUEST") return;

  chrome.runtime.sendMessage({ type: "GET_DOUYIN_COOKIE" }, (response) => {
    const payload = chrome.runtime.lastError
      ? { error: chrome.runtime.lastError.message }
      : (response ?? { error: "Extension không phản hồi" });
    window.postMessage({ type: "DOUYIN_COOKIE_RESULT", ...payload }, window.location.origin);
  });
});

// Cờ để trang biết có extension mà hiện nút, thay vì bắt người dùng đoán.
document.documentElement.setAttribute("data-douyin-cookie-bridge", "1");
