"use strict";

// Mọi request Douyin đi qua edge function này (resolve / user / download).
const DEFAULT_ENDPOINT = "https://lnazpyhoojqotnanrvqf.supabase.co/functions/v1/douyin";
const LS_KEY = "douyin_dl_prefs_v1";
const PAGE_SIZE = 20; // Douyin trả ~18-20 item/trang

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
  el("snippetBox").value = HARVEST_SNIPPET;
  el("endpoint").value = prefs.endpoint || DEFAULT_ENDPOINT;
  el("profileUrl").value = prefs.profileUrl || "";
  el("scanMax").value = prefs.scanMax || 200;
  el("threads").value = prefs.threads || 4;
  el("naming").value = prefs.naming || "title";
  el("useFilter").checked = Boolean(prefs.useFilter);
  el("minLike").value = prefs.minLike || 0;
  el("minPlay").value = prefs.minPlay || 0;
  const dest = prefs.dest === "folder" ? "folder" : "browser";
  document.querySelector(`input[name="dest"][value="${dest}"]`).checked = true;
  syncFilterVisibility();
}

function savePrefs() {
  const prefs = {
    endpoint: el("endpoint").value.trim(),
    profileUrl: el("profileUrl").value.trim(),
    scanMax: Number(el("scanMax").value),
    threads: Number(el("threads").value),
    naming: el("naming").value,
    useFilter: el("useFilter").checked,
    minLike: Number(el("minLike").value),
    minPlay: Number(el("minPlay").value),
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

function status(node, text, kind) {
  node.textContent = text;
  node.className = `status${kind ? ` ${kind}` : ""}`;
}

async function callApi(params, signal) {
  const url = new URL(endpoint());
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetch(url, { signal });
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
      <td><span class="name-cell" title="${escapeHtml(item.desc || item.title)}">${escapeHtml(item.title)}</span></td>
      <td><a class="url-cell" href="${item.shareUrl}" target="_blank" rel="noopener">${item.shareUrl.replace("https://www.", "")}</a></td>
      <td class="num">${num(item.stats?.comment)}</td>
      <td class="num">${num(item.stats?.like)}</td>
      <td class="num">${num(item.stats?.play)}</td>
      <td class="num">${num(item.stats?.share)}</td>
      <td>douyin</td>
      <td class="num">${duration(item.duration)}</td>
      <td><span class="state ${item.state || "wait"}" title="${escapeHtml(item.error || "")}">${stateLabel(item)}</span></td>`;
    fragment.appendChild(tr);
  });
  ui.body.appendChild(fragment);

  ui.empty.hidden = visible.length > 0;
  ui.rowsInfo.textContent = `Hiển thị ${visible.length} / ${items.length} dữ liệu`;
  updateStats();
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
  try {
    while (total < limit) {
      status(ui.scanStatus, `Đang quét trang ${page + 1}… (${total} video)`, "run");
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
      if (!payload.hasMore || !payload.items?.length || !cursor) break;
      if (added === 0 && page > 1) break; // cursor lặp → dừng để không loop vô hạn
    }
    status(ui.scanStatus, `Xong: ${items.length} video trong danh sách (quét ${page} trang).`, "ok");
  } catch (err) {
    status(ui.scanStatus, `Lỗi quét: ${err.message}`, "err");
  } finally {
    el("startScan").disabled = false;
  }
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
    el("profileUrl").value = [...profiles].join("\n");
    savePrefs();
    status(
      ui.scanStatus,
      `${profiles.size} link là share profile (không phải share video) — đã điền sec_uid vào ô Người dùng. ` +
        `Danh sách video của user cần snippet "Quét bằng trình duyệt".`,
      "err",
    );
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

  const lines = ["url,title,likes,comments,plays,shares,aweme_id"];
  for (const item of source) {
    lines.push([
      item.shareUrl,
      `"${(item.title || "").replace(/"/g, "'")}"`,
      item.stats?.like ?? "",
      item.stats?.comment ?? "",
      item.stats?.play ?? "",
      item.stats?.share ?? "",
      item.awemeId,
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
  const minPlay = Number(el("minPlay").value) || 0;
  return (item.stats?.like ?? 0) >= minLike && (item.stats?.play ?? 0) >= minPlay;
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

el("startScan").addEventListener("click", startScan);
el("startDownload").addEventListener("click", startDownload);
el("stopDownload").addEventListener("click", () => abortAll?.abort());
el("pickFolder").addEventListener("click", pickFolder);
el("exportLinks").addEventListener("click", exportLinks);
el("useFilter").addEventListener("change", () => {
  syncFilterVisibility();
  savePrefs();
});
for (const id of ["threads", "naming", "scanMax", "minLike", "minPlay", "profileUrl"]) {
  el(id).addEventListener("change", savePrefs);
}
for (const radio of document.querySelectorAll('input[name="dest"]')) {
  radio.addEventListener("change", savePrefs);
}

/** Chạy trong Console của tab profile Douyin: JS của Douyin tự ký request khi cuộn. */
const HARVEST_SNIPPET = `(async () => {
  const ids = new Set(); let last = 0, stale = 0;
  const grab = () => document.querySelectorAll('a[href*="/video/"]').forEach(a => {
    const m = a.href.match(/\\/video\\/(\\d{15,25})/); if (m) ids.add(m[1]);
  });
  while (stale < 5) {
    grab();
    if (ids.size === last) stale++; else { stale = 0; last = ids.size; }
    scrollTo(0, document.body.scrollHeight);
    console.log('đã thấy', ids.size, 'video');
    await new Promise(r => setTimeout(r, 1200));
  }
  const out = [...ids].map(id => 'https://www.douyin.com/video/' + id).join('\\n');
  try { await navigator.clipboard.writeText(out); } catch { if (typeof copy === 'function') copy(out); }
  console.log(out); return ids.size + ' link đã copy';
})()`;

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

el("copySnippet").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(HARVEST_SNIPPET);
    status(ui.scanStatus, "Đã copy snippet — dán vào Console của tab profile Douyin.", "ok");
  } catch {
    el("snippetBox").select();
    status(ui.scanStatus, "Không copy tự động được — snippet đã được chọn, bấm Ctrl+C.", "err");
  }
});

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
