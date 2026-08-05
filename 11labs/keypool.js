/**
 * KeyPool — quản lý danh sách API key ElevenLabs.
 *
 * Chiến lược chọn key: ưu tiên key còn nhiều character nhất (max remaining).
 * Quota được cache trong localStorage, chỉ refresh khi stale (> CACHE_TTL) hoặc
 * khi người dùng bấm Refresh — tránh gọi N request mỗi lần Generate.
 */

const API_BASE = 'https://api.elevenlabs.io/v1';

const LS_KEYS = '11labs_keys';
const LS_QUOTA = '11labs_quota';
const LS_RR = '11labs_rr';

const CACHE_TTL = 5 * 60 * 1000;

/** Trạng thái key: dùng được / hết quota / key sai / chưa đo. */
const STATUS = {
  ok: { label: 'OK', cls: 'ok' },
  quota: { label: 'Hết quota', cls: 'warn' },
  invalid: { label: 'Key sai', cls: 'bad' },
  blocked: { label: 'Account bị khoá', cls: 'bad' },
  error: { label: 'Lỗi', cls: 'bad' },
  unknown: { label: 'Chưa đo', cls: 'idle' },
};

/** Account bị ElevenLabs khoá (flag free tier) — key vẫn đúng, nhưng không gọi được. */
const BLOCKED_RE = /unusual activity|free tier access has been disabled|detected_unusual_activity/i;

function maskKey(key) {
  if (key.length <= 12) return key;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

function readJson(lsKey, fallback) {
  try {
    return JSON.parse(localStorage.getItem(lsKey)) ?? fallback;
  } catch {
    return fallback;
  }
}

class KeyPool {
  constructor() {
    /** @type {string[]} */
    this.keys = readJson(LS_KEYS, []);
    /** @type {Record<string, object>} quota cache theo key */
    this.quota = readJson(LS_QUOTA, {});
    this.rr = Number(localStorage.getItem(LS_RR) || 0);
    this.listeners = [];
  }

  onChange(fn) {
    this.listeners.push(fn);
  }

  _emit() {
    this.listeners.forEach((fn) => fn(this.entries()));
  }

  /** Lưu danh sách key từ text (mỗi dòng 1 key). Bỏ dòng trống + trùng lặp. */
  setKeysFromText(text) {
    const next = [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
    this.keys = next;
    localStorage.setItem(LS_KEYS, JSON.stringify(next));
    // Dọn quota cache của key đã bị xoá
    this.quota = Object.fromEntries(Object.entries(this.quota).filter(([k]) => next.includes(k)));
    this._persistQuota();
    this._emit();
    return next;
  }

  clear() {
    this.keys = [];
    this.quota = {};
    localStorage.removeItem(LS_KEYS);
    localStorage.removeItem(LS_QUOTA);
    this._emit();
  }

  _persistQuota() {
    localStorage.setItem(LS_QUOTA, JSON.stringify(this.quota));
  }

  /** Dữ liệu để render bảng trạng thái. */
  entries() {
    return this.keys.map((key) => {
      const q = this.quota[key] || {};
      return {
        key,
        masked: maskKey(key),
        tier: q.tier || '—',
        used: q.used,
        limit: q.limit,
        remaining: q.remaining,
        status: q.status || 'unknown',
        error: q.error,
        checkedAt: q.checkedAt,
      };
    });
  }

  get isStale() {
    if (!this.keys.length) return false;
    return this.keys.some((k) => {
      const q = this.quota[k];
      return !q || !q.checkedAt || Date.now() - q.checkedAt > CACHE_TTL;
    });
  }

  /** Đo quota song song cho toàn bộ key. */
  async refreshAll() {
    await Promise.all(this.keys.map((k) => this._refreshOne(k)));
    this._persistQuota();
    this._emit();
    return this.entries();
  }

  async _refreshOne(key) {
    try {
      const res = await fetch(`${API_BASE}/user/subscription`, { headers: { 'xi-api-key': key } });
      if (!res.ok) {
        const error = await describeError(res);
        this.quota[key] = {
          ...this.quota[key],
          status: BLOCKED_RE.test(error) ? 'blocked' : (res.status === 401 ? 'invalid' : 'error'),
          error,
          checkedAt: Date.now(),
        };
        return;
      }
      const data = await res.json();
      const used = data.character_count ?? 0;
      const limit = data.character_limit ?? 0;
      const remaining = Math.max(0, limit - used);
      // Account bị khoá vẫn đọc được subscription bình thường — chỉ /text-to-speech mới
      // trả 401. Nên giữ nguyên trạng thái blocked, đừng để nó reset về 'ok' mỗi lần refresh.
      const wasBlocked = this.quota[key]?.status === 'blocked';
      this.quota[key] = {
        tier: data.tier || 'free',
        used,
        limit,
        remaining,
        resetAt: data.next_character_count_reset_unix ? data.next_character_count_reset_unix * 1000 : null,
        status: wasBlocked ? 'blocked' : (remaining > 0 ? 'ok' : 'quota'),
        error: wasBlocked ? this.quota[key].error : null,
        checkedAt: Date.now(),
      };
    } catch (e) {
      this.quota[key] = {
        ...this.quota[key],
        status: 'error',
        error: e.message || 'Network error',
        checkedAt: Date.now(),
      };
    }
  }

  /**
   * Chọn key tốt nhất: status ok + còn đủ character, remaining lớn nhất.
   * Nhiều key cùng remaining → round-robin để không dồn hết vào một key.
   * @param {number} charNeeded số ký tự cần
   * @param {string[]} exclude các key đã thử và fail trong request này
   */
  pick(charNeeded = 0, exclude = []) {
    const candidates = this.keys
      .filter((k) => !exclude.includes(k))
      .map((k) => ({ key: k, q: this.quota[k] || {} }))
      .filter(({ q }) => q.status !== 'invalid' && q.status !== 'quota')
      .filter(({ q }) => q.remaining === undefined || q.remaining >= charNeeded);

    if (!candidates.length) return null;

    // Key blocked/error vẫn được thử, nhưng chỉ khi không còn key lành — để nếu
    // ElevenLabs bỏ flag thì key tự hồi phục, không cần xoá đi nhập lại.
    const healthy = candidates.filter(({ q }) => q.status !== 'blocked' && q.status !== 'error');
    const group = healthy.length ? healthy : candidates;

    const best = Math.max(...group.map(({ q }) => q.remaining ?? Infinity));
    const tied = group.filter(({ q }) => (q.remaining ?? Infinity) === best);
    const chosen = tied[this.rr % tied.length];
    this.rr = (this.rr + 1) % Math.max(1, tied.length);
    localStorage.setItem(LS_RR, String(this.rr));
    return chosen.key;
  }

  /** Key nào sẽ được dùng cho request kế tiếp (chỉ để hiển thị, không xoay con trỏ). */
  peek(charNeeded = 0) {
    const rrBefore = this.rr;
    const key = this.pick(charNeeded);
    this.rr = rrBefore;
    localStorage.setItem(LS_RR, String(rrBefore));
    return key;
  }

  /** Trừ optimistic sau khi generate thành công + xoá cờ lỗi cũ (key đã hồi phục). */
  consume(key, chars) {
    const q = this.quota[key];
    if (!q) return;
    if (q.status === 'blocked' || q.status === 'error') {
      q.status = 'ok';
      q.error = null;
    }
    if (q.remaining === undefined) return;
    q.used = (q.used ?? 0) + chars;
    q.remaining = Math.max(0, q.remaining - chars);
    if (q.remaining === 0) q.status = 'quota';
    this._persistQuota();
    this._emit();
  }

  /** Đánh dấu key lỗi để failover sang key khác. */
  reportFailure(key, httpStatus, message) {
    const q = (this.quota[key] = this.quota[key] || {});
    if (BLOCKED_RE.test(message || '')) q.status = 'blocked';
    else if (httpStatus === 401 || httpStatus === 403) q.status = 'invalid';
    else if (httpStatus === 429) q.status = 'quota';
    else q.status = 'error';
    q.error = message;
    q.checkedAt = Date.now();
    this._persistQuota();
    this._emit();
  }
}

/** Trích message lỗi dễ đọc từ response ElevenLabs. */
async function describeError(res) {
  const raw = await res.text().catch(() => '');
  try {
    const j = JSON.parse(raw);
    const d = j.detail ?? j;
    if (typeof d === 'string') return d;
    return d.message || d.status || raw.slice(0, 200);
  } catch {
    return raw.slice(0, 200) || `HTTP ${res.status}`;
  }
}

window.KeyPool = KeyPool;
window.ELEVEN = { API_BASE, STATUS, maskKey, describeError };
