"use strict";

// Mọi request Douyin đi qua edge function này (resolve / user / download).
const DEFAULT_ENDPOINT = "https://lnazpyhoojqotnanrvqf.supabase.co/functions/v1/douyin";
const LS_KEY = "douyin_dl_prefs_v1";
const PAGE_SIZE = 50; // Douyin trần ~42 item cho request không đăng nhập

/** @type {Array<Object>} state chính — 1 phần tử = 1 video */
let items = [];
let dirHandle = null;
let downloading = false;
let abortAll = null;

const el = (id) => document.getElementById(id);
const ui = {
  statTotal: el("statTotal"),
  statSelected: el("statSelected"),
  statDone: el("statDone"),
  statFail: el("statFail"),
  statFailWrap: el("statFailWrap"),
  body: el("videoBody"),
  empty: el("emptyState"),
  rowsInfo: el("rowsInfo"),
  filterBox: el("filterBox"),
  checkAll: el("checkAll"),
  scanStatus: el("scanStatus"),
  endpointStatus: el("endpointStatus"),
  progressWrap: el("progressWrap"),
  progressBar: el("progressBar"),
  progressText: el("progressText"),
};

/* ═══════════════════════ prefs ═══════════════════════ */

function loadPrefs() {
  let prefs = {};
  try {
    prefs = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
  } catch {
    prefs = {};
  }
  el("endpoint").value = prefs.endpoint || DEFAULT_ENDPOINT;
  el("profileUrl").value = prefs.profileUrl || "";
  el("cookie").value = prefs.cookie || "";
  el("scanMax").value = prefs.scanMax || 200;
  el("threads").value = prefs.threads || 4;
  el("naming").value = prefs.naming || "title";
  el("useFilter").checked = Boolean(prefs.useFilter);
  el("minLike").value = prefs.minLike || 0;
  const dest = prefs.dest === "folder" ? "folder" : "browser";
  document.querySelector(`input[name="dest"][value="${dest}"]`).checked = true;
  syncFilterVisibility();
}

function savePrefs() {
  const prefs = {
    endpoint: el("endpoint").value.trim(),
    profileUrl: el("profileUrl").value.trim(),
    cookie: el("cookie").value.trim(),
    scanMax: Number(el("scanMax").value),
    threads: Number(el("threads").value),
    naming: el("naming").value,
    useFilter: el("useFilter").checked,
    minLike: Number(el("minLike").value),
    dest: destValue(),
  };
  localStorage.setItem(LS_KEY, JSON.stringify(prefs));
}

const endpoint = () => (el("endpoint").value.trim() || DEFAULT_ENDPOINT).replace(/\/+$/, "");
const destValue = () => document.querySelector('input[name="dest"]:checked').value;

/* ═══════════════════════ helpers ═══════════════════════ */

function num(value) {
  return typeof value === "number" ? value.toLocaleString("vi-VN") : "-";
}

function duration(ms) {
  if (!ms) return "-";
  const total = Math.round(ms / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function bytes(size) {
  if (!size) return "";
  const mb = size / 1048576;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(size / 1024)} KB`;
}

function sanitize(name) {
  return name.replace(/[\\/:*?"<>|\r\n\t]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "video";
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function status(node, text, kind) {
  node.textContent = text;
  node.className = `status${kind ? ` ${kind}` : ""}`;
}

/**
 * Cookie đăng nhập đi trong body (POST) chứ không phải query string, để nó
 * không nằm lại trong access log của edge function.
 */
async function callApi(params, signal) {
  const cookie = el("cookie").value.trim();
  const url = new URL(endpoint());
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));

  const init = cookie
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cookie }), signal }
    : { signal };
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok || payload.error) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.payload = payload; // giữ `kind`/`secUid` để caller xử lý riêng
    throw error;
  }
  return payload;
}

function downloadUrl(item, filename) {
  const url = new URL(endpoint());
  url.searchParams.set("action", "download");
  url.searchParams.set("u", item.videoUrl);
  url.searchParams.set("name", filename);
  return url.toString();
}

/* ═══════════════════════ render ═══════════════════════ */

function filteredItems() {
  const query = ui.filterBox.value.trim().toLowerCase();
  if (!query) return items;
  return items.filter((item) => (item.title || "").toLowerCase().includes(query) ||
    (item.awemeId || "").includes(query));
}

function render() {
  const visible = filteredItems();
  ui.body.innerHTML = "";

  const fragment = document.createDocumentFragment();
  visible.forEach((item) => {
    const index = items.indexOf(item) + 1;
    const tr = document.createElement("tr");
    if (item.selected) tr.className = "checked";
    tr.innerHTML = `
      <td><input type="checkbox" data-id="${item.awemeId}" ${item.selected ? "checked" : ""}></td>
      <td class="num">${index}</td>
      <td class="thumb">${thumbCell(item)}</td>
      <td><span class="name-cell" title="${escapeHtml(item.desc || item.title)}">${escapeHtml(item.title)}</span></td>
      <td><a class="url-cell" href="${item.shareUrl}" target="_blank" rel="noopener">${item.shareUrl.replace("https://www.", "")}</a></td>
      <td class="num">${num(item.stats?.comment)}</td>
      <td class="num">${num(item.stats?.like)}</td>
      <td class="num">${num(item.stats?.share)}</td>
      <td>douyin</td>
      <td class="num">${duration(item.duration)}</td>
      <td><span class="state ${item.state || "wait"}" title="${escapeHtml(item.error || "")}">${stateLabel(item)}</span></td>`;
    fragment.appendChild(tr);
  });
  ui.body.appendChild(fragment);

  ui.empty.hidden = visible.length > 0;
  ui.rowsInfo.textContent = `Hiển thị ${visible.length} / ${items.length} dữ liệu`;
  watchThumbs();
  updateStats();
}

/** Ảnh cover load thẳng từ CDN Douyin — CDN này không chặn hotlink. */
function thumbCell(item) {
  if (!item.cover) return "";
  return `<a href="${item.shareUrl}" target="_blank" rel="noopener" title="Mở video trên Douyin">` +
    `<img data-src="${escapeHtml(item.cover)}" alt="" decoding="async" ` +
    `onerror="this.dataset.broken=1"></a>`;
}

// `loading="lazy"` không chịu kích hoạt cho ảnh nằm trong khung cuộn riêng của
// bảng, nên tự quan sát: chỉ nạp ảnh khi dòng thật sự lọt vào khung đó.
const thumbObserver = new IntersectionObserver((entries, observer) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const img = entry.target;
    img.src = img.dataset.src;
    delete img.dataset.src;
    observer.unobserve(img);
  }
}, { root: document.querySelector(".table-scroll"), rootMargin: "300px" });

function watchThumbs() {
  for (const img of ui.body.querySelectorAll("img[data-src]")) thumbObserver.observe(img);
}

function stateLabel(item) {
  if (item.state === "run") return item.progress ? `${item.progress}%` : "đang tải…";
  if (item.state === "done") return `✓ ${bytes(item.size) || "xong"}`;
  if (item.state === "err") return "✗ lỗi";
  if (item.state === "skip") return "bỏ qua";
  return "chờ";
}

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function updateStats() {
  const selected = items.filter((item) => item.selected).length;
  const done = items.filter((item) => item.state === "done").length;
  const failed = items.filter((item) => item.state === "err").length;
  ui.statTotal.textContent = items.length;
  ui.statSelected.textContent = selected;
  ui.statDone.textContent = done;
  ui.statFail.textContent = failed;
  ui.statFailWrap.hidden = failed === 0;
  const visible = filteredItems();
  ui.checkAll.checked = visible.length > 0 && visible.every((item) => item.selected);
}

/** Cập nhật 1 dòng thay vì render lại cả bảng — tránh giật khi tải song song. */
function refreshRow(item) {
  const index = filteredItems().indexOf(item);
  if (index < 0) return;
  const tr = ui.body.children[index];
  if (!tr) return;
  const cell = tr.lastElementChild.firstElementChild;
  cell.className = `state ${item.state || "wait"}`;
  cell.title = item.error || "";
  cell.textContent = stateLabel(item);
}

function addItems(list) {
  const seen = new Set(items.map((item) => item.awemeId));
  let added = 0;
  for (const raw of list) {
    if (!raw?.awemeId || seen.has(raw.awemeId)) continue;
    seen.add(raw.awemeId);
    items.push({ ...raw, selected: true, state: "wait", progress: 0, error: "", size: 0 });
    added++;
  }
  render();
  return added;
}

/* ═══════════════════════ cookie qua extension ═══════════════════════ */

/** Extension đặt cờ này lên <html> ngay khi trang bắt đầu load. */
const hasCookieBridge = () => document.documentElement.hasAttribute("data-douyin-cookie-bridge");

/** Hỏi extension lấy cookie douyin.com hiện tại của trình duyệt. */
function requestCookieFromExtension(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("Extension không trả lời — thử tải lại trang."));
    }, timeoutMs);

    function onMessage(event) {
      if (event.source !== window || event.data?.type !== "DOUYIN_COOKIE_RESULT") return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data);
    }

    window.addEventListener("message", onMessage);
    window.postMessage({ type: "DOUYIN_COOKIE_REQUEST" }, window.location.origin);
  });
}

async function grabCookie() {
  const button = el("grabCookie");
  button.disabled = true;
  status(ui.scanStatus, "Đang lấy cookie từ trình duyệt…", "run");
  try {
    const result = await requestCookieFromExtension();
    if (!result.cookie) throw new Error("Trình duyệt chưa có cookie douyin.com nào.");
    el("cookie").value = result.cookie;
    savePrefs();
    status(
      ui.scanStatus,
      result.loggedIn
        ? `Đã lấy cookie (${result.count} mục) — đang đăng nhập, quét được đầy đủ.`
        : `Đã lấy cookie (${result.count} mục) nhưng chưa thấy phiên đăng nhập — ` +
          `đăng nhập douyin.com rồi bấm lại thì mới quét quá 42 video.`,
      result.loggedIn ? "ok" : "err",
    );
  } catch (err) {
    status(ui.scanStatus, `Không lấy được cookie: ${err.message}`, "err");
  } finally {
    button.disabled = false;
  }
}

/* ═══════════════════════ quét user ═══════════════════════ */

async function startScan() {
  const input = el("profileUrl").value.trim();
  if (!input) return status(ui.scanStatus, "Chưa nhập link profile.", "err");

  const limit = Math.max(1, Number(el("scanMax").value) || 200);
  el("startScan").disabled = true;
  savePrefs();

  let cursor = 0;
  let total = 0;
  let page = 0;
  let limited = false;
  const mixes = new Map();
  try {
    status(ui.scanStatus, "Đang đọc thông tin kênh…", "run");
    let owner = "";
    let expected = 0;
    try {
      const info = await callApi({ action: "userinfo", url: input });
      expected = Number(info.user?.awemeCount) || 0;
      owner = info.user?.nickname ? `${info.user.nickname} (${info.user.awemeCount ?? "?"} video)` : "";
    } catch {
      // Không lấy được profile thì vẫn quét bình thường, chỉ mất phần hiển thị.
    }

    while (total < limit) {
      status(ui.scanStatus, `Đang quét ${owner}… (${total} video)`, "run");
      const payload = await callApi({
        action: "user",
        url: input,
        cursor,
        count: Math.min(PAGE_SIZE, limit - total),
      });
      const added = addItems(payload.items || []);
      total += payload.items?.length || 0;
      page++;
      cursor = payload.cursor;
      limited = Boolean(payload.limited);
      for (const mix of payload.mixes || []) if (!mixes.has(mix.mixId)) mixes.set(mix.mixId, mix);
      if (limited || !payload.hasMore || !payload.items?.length || !cursor) break;
      if (added === 0 && page > 1) break; // cursor lặp → dừng để không loop vô hạn
    }

    // `aweme/post` chặn khách vãng lai ở ~42 video, nhưng tuyển tập thì phân
    // trang bình thường — vét nốt bên đó để bù phần bị cắt.
    if (limited && mixes.size && items.length < limit) {
      await scanMixes([...mixes.values()], limit, owner);
    }

    // Thiếu so với số kênh khai thì nguyên nhân khác hẳn nhau: chưa có cookie
    // là do Douyin cắt bớt, còn đã có cookie thì phần chênh gần như luôn là
    // video đã ẩn hoặc xoá — `awemeCount` vẫn đếm chúng.
    const shortfall = expected > 0 && items.length < expected;
    const hasCookie = Boolean(el("cookie").value.trim());
    let message = `Xong: ${items.length} video trong danh sách${owner ? ` — ${owner}` : ""}.`;
    if (shortfall && !hasCookie) {
      message = `Xong: ${items.length}/${expected} video${owner ? ` — ${owner}` : ""}. ` +
        `Douyin chỉ trả chừng này cho khách vãng lai — dùng cookie để lấy nốt.`;
    } else if (shortfall) {
      message = `Xong: ${items.length}/${expected} video${owner ? ` — ${owner}` : ""} ` +
        `(phần chênh thường là video đã ẩn hoặc xoá).`;
    }
    status(ui.scanStatus, message, shortfall && !hasCookie ? "run" : "ok");
  } catch (err) {
    status(ui.scanStatus, `Lỗi quét: ${err.message}`, "err");
  } finally {
    el("startScan").disabled = false;
  }
}

/**
 * Vét từng tuyển tập của kênh. Trả về `true` nếu vẫn còn video Douyin không
 * chịu trả (tức là danh sách vẫn thiếu).
 */
async function scanMixes(list, limit, owner) {
  let stillLimited = false;
  for (const mix of list) {
    let cursor = 0;
    for (let page = 0; page < 40 && items.length < limit; page++) {
      status(
        ui.scanStatus,
        `Đang vét tuyển tập "${mix.name || mix.mixId}"${mix.total ? ` (${mix.total} tập)` : ""}… ` +
          `${items.length} video${owner ? ` — ${owner}` : ""}`,
        "run",
      );
      let payload;
      try {
        payload = await callApi({ action: "mix", mixId: mix.mixId, cursor });
      } catch (err) {
        // Bị chặn giữa chừng thì giữ những gì đã lấy được, đừng vứt cả lượt quét.
        console.warn("mix scan dừng sớm", mix.mixId, err);
        return true;
      }
      addItems(payload.items || []);
      cursor = payload.cursor;
      if (!payload.hasMore || !payload.items?.length) break;
      if (page === 39) stillLimited = true; // tuyển tập quá dài, dừng cho an toàn
      await sleep(700); // Douyin trả 403 nếu bắn liên tục không nghỉ
    }
  }
  return stillLimited;
}

/* ═══════════════════════ nhập / xuất link ═══════════════════════ */

async function resolveLinks(links) {
  const unique = [...new Set(links.map((link) => link.trim()).filter(Boolean))];
  if (!unique.length) return;

  const threads = Math.max(1, Number(el("threads").value) || 4);
  let done = 0;
  let failed = 0;
  status(ui.scanStatus, `Đang lấy metadata 0/${unique.length}…`, "run");

  const queue = unique.slice();
  const profiles = new Set();
  await Promise.all(Array.from({ length: Math.min(threads, queue.length) }, async () => {
    while (queue.length) {
      const link = queue.shift();
      try {
        const payload = await callApi({ action: "resolve", url: link });
        addItems([payload.item]);
      } catch (err) {
        failed++;
        // Link share profile: nhận sec_uid từ function, đưa sang phần quét user.
        if (err.payload?.kind === "user" && err.payload.secUid) profiles.add(err.payload.secUid);
        console.warn("resolve failed", link, err);
      }
      done++;
      status(ui.scanStatus, `Đang lấy metadata ${done}/${unique.length}…`, "run");
    }
  }));

  if (profiles.size) {
    // Link share profile chứ không phải share video — quét thẳng luôn cho gọn.
    el("profileUrl").value = [...profiles].join("\n");
    savePrefs();
    await startScan();
    return;
  }

  status(
    ui.scanStatus,
    failed ? `Xong: ${done - failed} link OK, ${failed} link lỗi.` : `Xong: ${done} link.`,
    failed ? "err" : "ok",
  );
}

function exportLinks() {
  const chosen = items.filter((item) => item.selected);
  const source = chosen.length ? chosen : items;
  if (!source.length) return status(ui.scanStatus, "Danh sách trống, không có gì để xuất.", "err");

  const lines = ["url,title,likes,comments,shares,aweme_id,cover"];
  for (const item of source) {
    lines.push([
      item.shareUrl,
      `"${(item.title || "").replace(/"/g, "'")}"`,
      item.stats?.like ?? "",
      item.stats?.comment ?? "",
      item.stats?.share ?? "",
      item.awemeId,
      item.cover ?? "",
    ].join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `douyin_links_${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
  status(ui.scanStatus, `Đã xuất ${source.length} link.`, "ok");
}

/* ═══════════════════════ tải video ═══════════════════════ */

function passesFilter(item) {
  if (!el("useFilter").checked) return true;
  const minLike = Number(el("minLike").value) || 0;
  // Không lọc theo lượt phát: Douyin không trả số đó qua web, luôn là 0.
  return (item.stats?.like ?? 0) >= minLike;
}

function fileName(item, index) {
  const mode = el("naming").value;
  const base = mode === "id"
    ? item.awemeId
    : mode === "index_title"
      ? `${String(index).padStart(3, "0")}_${sanitize(item.title)}`
      : sanitize(item.title);
  return `${base}.mp4`;
}

async function pickFolder() {
  if (!window.showDirectoryPicker) {
    return status(ui.scanStatus, "Trình duyệt này không hỗ trợ chọn thư mục (cần Chrome/Edge).", "err");
  }
  try {
    dirHandle = await window.showDirectoryPicker({ mode: "readwrite", id: "douyin-dl" });
    el("folderName").value = dirHandle.name;
    document.querySelector('input[name="dest"][value="folder"]').checked = true;
    savePrefs();
  } catch {
    /* user huỷ hộp thoại */
  }
}

/** Function trả JSON {error} khi CDN từ chối — đọc ra để biết lý do thật. */
async function fetchVideo(item, filename, signal) {
  const response = await fetch(downloadUrl(item, filename), { signal });
  if (response.ok) return response;
  const detail = await response.json().catch(() => null);
  throw new Error(detail?.error || `HTTP ${response.status}`);
}

async function saveToFolder(item, filename, signal) {
  const response = await fetchVideo(item, filename, signal);

  const total = Number(response.headers.get("content-length")) || 0;
  const handle = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await handle.createWritable();
  const reader = response.body.getReader();
  let received = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      received += value.byteLength;
      if (total) {
        const percent = Math.round((received / total) * 100);
        if (percent !== item.progress) {
          item.progress = percent;
          refreshRow(item);
        }
      }
    }
    await writable.close();
  } catch (err) {
    await writable.abort().catch(() => {});
    throw err;
  }
  return received;
}

async function saveViaBrowser(item, filename, signal) {
  const response = await fetchVideo(item, filename, signal);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return blob.size;
}

async function startDownload() {
  if (downloading) return;
  savePrefs();

  const queue = items.filter((item) => item.selected && item.videoUrl && item.state !== "done");
  if (!queue.length) return status(ui.scanStatus, "Không có video nào được chọn để tải.", "err");

  const useFolder = destValue() === "folder";
  if (useFolder && !dirHandle) {
    await pickFolder();
    if (!dirHandle) return;
  }

  downloading = true;
  abortAll = new AbortController();
  el("startDownload").disabled = true;
  el("stopDownload").hidden = false;
  ui.progressWrap.hidden = false;

  const threads = Math.min(Math.max(1, Number(el("threads").value) || 4), 8);
  const pending = queue.slice();
  let finished = 0;

  const tick = () => {
    const percent = Math.round((finished / queue.length) * 100);
    ui.progressBar.style.width = `${percent}%`;
    ui.progressText.textContent = `${finished}/${queue.length} video — ${percent}%`;
    updateStats();
  };
  tick();

  await Promise.all(Array.from({ length: Math.min(threads, pending.length) }, async () => {
    while (pending.length && !abortAll.signal.aborted) {
      const item = pending.shift();
      const index = items.indexOf(item) + 1;

      if (!passesFilter(item)) {
        item.state = "skip";
        refreshRow(item);
        finished++;
        tick();
        continue;
      }

      item.state = "run";
      item.progress = 0;
      item.error = "";
      refreshRow(item);

      const filename = fileName(item, index);
      try {
        item.size = useFolder
          ? await saveToFolder(item, filename, abortAll.signal)
          : await saveViaBrowser(item, filename, abortAll.signal);
        item.state = "done";
      } catch (err) {
        item.state = abortAll.signal.aborted ? "wait" : "err";
        item.error = err.message || String(err);
      }
      refreshRow(item);
      finished++;
      tick();
    }
  }));

  downloading = false;
  el("startDownload").disabled = false;
  el("stopDownload").hidden = true;
  const done = items.filter((item) => item.state === "done").length;
  const failed = items.filter((item) => item.state === "err").length;
  status(
    ui.scanStatus,
    abortAll.signal.aborted
      ? `Đã dừng. Thành công ${done}, lỗi ${failed}.`
      : `Tải xong: ${done} thành công${failed ? `, ${failed} lỗi` : ""}.`,
    failed ? "err" : "ok",
  );
}

/* ═══════════════════════ events ═══════════════════════ */

function syncFilterVisibility() {
  el("filterGrid").hidden = !el("useFilter").checked;
  const supported = Boolean(window.showDirectoryPicker);
  el("pickFolder").disabled = !supported;
  el("fsHint").textContent = supported
    ? "Lưu trực tiếp vào thư mục: stream từng chunk ra file, không ngốn RAM."
    : "Trình duyệt này không có File System Access API — chỉ tải về thư mục Downloads (dùng Chrome/Edge để chọn thư mục).";
}

el("grabCookie").hidden = !hasCookieBridge();
el("grabCookie").addEventListener("click", grabCookie);
el("clearCookie").addEventListener("click", () => {
  el("cookie").value = "";
  savePrefs();
  status(ui.scanStatus, "Đã xoá cookie khỏi trình duyệt này.", "ok");
});

el("startScan").addEventListener("click", startScan);
el("startDownload").addEventListener("click", startDownload);
el("stopDownload").addEventListener("click", () => abortAll?.abort());
el("pickFolder").addEventListener("click", pickFolder);
el("exportLinks").addEventListener("click", exportLinks);
el("useFilter").addEventListener("change", () => {
  syncFilterVisibility();
  savePrefs();
});
for (const id of ["threads", "naming", "scanMax", "minLike", "profileUrl", "cookie"]) {
  el(id).addEventListener("change", savePrefs);
}
for (const radio of document.querySelectorAll('input[name="dest"]')) {
  radio.addEventListener("change", savePrefs);
}


/** Bookmarklet mở tool kèm ID (#import=...) — tự resolve metadata ngay khi load. */
async function importFromHash() {
  const match = location.hash.match(/[#&]import=([^&]+)/);
  if (!match) return;
  history.replaceState(null, "", location.pathname + location.search);

  const links = decodeURIComponent(match[1])
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((token) => (/^\d{15,25}$/.test(token) ? `https://www.douyin.com/video/${token}` : token));
  if (!links.length) return;

  el("importCard").open = true;
  el("linkInput").value = links.join("\n");
  await resolveLinks(links);
}

// Text share của app Douyin dính liền chữ Trung + tham số tracking, nên bắt URL
// bằng regex thay vì tách token theo khoảng trắng.
const LINK_RE = /(?:https?:\/\/)?(?:v\.douyin\.com|(?:www\.)?douyin\.com|(?:www\.)?iesdouyin\.com)\/[^\s"'<>()，。、【】\[\]]+/gi;
const SEC_UID_RE = /MS4wLjABAAAA[A-Za-z0-9_\-.]{10,120}/;

function linksFromText(text) {
  const found = new Set();
  for (const match of text.matchAll(LINK_RE)) {
    const url = match[0].replace(/[.,;、。)\]]+$/, "");
    found.add(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  }
  // Chỉ quét ID trần ở phần text không phải URL — nếu không sẽ bắt cả
  // from_user_id/social_share_id trong query string.
  const rest = text.replace(LINK_RE, " ");
  for (const match of rest.matchAll(/\d{15,25}/g)) {
    found.add(`https://www.douyin.com/video/${match[0]}`);
  }
  return [...found];
}

/** Dán text share → box chỉ còn link đã xử lý, mỗi dòng 1 link. */
function normalizeLinkBox() {
  const box = el("linkInput");
  const links = linksFromText(box.value);
  if (!links.length) return;
  const cleaned = links.join("\n");
  if (cleaned === box.value.trim()) return;
  box.value = cleaned;
  status(ui.scanStatus, `Đã tách ${links.length} link từ nội dung dán.`, "ok");
}

/** Ô Người dùng: giữ lại sec_uid hoặc link profile, bỏ hết chữ và tracking. */
function normalizeProfileBox() {
  const box = el("profileUrl");
  const raw = box.value;
  if (!raw.trim()) return;

  const secUid = raw.match(SEC_UID_RE);
  if (secUid) {
    const cleaned = `https://www.douyin.com/user/${secUid[0]}`;
    if (cleaned !== raw.trim()) {
      box.value = cleaned;
      status(ui.scanStatus, "Đã tách link profile từ nội dung dán.", "ok");
      savePrefs();
    }
    return;
  }

  const links = linksFromText(raw);
  if (links.length && links[0] !== raw.trim()) {
    box.value = links[0];
    status(ui.scanStatus, "Đã tách link profile từ nội dung dán.", "ok");
    savePrefs();
  }
}

async function importFromText(text) {
  const links = linksFromText(text);
  if (!links.length) return status(ui.scanStatus, "Không tìm thấy link Douyin hợp lệ trong nội dung dán.", "err");
  await resolveLinks(links);
}

el("focusImport").addEventListener("click", () => {
  el("importCard").open = true;
  el("linkInput").focus();
  el("importCard").scrollIntoView({ behavior: "smooth", block: "center" });
});

el("resolvePasted").addEventListener("click", () => {
  normalizeLinkBox();
  return importFromText(el("linkInput").value);
});

// setTimeout 0: chờ nội dung paste vào DOM rồi mới chuẩn hoá.
el("linkInput").addEventListener("paste", () => setTimeout(normalizeLinkBox, 0));
el("linkInput").addEventListener("blur", normalizeLinkBox);
el("profileUrl").addEventListener("paste", () => setTimeout(normalizeProfileBox, 0));
el("profileUrl").addEventListener("blur", normalizeProfileBox);


el("importFileBtn").addEventListener("click", () => el("importFile").click());
el("importFile").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  await importFromText(await file.text());
  event.target.value = "";
});

ui.filterBox.addEventListener("input", render);

ui.checkAll.addEventListener("change", () => {
  const visible = filteredItems();
  for (const item of visible) item.selected = ui.checkAll.checked;
  render();
});

ui.body.addEventListener("change", (event) => {
  const box = event.target.closest('input[type="checkbox"][data-id]');
  if (!box) return;
  const item = items.find((entry) => entry.awemeId === box.dataset.id);
  if (!item) return;
  item.selected = box.checked;
  box.closest("tr").classList.toggle("checked", box.checked);
  updateStats();
});

el("selectFiltered").addEventListener("click", () => {
  for (const item of filteredItems()) item.selected = true;
  render();
});
el("clearSelection").addEventListener("click", () => {
  for (const item of items) item.selected = false;
  render();
});
el("clearList").addEventListener("click", () => {
  if (downloading) return;
  if (items.length && !confirm(`Xoá ${items.length} video khỏi danh sách?`)) return;
  items = [];
  render();
});

el("openSettings").addEventListener("click", () => {
  el("settingsCard").open = true;
  el("settingsCard").scrollIntoView({ behavior: "smooth", block: "center" });
});
el("resetEndpoint").addEventListener("click", () => {
  el("endpoint").value = DEFAULT_ENDPOINT;
  savePrefs();
  status(ui.endpointStatus, "Đã về endpoint mặc định.", "ok");
});
el("endpoint").addEventListener("change", savePrefs);
el("testEndpoint").addEventListener("click", async () => {
  status(ui.endpointStatus, "Đang kiểm tra…", "run");
  try {
    const payload = await callApi({ action: "health" });
    status(ui.endpointStatus, `OK — ttwid: ${payload.ttwid}`, payload.ttwid === "ok" ? "ok" : "err");
  } catch (err) {
    status(ui.endpointStatus, `Lỗi: ${err.message}`, "err");
  }
});

loadPrefs();
render();
importFromHash();
