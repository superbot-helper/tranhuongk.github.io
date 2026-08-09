"use strict";

// Mọi request Douyin đi qua edge function này (resolve / user / download).
const DEFAULT_ENDPOINT = "https://lnazpyhoojqotnanrvqf.supabase.co/functions/v1/douyin";
const LS_KEY = "douyin_dl_prefs_v1";
const TR_KEY = "douyin_title_vi_v1";
const PAGE_SIZE = 50; // Douyin trần ~42 item cho request không đăng nhập
const TR_BATCH = 200; // trần mỗi lượt gọi action=translate của function
const TR_CACHE_MAX = 3000;

/**
 * Các tiêu chí lọc có thể thêm. `pick` lấy số cần so từ item; `kind` quyết định
 * so sánh ≥ hay ≤. Không có "lượt phát": Douyin không trả số đó qua web.
 */
const FILTER_TYPES = [
  { key: "minLike", label: "Lượt thích ≥", kind: "min", hint: "vd 1000", pick: (i) => i.stats?.like ?? 0 },
  { key: "minComment", label: "Bình luận ≥", kind: "min", hint: "vd 50", pick: (i) => i.stats?.comment ?? 0 },
  { key: "minShare", label: "Lượt chia sẻ ≥", kind: "min", hint: "vd 100", pick: (i) => i.stats?.share ?? 0 },
  { key: "minCollect", label: "Lượt lưu ≥", kind: "min", hint: "vd 100", pick: (i) => i.stats?.collect ?? 0 },
  { key: "minDuration", label: "Thời lượng ≥", kind: "min", hint: "giây", pick: (i) => (i.duration ?? 0) / 1000 },
  { key: "maxDuration", label: "Thời lượng ≤", kind: "max", hint: "giây", pick: (i) => (i.duration ?? 0) / 1000 },
  { key: "fromDate", label: "Đăng từ ngày", kind: "min", type: "date", pick: (i) => i.createTime },
  { key: "toDate", label: "Đăng đến ngày", kind: "max", type: "date", pick: (i) => i.createTime },
];

const filterType = (key) => FILTER_TYPES.find((entry) => entry.key === key);

/** @type {Array<{key: string, value: string}>} tiêu chí đang bật, theo thứ tự thêm */
let activeFilters = [];

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
  el("links").value = prefs.links ?? prefs.profileUrl ?? "";
  el("cookie").value = prefs.cookie || "";
  el("scanMax").value = prefs.scanMax || 200;
  el("threads").value = prefs.threads || 4;
  el("naming").value = prefs.naming || "title";
  // Bỏ qua tiêu chí lạ/trùng: FILTER_TYPES đổi thì prefs cũ vẫn nạp được.
  const seen = new Set();
  activeFilters = (Array.isArray(prefs.filters) ? prefs.filters : [])
    .filter((entry) => filterType(entry?.key) && !seen.has(entry.key) && seen.add(entry.key))
    .map((entry) => ({ key: entry.key, value: String(entry.value ?? "") }));
  if (prefs.sortKey && SORT_VALUES[prefs.sortKey]) sortKey = prefs.sortKey;
  if (prefs.sortDir === "asc" || prefs.sortDir === "desc") sortDir = prefs.sortDir;
  const dest = prefs.dest === "folder" ? "folder" : "browser";
  document.querySelector(`input[name="dest"][value="${dest}"]`).checked = true;
  syncFilterVisibility();
}

function savePrefs() {
  const prefs = {
    links: el("links").value.trim(),
    cookie: el("cookie").value.trim(),
    scanMax: Number(el("scanMax").value),
    threads: Number(el("threads").value),
    naming: el("naming").value,
    filters: activeFilters,
    sortKey,
    sortDir,
    dest: destValue(),
  };
  localStorage.setItem(LS_KEY, JSON.stringify(prefs));
}

// Không còn ô nhập endpoint; ?endpoint=... chỉ để trỏ sang function local khi dev.
const endpoint = () =>
  (new URLSearchParams(location.search).get("endpoint") || DEFAULT_ENDPOINT).replace(/\/+$/, "");
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

/** `create_time` của Douyin là unix giây. */
function postedDate(seconds) {
  if (!seconds) return "-";
  const date = new Date(seconds * 1000);
  // Ép 2 chữ số để cột ngày thẳng hàng: "02/08/2026" chứ không phải "2/8/2026".
  return Number.isNaN(date.getTime())
    ? "-"
    : date.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function bytes(size) {
  if (!size) return "";
  const mb = size / 1048576;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(size / 1024)} KB`;
}

function sanitize(name) {
  return name
    .replace(/[\\/:*?"<>|\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    // Câu tiếng Việt hay kết thúc bằng dấu chấm → "tên..mp4"; Windows cũng cấm
    // tên file kết thúc bằng dấu chấm hoặc khoảng trắng.
    .replace(/[.\s]+$/, "") || "video";
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function status(node, text, kind) {
  node.textContent = text;
  node.className = `status${kind ? ` ${kind}` : ""}`;

  // Trên mobile dòng này nằm trong card cấu hình, khuất khỏi tầm nhìn khi bạn
  // đang ở thanh đáy — nên lỗi phải hiện ngay tại chỗ vừa bấm.
  if (node === ui.scanStatus) {
    el("barError").textContent = kind === "err" ? text : "";
    el("barError").hidden = kind !== "err";
    el("barCount").hidden = kind === "err";
  }
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

/* ═══════════════════════ dịch tiêu đề ═══════════════════════ */

// Tiêu đề Douyin gần như luôn là tiếng Trung. Dịch sẵn ngay sau khi quét để cả
// bảng lẫn tên file tải về đều đọc được, bản gốc giữ trong tooltip.
const CJK_RE = /[㐀-䶿一-鿿぀-ヿ가-힯]/;
const needsTranslate = (text) => CJK_RE.test(text || "");
const displayTitle = (item) => item.titleVi || item.title;

/** Cache theo nguyên văn tiêu đề — quét lại cùng kênh thì không dịch lại. */
function loadTitleCache() {
  try {
    return new Map(Object.entries(JSON.parse(localStorage.getItem(TR_KEY) || "{}")));
  } catch {
    return new Map();
  }
}

const titleCache = loadTitleCache();

function saveTitleCache() {
  // Map giữ thứ tự chèn nên cắt từ đầu là bỏ đúng những mục cũ nhất.
  const entries = [...titleCache.entries()].slice(-TR_CACHE_MAX);
  try {
    localStorage.setItem(TR_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // localStorage đầy — cache mất thì chỉ tốn thêm request dịch, không sao.
  }
}

async function callTranslate(texts) {
  const url = new URL(endpoint());
  url.searchParams.set("action", "translate");
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) throw new Error(payload.error || `HTTP ${response.status}`);
  return Array.isArray(payload.texts) ? payload.texts : [];
}

/**
 * Dịch tiêu đề của `list`. Dịch lỗi thì im lặng giữ nguyên bản gốc — mất phần
 * dịch chứ không được làm hỏng cả lượt quét.
 */
async function translateTitles(list, onProgress) {
  const missing = [];
  const seen = new Set();
  for (const item of list) {
    if (item.titleVi || !needsTranslate(item.title)) continue;
    const hit = titleCache.get(item.title);
    if (hit) {
      item.titleVi = hit;
      continue;
    }
    if (seen.has(item.title)) continue;
    seen.add(item.title);
    missing.push(item.title);
  }
  if (!missing.length) return render();

  let done = 0;
  for (let start = 0; start < missing.length; start += TR_BATCH) {
    const batch = missing.slice(start, start + TR_BATCH);
    onProgress?.(done, missing.length);
    try {
      const translated = await callTranslate(batch);
      batch.forEach((text, index) => {
        const vi = translated[index];
        if (vi && vi !== text) titleCache.set(text, vi);
      });
    } catch (err) {
      console.warn("dịch tiêu đề lỗi", err);
      break;
    }
    done += batch.length;
  }

  for (const item of list) {
    if (!item.titleVi) item.titleVi = titleCache.get(item.title) || "";
  }
  saveTitleCache();
  render();
}

/* ═══════════════════════ render ═══════════════════════ */

// Thứ tự hiển thị: lọc trước rồi sắp xếp. `index` là thứ tự nạp vào ban đầu nên
// bấm STT là về lại trạng thái gốc.
const SORT_VALUES = {
  index: (item) => items.indexOf(item),
  title: (item) => displayTitle(item).toLowerCase(),
  comment: (item) => item.stats?.comment ?? -1,
  like: (item) => item.stats?.like ?? -1,
  share: (item) => item.stats?.share ?? -1,
  duration: (item) => item.duration ?? -1,
  date: (item) => item.createTime ?? -1,
  state: (item) => item.state || "wait",
};

let sortKey = "index";
let sortDir = "asc";

function filteredItems() {
  const query = ui.filterBox.value.trim().toLowerCase();
  // Gõ tiếng Việt hay tiếng Trung đều tìm được: khớp cả bản dịch lẫn bản gốc.
  const matched = query
    ? items.filter((item) => displayTitle(item).toLowerCase().includes(query) ||
      (item.title || "").toLowerCase().includes(query) ||
      (item.awemeId || "").includes(query))
    : items.slice();

  const value = SORT_VALUES[sortKey] ?? SORT_VALUES.index;
  const sign = sortDir === "asc" ? 1 : -1;
  return matched.sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === vb) return SORT_VALUES.index(a) - SORT_VALUES.index(b); // giữ thứ tự gốc khi bằng nhau
    return typeof va === "string" ? sign * va.localeCompare(vb, "vi") : sign * (va - vb);
  });
}

function applySort(key) {
  if (sortKey === key) {
    sortDir = sortDir === "asc" ? "desc" : "asc";
  } else {
    sortKey = key;
    // Số/thời lượng thường muốn xem cao nhất trước; text thì A→Z.
    sortDir = key === "title" || key === "index" || key === "state" ? "asc" : "desc";
  }
  savePrefs();
  render();
}

function paintSortHeaders() {
  for (const button of document.querySelectorAll("th .sort")) {
    const active = button.dataset.sort === sortKey;
    button.classList.toggle("active", active);
    button.dataset.dir = active ? sortDir : "";
    button.title = active
      ? `Đang sắp xếp ${sortDir === "asc" ? "tăng dần" : "giảm dần"} — bấm để đảo`
      : "Bấm để sắp xếp theo cột này";
  }
}

function render() {
  const visible = filteredItems();
  ui.body.innerHTML = "";

  const fragment = document.createDocumentFragment();
  visible.forEach((item) => {
    const index = items.indexOf(item) + 1;
    const tr = document.createElement("tr");
    if (item.selected) tr.className = "checked";
    // `data-label` để CSS mobile biết ô nào ẩn, ô nào gộp thành dòng số liệu.
    tr.innerHTML = `
      <td><input type="checkbox" data-id="${item.awemeId}" ${item.selected ? "checked" : ""}></td>
      <td class="num" data-label="STT">${index}</td>
      <td class="thumb">${thumbCell(item)}</td>
      <td data-label="Tên video"><span class="name-cell" title="${escapeHtml(item.desc || item.title)}">${escapeHtml(displayTitle(item))}</span></td>
      <td data-label="URL Video"><a class="url-cell" href="${item.shareUrl}" target="_blank" rel="noopener">${item.shareUrl.replace("https://www.", "")}</a></td>
      <td class="num" data-label="Bình luận">${num(item.stats?.comment)}</td>
      <td class="num" data-label="Lượt thích">${num(item.stats?.like)}</td>
      <td class="num" data-label="Lượt chia sẻ">${num(item.stats?.share)}</td>
      <td class="num" data-label="Thời lượng">${duration(item.duration)}</td>
      <td class="num" data-label="Ngày đăng">${postedDate(item.createTime)}</td>
      <td data-label="Trạng thái"><span class="state ${item.state || "wait"}" title="${escapeHtml(item.error || "")}">${stateLabel(item)}</span></td>
      <td class="row-dl">${rowDownloadLink(item, index)}</td>`;
    fragment.appendChild(tr);
  });
  ui.body.appendChild(fragment);

  ui.empty.hidden = visible.length > 0;
  ui.rowsInfo.textContent = `Hiển thị ${visible.length} / ${items.length} dữ liệu`;
  paintSortHeaders();
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
  el("barSelected").textContent = selected;
  ui.statDone.textContent = done;
  ui.statFail.textContent = failed;
  ui.statFailWrap.hidden = failed === 0;
  const visible = filteredItems();
  ui.checkAll.checked = visible.length > 0 && visible.every((item) => item.selected);
}

/**
 * Cập nhật 1 dòng thay vì render lại cả bảng — tránh giật khi tải song song.
 * Tìm dòng theo `data-id` chứ không theo vị trí: khi đang sort theo Trạng thái,
 * state vừa đổi là thứ tự đã khác, map theo index sẽ tô sai dòng.
 */
function refreshRow(item) {
  const box = ui.body.querySelector(`input[data-id="${item.awemeId}"]`);
  const tr = box?.closest("tr");
  if (!tr) return;
  // Tìm theo class chứ không theo vị trí: ô cuối dòng giờ là nút Tải.
  const cell = tr.querySelector(".state");
  if (!cell) return;
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

/* ═══════════════════════ quét ═══════════════════════ */

/**
 * Link rút gọn (v.douyin.com/xxx) chưa nói được nó dẫn tới đâu — cứ thử resolve
 * như link video, function sẽ trả `kind: "user"` nếu hoá ra là link kênh.
 */
function classifyLink(text) {
  if (SEC_UID_RE.test(text) || /\/user\//i.test(text)) return "user";
  return "video";
}

/**
 * Lấy metadata cho các link video. Trả về sec_uid của những link hoá ra là
 * link kênh, để caller quét tiếp bên đó.
 */
async function resolveVideoLinks(links, limit) {
  const threads = Math.max(1, Number(el("threads").value) || 4);
  const queue = links.slice();
  const profiles = new Set();
  let done = 0;
  let failed = 0;

  await Promise.all(Array.from({ length: Math.min(threads, queue.length) }, async () => {
    while (queue.length && items.length < limit) {
      const link = queue.shift();
      status(ui.scanStatus, `Đang lấy metadata video ${done}/${links.length}…`, "run");
      try {
        const payload = await callApi({ action: "resolve", url: link });
        addItems(withinLimit([payload.item], limit));
      } catch (err) {
        if (err.payload?.kind === "user" && err.payload.secUid) profiles.add(err.payload.secUid);
        else failed++;
        console.warn("resolve failed", link, err);
      }
      done++;
    }
  }));

  return { profiles: [...profiles], failed };
}

/** Quét một kênh (kèm phần vét tuyển tập). */
async function scanUser(input, limit, label) {
  let owner = "";
  let expected = 0;
  try {
    const info = await callApi({ action: "userinfo", url: input });
    expected = Number(info.user?.awemeCount) || 0;
    owner = info.user?.nickname ? `${info.user.nickname} (${info.user.awemeCount ?? "?"} video)` : "";
  } catch {
    // Không lấy được profile thì vẫn quét bình thường, chỉ mất phần hiển thị.
  }

  let cursor = 0;
  let page = 0;
  let limited = false;
  const mixes = new Map();

  while (items.length < limit) {
    status(ui.scanStatus, `Đang quét ${label}${owner}… (${items.length} video)`, "run");
    const payload = await callApi({
      action: "user",
      url: input,
      cursor,
      count: Math.min(PAGE_SIZE, limit - items.length),
    });
    // Douyin trả nguyên lô bất kể `count` xin bao nhiêu, nên phải tự cắt —
    // nếu không thì "Quét tối đa 10" vẫn nạp về 42 video.
    const added = addItems(withinLimit(payload.items, limit));
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
  return { owner, expected };
}

async function startScan() {
  const lines = el("links").value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return status(ui.scanStatus, "Chưa nhập link nào.", "err");

  const limit = Math.max(1, Number(el("scanMax").value) || 200);
  el("startScan").disabled = true;
  savePrefs();

  // Mỗi lần quét là một danh sách mới — giữ kết quả cũ chỉ tổ trộn lẫn rồi tải nhầm.
  items = [];
  render();

  const users = lines.filter((line) => classifyLink(line) === "user");
  const videos = lines.filter((line) => classifyLink(line) === "video");
  let failed = 0;

  try {
    if (videos.length) {
      const result = await resolveVideoLinks(videos, limit);
      failed = result.failed;
      // Link share kênh trông y hệt link share video cho tới khi resolve xong.
      users.push(...result.profiles.filter((secUid) => !users.includes(secUid)));
    }

    const scanned = [];
    for (const [index, user] of users.entries()) {
      if (items.length >= limit) break;
      const label = users.length > 1 ? `kênh ${index + 1}/${users.length} ` : "";
      scanned.push(await scanUser(user, limit, label));
    }

    await translateTitles(items, (done, total) =>
      status(ui.scanStatus, `Đang dịch tiêu đề ${done}/${total}…`, "run"));

    status(ui.scanStatus, ...scanSummary(scanned, limit, failed));
  } catch (err) {
    status(ui.scanStatus, `Lỗi quét: ${err.message}`, "err");
  } finally {
    el("startScan").disabled = false;
  }
}

/** Câu tổng kết + màu; tách ra vì mỗi tình huống thiếu video có lý do khác nhau. */
function scanSummary(scanned, limit, failed) {
  const tail = failed ? ` (${failed} link lỗi)` : "";
  if (scanned.length !== 1) {
    const from = scanned.length ? ` từ ${scanned.length} kênh` : "";
    return [`Xong: ${items.length} video${from}${tail}.`, failed ? "err" : "ok"];
  }

  // Thiếu so với số kênh khai thì nguyên nhân khác hẳn nhau: chưa có cookie là
  // do Douyin cắt bớt, còn đã có cookie thì phần chênh gần như luôn là video đã
  // ẩn hoặc xoá — `awemeCount` vẫn đếm chúng.
  const { owner, expected } = scanned[0];
  const suffix = owner ? ` — ${owner}` : "";
  // Chạm trần "Quét tối đa" thì thiếu là do mình đặt, không phải Douyin cắt.
  const shortfall = expected > 0 && items.length < expected && items.length < limit;
  const hasCookie = Boolean(el("cookie").value.trim());

  if (shortfall && !hasCookie) {
    return [
      `Xong: ${items.length}/${expected} video${suffix}${tail}. ` +
      `Douyin chỉ trả chừng này cho khách vãng lai — dùng cookie để lấy nốt.`,
      "run",
    ];
  }
  if (shortfall) {
    return [
      `Xong: ${items.length}/${expected} video${suffix}${tail} (phần chênh thường là video đã ẩn hoặc xoá).`,
      "ok",
    ];
  }
  return [`Xong: ${items.length} video trong danh sách${suffix}${tail}.`, failed ? "err" : "ok"];
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
      addItems(withinLimit(payload.items, limit));
      if (items.length >= limit) break;
      cursor = payload.cursor;
      if (!payload.hasMore || !payload.items?.length) break;
      if (page === 39) stillLimited = true; // tuyển tập quá dài, dừng cho an toàn
      await sleep(700); // Douyin trả 403 nếu bắn liên tục không nghỉ
    }
  }
  return stillLimited;
}

/* ═══════════════════════ tải video ═══════════════════════ */

/**
 * Lọc theo ngưỡng rồi cắt cho vừa chỗ trống còn lại của "Quét tối đa".
 * Cả hai việc phải làm trước khi vào danh sách, vì Douyin trả theo lô của nó
 * chứ không theo số mình xin.
 */
function withinLimit(list, limit) {
  const room = Math.max(0, limit - items.length);
  return (list || []).filter(passesFilter).slice(0, room);
}

/**
 * Ngưỡng của một tiêu chí, `null` khi ô còn trống (chưa nhập thì chưa lọc).
 * Ngày quy về unix giây: mốc "từ" là 00:00, mốc "đến" là 23:59:59 cùng ngày,
 * tính theo giờ máy người dùng (không có "Z") — đúng cái họ vừa chọn.
 */
function filterLimit(type, raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  if (type.type === "date") {
    const ms = Date.parse(`${text}T${type.kind === "max" ? "23:59:59" : "00:00:00"}`);
    return Number.isFinite(ms) ? ms / 1000 : null;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function passesFilter(item) {
  for (const { key, value } of activeFilters) {
    const type = filterType(key);
    const limit = type && filterLimit(type, value);
    if (limit === null || limit === undefined) continue;

    const actual = type.pick(item);
    // Thiếu dữ liệu (ngày đăng rỗng) thì không thể khẳng định là đạt — loại ra.
    if (typeof actual !== "number") return false;
    if (type.kind === "min" ? actual < limit : actual > limit) return false;
  }
  return true;
}

/* ═══════════════════════ UI bộ lọc ═══════════════════════ */

function renderFilters() {
  const list = el("filterList");
  list.innerHTML = "";

  for (const entry of activeFilters) {
    const type = filterType(entry.key);
    if (!type) continue;
    const row = document.createElement("div");
    row.className = "filter-row";
    row.innerHTML = `
      <label class="lbl sm" for="f_${type.key}">${escapeHtml(type.label)}</label>
      <input id="f_${type.key}" type="${type.type || "number"}" ${type.type ? "" : 'min="0"'}
        placeholder="${escapeHtml(type.hint || "")}" value="${escapeHtml(entry.value)}">
      <button class="rm" data-remove="${type.key}" title="Bỏ tiêu chí này">✕</button>`;
    list.appendChild(row);
  }

  el("filterEmpty").hidden = activeFilters.length > 0;
  // Hết tiêu chí để thêm thì nút + không còn việc gì để làm.
  el("addFilter").disabled = activeFilters.length >= FILTER_TYPES.length;
}

function availableTypes() {
  const used = new Set(activeFilters.map((entry) => entry.key));
  return FILTER_TYPES.filter((type) => !used.has(type.key));
}

function toggleFilterMenu(open) {
  const menu = el("filterMenu");
  if (!open) return void (menu.hidden = true);

  menu.innerHTML = "";
  for (const type of availableTypes()) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.add = type.key;
    button.textContent = type.label;
    menu.appendChild(button);
  }
  menu.hidden = false;
}

el("addFilter").addEventListener("click", (event) => {
  event.stopPropagation();
  toggleFilterMenu(el("filterMenu").hidden);
});

el("filterMenu").addEventListener("click", (event) => {
  const key = event.target.closest("[data-add]")?.dataset.add;
  if (!key || activeFilters.some((entry) => entry.key === key)) return;
  activeFilters.push({ key, value: "" });
  toggleFilterMenu(false);
  renderFilters();
  savePrefs();
  el(`f_${key}`)?.focus();
});

// Bấm ra ngoài thì đóng menu — không có nút đóng riêng.
document.addEventListener("click", (event) => {
  if (!event.target.closest(".add-wrap")) toggleFilterMenu(false);
});

el("filterList").addEventListener("click", (event) => {
  const key = event.target.closest("[data-remove]")?.dataset.remove;
  if (!key) return;
  activeFilters = activeFilters.filter((entry) => entry.key !== key);
  renderFilters();
  savePrefs();
});

el("filterList").addEventListener("input", (event) => {
  const key = event.target.id?.replace(/^f_/, "");
  const entry = activeFilters.find((item) => item.key === key);
  if (!entry) return;
  entry.value = event.target.value;
  savePrefs();
});

// iOS Safari chỉ tải khi việc tải bắt đầu ngay trong cử chỉ chạm. Tải hàng
// loạt qua blob luôn xảy ra sau `await fetch()` nên bị chặn im lặng — link
// thật thì chạm phát tải luôn, không qua JS.
const isIOS = /iP(hone|ad|od)/.test(navigator.platform) ||
  (navigator.userAgent.includes("Mac") && navigator.maxTouchPoints > 1);

function rowDownloadLink(item, index) {
  if (!item.videoUrl) return "";
  const name = fileName(item, index);
  return `<a class="dl-link" href="${escapeHtml(downloadUrl(item, name))}" download="${escapeHtml(name)}"
    title="Tải video này">Tải</a>`;
}

function fileName(item, index) {
  const mode = el("naming").value;
  // Tên file lấy đúng tiêu đề đang hiện trong bảng, tức bản tiếng Việt nếu có.
  const title = sanitize(displayTitle(item));
  const base = mode === "id"
    ? item.awemeId
    : mode === "index_title"
      ? `${String(index).padStart(3, "0")}_${title}`
      : title;
  return `${base}.mp4`;
}

/**
 * Chrome hỏi quyền ghi 2 lần: lúc chọn thư mục và lúc thật sự ghi. Xin sẵn ở đây
 * để không phát hiện thiếu quyền giữa lúc đang tải 60 file.
 */
async function ensureWritable(handle) {
  const options = { mode: "readwrite" };
  if ((await handle.queryPermission(options)) === "granted") return true;
  return (await handle.requestPermission(options)) === "granted";
}

async function pickFolder() {
  if (!window.showDirectoryPicker) {
    return status(ui.scanStatus, "Trình duyệt này không hỗ trợ chọn thư mục (cần Chrome/Edge).", "err");
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite", id: "douyin-dl" });
    if (!(await ensureWritable(handle))) {
      return status(
        ui.scanStatus,
        `Chưa có quyền ghi vào "${handle.name}". Bấm 📁 chọn lại và chọn Allow ở hộp thoại "Allow this site to edit files?".`,
        "err",
      );
    }
    dirHandle = handle;
    el("folderName").value = handle.name;
    document.querySelector('input[name="dest"][value="folder"]').checked = true;
    syncFilterVisibility();
    savePrefs();
    status(ui.scanStatus, `Sẽ lưu file vào thư mục "${handle.name}".`, "ok");
  } catch (err) {
    if (err?.name === "AbortError") return; // user đóng hộp thoại, không phải lỗi
    // Chrome từ chối thẳng vài thư mục hệ thống (ổ C:, Windows, Program Files…).
    status(ui.scanStatus, `Không chọn được thư mục: ${err?.message || err}`, "err");
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

  // iOS chặn mọi lượt tải không bắt đầu từ chính cử chỉ chạm, nên tải hàng loạt
  // ở đây sẽ im lặng không ra file nào. Nói thẳng thay vì để người dùng bấm mãi.
  if (isIOS) {
    return status(
      ui.scanStatus,
      `iPhone/iPad chỉ cho tải từng video — bấm nút "Tải" trên từng dòng trong danh sách.`,
      "err",
    );
  }

  const useFolder = destValue() === "folder";
  if (useFolder) {
    if (!dirHandle) {
      await pickFolder();
      if (!dirHandle) return;
    }
    // Quyền có thể bị thu hồi sau khi reload tab hoặc đổi thư mục.
    if (!(await ensureWritable(dirHandle))) {
      dirHandle = null;
      el("folderName").value = "";
      return status(ui.scanStatus, "Mất quyền ghi vào thư mục — bấm 📁 chọn lại rồi chọn Allow.", "err");
    }
  }

  downloading = true;
  abortAll = new AbortController();
  el("startDownload").disabled = true;
  el("stopDownload").hidden = false;
  el("barDownload").textContent = "Dừng tải";
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
  el("barDownload").textContent = "Tải xuống";
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
  const supported = Boolean(window.showDirectoryPicker);
  el("pickFolder").disabled = !supported;

  // Điện thoại không có File System Access API. Để radio này bấm được ở đó
  // nghĩa là người dùng chọn xong, bấm Tải, rồi không có gì xảy ra cả.
  const folderRadio = document.querySelector('input[name="dest"][value="folder"]');
  folderRadio.disabled = !supported;
  folderRadio.closest(".radio").classList.toggle("disabled", !supported);
  if (!supported && folderRadio.checked) {
    document.querySelector('input[name="dest"][value="browser"]').checked = true;
  }
  el("folderRow").hidden = !supported || destValue() !== "folder";

  el("fsHint").textContent = supported
    ? "Lưu trực tiếp vào thư mục: stream từng chunk ra file, không ngốn RAM."
    : isIOS
      ? `iPhone/iPad chặn tải hàng loạt — dùng nút "Tải" trên từng dòng, file về app Tệp.`
      : "Trình duyệt này không chọn được thư mục — file về thẳng mục Tải xuống.";

  // Nút tải hàng loạt không thể chạy trên iOS; để lại chỉ tổ bấm rồi báo lỗi.
  el("startDownload").hidden = isIOS;
  el("barDownload").hidden = isIOS;
}

el("grabCookie").hidden = !hasCookieBridge();
el("grabCookie").addEventListener("click", grabCookie);
el("clearCookie").addEventListener("click", () => {
  el("cookie").value = "";
  savePrefs();
  status(ui.scanStatus, "Đã xoá cookie khỏi trình duyệt này.", "ok");
});

el("startScan").addEventListener("click", startScan);
// Thanh đáy mobile chỉ bấm hộ nút thật, để hai đường đi không lệch trạng thái.
el("barScan").addEventListener("click", () => el("startScan").click());
el("barDownload").addEventListener("click", () => {
  el(downloading ? "stopDownload" : "startDownload").click();
});
el("startDownload").addEventListener("click", startDownload);
el("stopDownload").addEventListener("click", () => abortAll?.abort());
el("pickFolder").addEventListener("click", pickFolder);
for (const id of ["threads", "naming", "scanMax", "links", "cookie"]) {
  el(id).addEventListener("change", savePrefs);
}
for (const radio of document.querySelectorAll('input[name="dest"]')) {
  radio.addEventListener("change", () => {
    syncFilterVisibility(); // ô chọn thư mục chỉ có nghĩa khi đang lưu vào thư mục
    savePrefs();
  });
}


/** Bookmarklet mở tool kèm ID (#import=...) — nạp thẳng vào ô Link rồi quét. */
async function importFromHash() {
  const match = location.hash.match(/[#&]import=([^&]+)/);
  if (!match) return;
  history.replaceState(null, "", location.pathname + location.search);

  const links = decodeURIComponent(match[1])
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((token) => (/^\d{15,25}$/.test(token) ? `https://www.douyin.com/video/${token}` : token));
  if (!links.length) return;

  el("links").value = links.join("\n");
  savePrefs();
  await startScan();
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

/**
 * Ô Link: mỗi dòng thành đúng một link sạch. Xử lý theo từng dòng chứ không gộp
 * cả ô — dán 2 đoạn share vào 2 dòng thì phải ra 2 link, không phải trộn lẫn.
 */
function normalizeLinksBox() {
  const box = el("links");
  const raw = box.value;
  if (!raw.trim()) return;

  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    const secUid = text.match(SEC_UID_RE);
    if (secUid) {
      out.push(`https://www.douyin.com/user/${secUid[0]}`);
      continue;
    }
    const links = linksFromText(text);
    out.push(...(links.length ? links : [text]));
  }

  const cleaned = [...new Set(out)].join("\n");
  if (!cleaned || cleaned === raw.trim()) return;
  box.value = cleaned;
  savePrefs();
  status(ui.scanStatus, `Đã tách ${cleaned.split("\n").length} link từ nội dung dán.`, "ok");
}

// setTimeout 0: chờ nội dung paste vào DOM rồi mới chuẩn hoá.
el("links").addEventListener("paste", () => setTimeout(normalizeLinksBox, 0));
el("links").addEventListener("blur", normalizeLinksBox);

el("importFileBtn").addEventListener("click", () => el("importFile").click());
el("importFile").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const links = linksFromText(await file.text());
  event.target.value = "";
  if (!links.length) return status(ui.scanStatus, "Không tìm thấy link Douyin nào trong file.", "err");
  el("links").value = links.join("\n");
  savePrefs();
  status(ui.scanStatus, `Đã nạp ${links.length} link từ file — bấm Bắt đầu quét.`, "ok");
});

ui.filterBox.addEventListener("input", render);

document.querySelector(".vtable thead").addEventListener("click", (event) => {
  const button = event.target.closest(".sort");
  if (button) applySort(button.dataset.sort);
});

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

// Ô tick 24px là mục tiêu quá nhỏ cho ngón tay, nên cả dòng cũng chọn được —
// trừ link (ảnh, URL) vốn có việc riêng.
ui.body.addEventListener("click", (event) => {
  if (event.target.closest("a, input, button")) return;
  const box = event.target.closest("tr")?.querySelector('input[type="checkbox"][data-id]');
  if (!box) return;
  box.checked = !box.checked;
  box.dispatchEvent(new Event("change", { bubbles: true }));
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

loadPrefs();
renderFilters();
render();
importFromHash();
