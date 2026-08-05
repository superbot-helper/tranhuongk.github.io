/**
 * app.js — wiring UI cho trang TTS.
 * Mọi logic chọn key nằm ở keypool.js; file này chỉ lo render + gọi API.
 */

const EL = window.ELEVEN;
const pool = new window.KeyPool();

const LS_PREFS = '11labs_prefs';
const FALLBACK_MODELS = [
  { model_id: 'eleven_v3', name: 'Eleven v3 (biểu cảm nhất)', maxChars: 3000 },
  { model_id: 'eleven_multilingual_v2', name: 'Multilingual v2 (chất lượng cao)', maxChars: 10000 },
  { model_id: 'eleven_flash_v2_5', name: 'Flash v2.5 (nhanh, rẻ)', maxChars: 40000 },
  { model_id: 'eleven_turbo_v2_5', name: 'Turbo v2.5 (cân bằng)', maxChars: 40000 },
];
/** Model cũ không nhận style / speed trong voice_settings. */
const LEGACY_MODELS = ['eleven_monolingual_v1', 'eleven_multilingual_v1'];

const DEFAULT_MODEL = 'eleven_v3';
const DEFAULT_VOICE = /^adam\b/i;

/** voice_settings field nào model hiện tại nhận. Eleven v3 chỉ nhận stability ở 3 mức. */
function capsFor(modelId) {
  if (modelId === 'eleven_v3') return { style: false, speed: false, stabilityStep: 0.5 };
  if (LEGACY_MODELS.includes(modelId)) return { style: false, speed: false, stabilityStep: 0.05 };
  return { style: true, speed: true, stabilityStep: 0.05 };
}

/**
 * Credits ElevenLabs trừ trên mỗi ký tự, theo model. Flash/Turbo rẻ nửa giá,
 * các model còn lại 1 credit/ký tự. Quota trong /user/subscription tính bằng credits.
 */
const CREDIT_RATE = {
  eleven_flash_v2_5: 0.5,
  eleven_flash_v2: 0.5,
  eleven_turbo_v2_5: 0.5,
  eleven_turbo_v2: 0.5,
};
const rateFor = (modelId) => CREDIT_RATE[modelId] ?? 1;
const creditCost = (chars, modelId) => Math.ceil(chars * rateFor(modelId));

const $ = (id) => document.getElementById(id);
const fmt = (n) => (n === undefined || n === null ? '—' : n.toLocaleString('vi-VN'));

/** Credits ước tính cho nội dung đang có trong ô văn bản. */
const currentCost = () => creditCost($('text').value.trim().length, $('model').value);

const Store = window.HistoryStore;

/** Bản đã generate, mới nhất trước. `url` là blob URL dựng lại từ IndexedDB. */
/** @type {Array<{id:string,text:string,voice:string,model:string,key:string,name:string,size:number,at:number,url:string}>} */
let history = [];
let modelMeta = {};
let voiceMap = {};

// ─────────────────────────── prefs ───────────────────────────

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(LS_PREFS)) || {};
  } catch {
    return {};
  }
}

function savePrefs() {
  localStorage.setItem(LS_PREFS, JSON.stringify({
    voice: $('voice').value,
    model: $('model').value,
    stability: $('stability').value,
    similarity: $('similarity').value,
    style: $('style').value,
    speed: $('speed').value,
    speakerBoost: $('speakerBoost').checked,
  }));
}

// ─────────────────────────── keys panel ───────────────────────────

function renderKeyTable(entries) {
  const tbody = $('keyTable').querySelector('tbody');
  const nextKey = pool.peek(currentCost());

  tbody.innerHTML = entries.map((e) => {
    const st = EL.STATUS[e.status] || EL.STATUS.unknown;
    const usage = e.limit ? `${fmt(e.used)} / ${fmt(e.limit)}` : '—';
    const reason = e.error
      ? `<div class="cell-err" title="${escapeAttr(e.error)}">${escapeAttr(e.error)}</div>`
      : '';
    return `<tr class="${e.key === nextKey ? 'next' : ''}">
      <td class="k">${e.masked}</td>
      <td>${e.tier}</td>
      <td>${usage}</td>
      <td>${fmt(e.remaining)}</td>
      <td class="st"><span class="badge ${st.cls}">${st.label}</span>${reason}</td>
    </tr>`;
  }).join('');

  $('keyEmpty').classList.toggle('hidden', entries.length > 0);
  $('keysCount').textContent = `${entries.length} key`;

  const newest = Math.max(0, ...entries.map((e) => e.checkedAt || 0));
  $('quotaAge').textContent = newest
    ? `đo lúc ${new Date(newest).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}`
    : 'chưa đo';

  renderActiveKey(entries, nextKey);
  updatePickInfo();
}

/** Dòng tóm tắt trên summary: key sẽ dùng cho request tới. */
function renderActiveKey(entries, nextKey) {
  const el = $('activeKey');
  const active = entries.find((e) => e.key === nextKey);

  if (active) {
    const st = EL.STATUS[active.status] || EL.STATUS.unknown;
    el.innerHTML = `<code>${active.masked}</code>`
      + (active.remaining === undefined ? '' : `<span class="ak-left">còn ${fmt(active.remaining)}</span>`)
      + `<span class="badge ${st.cls}">${st.label}</span>`;
  } else {
    el.innerHTML = entries.length
      ? '<span class="badge bad">không key nào dùng được</span>'
      : '<span class="ak-left">chưa có key</span>';
  }

  // Chỉ tự MỞ khi có vấn đề — không tự đóng, để không sập cái user vừa mở ra xem.
  if (entries.length && !nextKey) $('statusCard').open = true;
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function updatePickInfo() {
  const key = pool.peek(currentCost());
  const info = $('pickInfo');
  if (!pool.keys.length) {
    info.textContent = 'chưa có key';
    return;
  }
  if (!key) {
    info.textContent = 'không key nào dùng được';
    return;
  }
  const q = pool.quota[key] || {};
  const left = q.remaining === undefined ? '' : ` · còn ${fmt(q.remaining)}`;
  info.textContent = `key ${EL.maskKey(key)}${left}`;
}

async function refreshQuota() {
  if (!pool.keys.length) return;
  $('quotaAge').textContent = 'đang đo…';
  await pool.refreshAll();
}

// ─────────────────────────── voices & models ───────────────────────────

async function loadVoicesAndModels() {
  const key = pool.peek();
  if (!key) return;

  const [voices, models] = await Promise.all([
    fetchJson(`${EL.API_BASE}/voices`, key).catch(() => null),
    fetchJson(`${EL.API_BASE}/models`, key).catch(() => null),
  ]);

  const prefs = loadPrefs();

  if (voices?.voices?.length) {
    voiceMap = Object.fromEntries(voices.voices.map((v) => [v.voice_id, v]));
    const groups = {};
    voices.voices.forEach((v) => {
      const g = v.category === 'premade' ? 'Premade' : (v.category || 'Khác');
      (groups[g] = groups[g] || []).push(v);
    });
    $('voice').innerHTML = Object.entries(groups)
      .map(([g, list]) => `<optgroup label="${g}">${list
        .map((v) => `<option value="${v.voice_id}">${v.name}</option>`).join('')}</optgroup>`)
      .join('');
    const fallbackVoice = voices.voices.find((v) => DEFAULT_VOICE.test(v.name));
    if (prefs.voice && voiceMap[prefs.voice]) $('voice').value = prefs.voice;
    else if (fallbackVoice) $('voice').value = fallbackVoice.voice_id;
  }

  renderModels(models?.length
    ? models.filter((m) => m.can_do_text_to_speech).map((m) => ({
        model_id: m.model_id,
        name: m.name || m.model_id,
        maxChars: m.max_characters_request_subscribed_user || m.max_characters_request_free_user,
      }))
    : FALLBACK_MODELS);
}

/** Render dropdown model. Gọi với FALLBACK_MODELS khi chưa có key. */
function renderModels(list) {
  const prefs = loadPrefs();
  modelMeta = Object.fromEntries(list.map((m) => [m.model_id, m]));
  $('model').innerHTML = list
    .map((m) => `<option value="${m.model_id}">${m.name}</option>`).join('');
  if (prefs.model && modelMeta[prefs.model]) $('model').value = prefs.model;
  else if (modelMeta[DEFAULT_MODEL]) $('model').value = DEFAULT_MODEL;
  else if (modelMeta.eleven_multilingual_v2) $('model').value = 'eleven_multilingual_v2';

  applyModelCaps();
  updateCharCount();
}

async function fetchJson(url, key) {
  const res = await fetch(url, { headers: { 'xi-api-key': key } });
  if (!res.ok) throw new Error(await EL.describeError(res));
  return res.json();
}

/** Ẩn hẳn control model không nhận, và đổi stability giữa 3 nút / slider. */
function applyModelCaps() {
  const caps = capsFor($('model').value);

  let hiddenCount = 0;
  document.querySelectorAll('.slider[data-cap]').forEach((el) => {
    const off = caps[el.dataset.cap] === false;
    el.classList.toggle('hidden', off);
    if (off) hiddenCount++;
  });
  $('capSliders').classList.toggle('hidden', hiddenCount === 2);

  // v3: 3 mức rời rạc → dùng segmented button. Model khác → slider liên tục.
  const discrete = caps.stabilityStep === 0.5;
  $('stabSeg').classList.toggle('hidden', !discrete);
  $('stabSlider').classList.toggle('hidden', discrete);

  const st = $('stability');
  st.step = caps.stabilityStep;
  if (discrete) st.value = String(Math.round(Number(st.value) * 2) / 2);
  renderStability();
}

/** Đồng bộ hiển thị stability: nút active cho v3, số cho model khác. */
function renderStability() {
  const v = Number($('stability').value);
  $('stabilityV').textContent = v.toFixed(2);
  $('stabSeg').querySelectorAll('button').forEach((b) => {
    const on = Number(b.dataset.v) === v;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  });
}

function updateCharCount() {
  const n = $('text').value.length;
  const max = modelMeta[$('model').value]?.maxChars;
  const el = $('charCount');
  el.textContent = max ? `${fmt(n)} / ${fmt(max)} ký tự` : `${fmt(n)} ký tự`;
  el.classList.toggle('over', Boolean(max && n > max));
  renderCreditEst();
  updatePickInfo();
  renderNextKeyHighlight();
}

/** Ước tính credits sẽ bị trừ cho đoạn văn bản hiện tại, kèm cảnh báo nếu không key nào đủ. */
function renderCreditEst() {
  const el = $('creditEst');
  const rate = rateFor($('model').value);
  const cost = currentCost();
  const rateLbl = `${rate}× credits/ký tự`;

  el.textContent = cost ? `≈ ${fmt(cost)} credits · ${rateLbl}` : rateLbl;
  el.title = cost
    ? `Ước tính ${fmt(cost)} credits (${rateLbl}). Số thật do ElevenLabs chốt khi generate.`
    : `Model này tốn ${rateLbl}`;

  const measured = pool.keys.some((k) => pool.quota[k]?.remaining !== undefined);
  el.classList.toggle('over', Boolean(cost && measured && !pool.peek(cost)));
}

function renderNextKeyHighlight() {
  const nextKey = pool.peek(currentCost());
  const rows = $('keyTable').querySelectorAll('tbody tr');
  pool.keys.forEach((k, i) => rows[i]?.classList.toggle('next', k === nextKey));
}

// ─────────────────────────── generate ───────────────────────────

function voiceSettings() {
  const caps = capsFor($('model').value);
  const s = {
    stability: Number($('stability').value),
    similarity_boost: Number($('similarity').value),
    use_speaker_boost: $('speakerBoost').checked,
  };
  if (caps.style) s.style = Number($('style').value);
  if (caps.speed) s.speed = Number($('speed').value);
  return s;
}

function setStatus(msg, cls = '', busy = false) {
  const el = $('status');
  el.textContent = msg;
  el.className = `status ${cls} ${busy ? 'spin' : ''}`.trim();
}

async function generate() {
  const text = $('text').value.trim();
  const voiceId = $('voice').value;

  if (!pool.keys.length) return setStatus('Chưa có API key — mở mục API Keys ở trên.', 'err');
  if (!text) return setStatus('Nhập văn bản trước đã.', 'err');
  if (!voiceId) return setStatus('Chưa chọn giọng đọc (cần key hợp lệ để tải danh sách).', 'err');

  const chars = text.length;
  const cost = creditCost(chars, $('model').value);
  const tried = [];
  let lastError = '';
  $('generate').disabled = true;

  try {
    for (let attempt = 0; attempt < pool.keys.length; attempt++) {
      const key = pool.pick(cost, tried);
      if (!key) break;
      tried.push(key);

      setStatus(`Đang tạo với key ${EL.maskKey(key)}…`, '', true);

      try {
        const res = await fetch(
          `${EL.API_BASE}/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
          {
            method: 'POST',
            headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text,
              model_id: $('model').value,
              voice_settings: voiceSettings(),
            }),
          },
        );

        if (!res.ok) {
          const msg = await EL.describeError(res);
          lastError = msg;
          pool.reportFailure(key, res.status, msg);
          setStatus(`Key ${EL.maskKey(key)} lỗi: ${msg} — thử key khác…`, 'err', true);
          continue;
        }

        const blob = await res.blob();
        pool.consume(key, cost);
        showResult(blob, { text, voiceId, key, chars });
        setStatus(
          `Xong · ${(blob.size / 1024).toFixed(0)} KB · −${fmt(cost)} credits · key ${EL.maskKey(key)}`,
          'ok',
        );
        return;
      } catch (e) {
        lastError = e.message || 'Network error';
        pool.reportFailure(key, 0, lastError);
        setStatus(`Key ${EL.maskKey(key)} lỗi mạng — thử key khác…`, 'err', true);
      }
    }

    setStatus(tried.length
      ? `Đã thử ${tried.length} key, không key nào chạy được. Lỗi cuối: ${lastError}`
      : 'Không có key nào dùng được. Xem cột Trạng thái ở bảng trên, hoặc bấm Refresh quota.', 'err');
  } finally {
    $('generate').disabled = false;
  }
}

function slug(text) {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).toLowerCase() || 'tts';
}

function setPlayer(url, name) {
  $('player').classList.remove('hidden');
  $('audio').src = url;
  $('download').href = url;
  $('download').download = name;
}

async function showResult(blob, { text, voiceId, key }) {
  const at = Date.now();
  const item = {
    id: `${at}-${Math.random().toString(36).slice(2, 7)}`,
    at,
    text,
    voice: voiceMap[voiceId]?.name || voiceId,
    model: $('model').value,
    key: EL.maskKey(key),
    name: `${slug(text)}-${at}.mp3`,
    size: blob.size,
  };

  const url = URL.createObjectURL(blob);
  setPlayer(url, item.name);
  history.unshift({ ...item, url });
  renderHistory();

  try {
    await Store.put({ ...item, blob });
    const removed = await Store.prune();
    if (removed.length) {
      history = history.filter((h) => {
        if (!removed.includes(h.id)) return true;
        URL.revokeObjectURL(h.url);
        return false;
      });
      renderHistory();
    }
  } catch (e) {
    // IndexedDB không dùng được (private mode / hết quota) → lịch sử chỉ sống trong phiên
    setStatus(`Đã tạo xong nhưng không lưu được vào lịch sử: ${e.message}`, 'err');
  }
}

/** Dựng lại history từ IndexedDB khi mở trang. */
async function loadHistory() {
  let items = [];
  try {
    items = await Store.list();
  } catch {
    $('histEmpty').textContent = 'Trình duyệt không cho dùng IndexedDB — lịch sử chỉ giữ trong phiên này.';
  }
  history.forEach((h) => URL.revokeObjectURL(h.url));
  history = items.map((it) => ({ ...it, url: URL.createObjectURL(it.blob), blob: undefined }));
  renderHistory();
}

/** dd/MM HH:mm — toLocaleString ra thứ tự lẫn lộn nên tự ghép. */
function stamp(at) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderHistory() {
  const totalKb = history.reduce((sum, h) => sum + h.size, 0) / 1024;
  $('histCount').textContent = history.length
    ? `${history.length} bản · ${totalKb > 1024 ? `${(totalKb / 1024).toFixed(1)} MB` : `${totalKb.toFixed(0)} KB`}`
    : '0';
  $('histEmpty').classList.toggle('hidden', history.length > 0);
  $('clearHist').classList.toggle('hidden', history.length === 0);
  $('history').innerHTML = history.map((h) => `
    <li>
      <button class="btn icon" data-play="${h.id}" title="Phát">▶</button>
      <div class="h-main">
        <div class="h-text">${escapeAttr(h.text)}</div>
        <div class="h-meta">${escapeAttr(h.voice)} · ${h.model} · ${h.key} · ${(h.size / 1024).toFixed(0)} KB · ${stamp(h.at)}</div>
      </div>
      <a class="btn icon" href="${h.url}" download="${h.name}" title="Tải">⤓</a>
      <button class="btn icon danger" data-del="${h.id}" title="Xoá">✕</button>
    </li>`).join('');
}

async function removeHistoryItem(id) {
  const item = history.find((h) => h.id === id);
  if (!item) return;
  try {
    await Store.remove(id);
  } catch { /* không xoá được trong DB thì vẫn bỏ khỏi list đang hiển thị */ }
  if ($('audio').src === item.url) {
    $('audio').pause();
    $('player').classList.add('hidden');
  }
  URL.revokeObjectURL(item.url);
  history = history.filter((h) => h.id !== id);
  renderHistory();
}

// ─────────────────────────── events ───────────────────────────

function bind() {
  $('saveKeys').onclick = async () => {
    const keys = pool.setKeysFromText($('keysInput').value);
    $('keysInput').value = keys.join('\n');
    await refreshQuota();
    await loadVoicesAndModels();
    if (keys.length) $('keysCard').open = false;
  };

  $('refreshKeys').onclick = async () => {
    await refreshQuota();
    await loadVoicesAndModels();
  };

  $('clearKeys').onclick = () => {
    if (!confirm('Xoá toàn bộ key khỏi localStorage?')) return;
    pool.clear();
    $('keysInput').value = '';
  };

  $('text').oninput = updateCharCount;

  $('clearText').onclick = () => {
    const el = $('text');
    if (!el.value) return;
    el.value = '';
    updateCharCount();
    el.focus();
    setStatus('Đã xoá văn bản.', 'ok');
  };

  // Clipboard API cần HTTPS/localhost + quyền; fallback nhắc user Ctrl/Cmd+V.
  $('pasteText').onclick = async () => {
    const el = $('text');
    try {
      const txt = await navigator.clipboard.readText();
      if (!txt) return setStatus('Clipboard đang rỗng.', 'err');
      el.value = txt;
      updateCharCount();
      el.focus();
      setStatus(`Đã dán ${fmt(txt.length)} ký tự.`, 'ok');
    } catch {
      el.focus();
      setStatus('Trình duyệt chặn đọc clipboard — dán tay bằng Cmd/Ctrl+V.', 'err');
    }
  };

  $('model').onchange = () => {
    applyModelCaps();
    updateCharCount();
    savePrefs();
  };
  $('voice').onchange = savePrefs;
  $('speakerBoost').onchange = savePrefs;

  [['similarity', 'similarityV'], ['style', 'styleV'], ['speed', 'speedV']].forEach(([id, out]) => {
    const input = $(id);
    input.oninput = () => { $(out).textContent = Number(input.value).toFixed(2); };
    input.onchange = savePrefs;
    input.oninput();
  });
  $('stability').oninput = renderStability;
  $('stability').onchange = savePrefs;

  $('stabSeg').onclick = (e) => {
    const v = e.target.closest('button')?.dataset.v;
    if (v === undefined) return;
    $('stability').value = v;
    renderStability();
    savePrefs();
  };

  $('previewVoice').onclick = () => {
    const v = voiceMap[$('voice').value];
    if (!v?.preview_url) return setStatus('Giọng này không có preview.', 'err');
    $('previewAudio').src = v.preview_url;
    $('previewAudio').play();
  };

  $('generate').onclick = generate;

  $('history').onclick = (e) => {
    const btn = e.target.closest('[data-play], [data-del]');
    if (!btn) return;
    if (btn.dataset.del) return void removeHistoryItem(btn.dataset.del);

    const item = history.find((h) => h.id === btn.dataset.play);
    if (!item) return;
    setPlayer(item.url, item.name);
    $('audio').play();
  };

  $('clearHist').onclick = async () => {
    if (!history.length || !confirm(`Xoá toàn bộ ${history.length} bản trong lịch sử?`)) return;
    try {
      await Store.clear();
    } catch { /* xoá được trong list là đủ */ }
    history.forEach((h) => URL.revokeObjectURL(h.url));
    history = [];
    $('audio').pause();
    $('player').classList.add('hidden');
    renderHistory();
  };
}

// ─────────────────────────── init ───────────────────────────

(async function init() {
  pool.onChange(renderKeyTable);
  bind();

  const prefs = loadPrefs();
  ['stability', 'similarity', 'style', 'speed'].forEach((k) => {
    if (prefs[k] !== undefined) $(k).value = prefs[k];
  });
  if (prefs.speakerBoost !== undefined) $('speakerBoost').checked = prefs.speakerBoost;
  document.querySelectorAll('input[type="range"]').forEach((el) => el.dispatchEvent(new Event('input')));

  $('keysInput').value = pool.keys.join('\n');
  renderModels(FALLBACK_MODELS);
  renderKeyTable(pool.entries());
  await loadHistory();

  if (!pool.keys.length) {
    $('keysCard').open = true;
    setStatus('Thêm API key để bắt đầu.', '');
    return;
  }

  if (pool.isStale) await refreshQuota();
  else renderKeyTable(pool.entries());
  await loadVoicesAndModels();
})();
