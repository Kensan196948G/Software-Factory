/**
 * みらいSF コンソール（mirai-construction-sf-console.html）と API/DB のブリッジ。
 *
 * - 起動時: サーバが HTML に注入した window.__MSF_BOOT__ を、コンソールの
 *   localStorage 形式（KEY: mirai-const-sf-console-v1）へ変換して書き込む。
 *   コンソールは従来どおり SF.load(KEY) で読み込む。
 * - 変更時: コンソールの persist() から persist() が呼ばれ、差分を API に同期する。
 * - 役割: 画面の「操作する人」を API のセッション役割へ切り替える。
 *
 * 運用・DevOps・SecOps の見本データはコンソール内の localStorage のまま（仕様どおり）。
 */
(function () {
  'use strict';

  const KEY = 'mirai-const-sf-console-v1';
  let boot = window.__MSF_BOOT__;
  const bootEl = document.getElementById('msf-boot');
  if (!boot && bootEl) {
    try {
      boot = JSON.parse(bootEl.textContent || 'null');
    } catch {
      boot = null;
    }
  }
  if (!boot || !Array.isArray(boot.items)) {
    window.__MSF__ = null;
    return;
  }

  const KIND_LABEL = {
    new_tool: '新しい道具がほしい',
    improve_tool: 'いまある道具を良くしたい',
    bug_report: '不具合の報告',
    consult: '相談・アイデア',
  };
  const KIND_CODE = Object.fromEntries(Object.entries(KIND_LABEL).map(([k, v]) => [v, k]));
  const PARTY_LABEL = { internal: '社内のみ', partner: '協力会社も使う', client: '発注者も見る' };
  const PARTY_CODE = Object.fromEntries(Object.entries(PARTY_LABEL).map(([k, v]) => [v, k]));
  const ROLE_LABEL = { requester: '依頼者', desk: '受付担当', approver: '承認者', system: 'システム' };
  const ROLE_CODE = { requester: 'requester', desk: 'desk', approver: 'approver', ops: 'approver', sec: 'approver', admin: 'approver', auditor: 'approver' };

  const lines = (v) => String(v || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

  function toolRefOf(toolId) {
    if (!toolId) return '';
    const m = /^([a-z]+)-(\d{2})$/.exec(toolId);
    return m ? `${m[1]}|${Number(m[2]) - 1}` : '';
  }
  function toolIdOf(toolRef) {
    if (!toolRef) return null;
    const m = /^([a-z]+)\|(\d+)$/.exec(String(toolRef));
    return m ? `${m[1]}-${String(Number(m[2]) + 1).padStart(2, '0')}` : null;
  }

  /** サーバの依頼 → コンソールの依頼 */
  function toConsole(r) {
    return {
      id: r.id,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      applicant: r.applicant,
      dept: r.deptCode,
      contact: r.contact || '',
      title: r.title,
      kind: KIND_LABEL[r.kind] || r.kind,
      toolRef: toolRefOf(r.toolId),
      problem: r.problem,
      purpose: r.purpose,
      users: Array.isArray(r.users) ? r.users : [],
      people: r.people === null || r.people === undefined ? '' : String(r.people),
      places: Array.isArray(r.places) ? r.places : [],
      scope: Array.isArray(r.scope) ? r.scope.join('\n') : r.scope || '',
      outScope: Array.isArray(r.outOfScope) ? r.outOfScope.join('\n') : r.outOfScope || '',
      criteria: Array.isArray(r.criteria) && r.criteria.length ? r.criteria : [''],
      constraints: Array.isArray(r.constraints) ? r.constraints : [],
      constraintsOther: Array.isArray(r.constraintsOther) ? r.constraintsOther.join('\n') : '',
      data: Array.isArray(r.dataHandling) ? r.dataHandling : [],
      parties: PARTY_LABEL[r.parties] || '社内のみ',
      approvals: Array.isArray(r.approvals) ? r.approvals : [],
      decides: r.decides || '',
      freq: r.frequency || '',
      minutes: r.minutesPerTime === null || r.minutesPerTime === undefined ? '' : String(r.minutesPerTime),
      dataReady: r.dataReady === null || r.dataReady === undefined ? '' : String(r.dataReady),
      spread: r.spread === null || r.spread === undefined ? '' : String(r.spread),
      wish: r.wishDate || '',
      attachments: [],
      approver: r.approver,
      status: r.status,
      signalFinal: r.signalDecided || '',
      history: (r.history || []).map((h) => ({ at: h.at, by: h.actorName, role: ROLE_LABEL[h.role] || h.role, action: h.action, note: h.note || '' })),
      comments: (r.comments || []).map((c) => ({ at: c.at, by: c.by, text: c.text })),
      // 内部用（画面には出さない）
      __v: r.version,
    };
  }

  /** コンソールの依頼 → サーバの依頼 */
  function toServer(it) {
    return {
      title: String(it.title || '').trim(),
      kind: KIND_CODE[it.kind] || 'new_tool',
      deptCode: it.dept,
      applicant: String(it.applicant || '').trim(),
      contact: it.contact ? String(it.contact) : null,
      toolId: toolIdOf(it.toolRef),
      problem: String(it.problem || '').trim(),
      purpose: String(it.purpose || '').trim(),
      users: it.users || [],
      people: num(it.people),
      places: it.places || [],
      scope: lines(it.scope),
      outOfScope: lines(it.outScope),
      criteria: (it.criteria || []).map((c) => String(c).trim()).filter(Boolean),
      decides: it.decides,
      dataHandling: it.data || [],
      parties: PARTY_CODE[it.parties] || 'internal',
      constraints: it.constraints || [],
      constraintsOther: lines(it.constraintsOther),
      approvals: it.approvals || [],
      frequency: it.freq || null,
      minutesPerTime: num(it.minutes),
      dataReady: num(it.dataReady),
      spread: num(it.spread),
      wishDate: it.wish || null,
      approver: String(it.approver || '').trim(),
      clientId: it.id && /^REQ-\d{4}-\d{4}$/.test(it.id) ? it.id : undefined,
    };
  }

  function contentSignature(it) {
    const s = toServer(it);
    delete s.clientId;
    return JSON.stringify(s);
  }

  /* ── 起動時: サーバデータをコンソールの保存形式へ ── */
  const items = boot.items.map(toConsole);
  const seq = Math.max(Number(boot.seq) || 0, ...items.map((i) => Number(String(i.id).slice(-4)) || 0), 0);
  const bootOps = boot.ops && boot.ops.data ? boot.ops.data : null;
  try {
    localStorage.setItem(KEY, JSON.stringify({ seq, items, ...(bootOps ? { ops: bootOps } : {}) }));
    // 下書きはサーバが正（端末をまたいで再開できる）。ただし、まだ送れていない端末の下書きは消さない。
    if (Array.isArray(boot.drafts) && boot.drafts.length) {
      let local = [];
      try {
        const parsed = JSON.parse(localStorage.getItem(KEY + '-drafts') || '[]');
        local = Array.isArray(parsed) ? parsed : [];
      } catch {
        local = [];
      }
      const byId = new Map();
      for (const d of local) if (d && d.id) byId.set(d.id, d);
      for (const d of boot.drafts) {
        if (!d || !d.id) continue;
        const mine = byId.get(d.id);
        const mineAt = mine && mine.at ? Date.parse(mine.at) : NaN;
        const serverAt = d.at ? Date.parse(d.at) : NaN;
        if (!mine || !(Number.isFinite(mineAt) && mineAt > serverAt)) byId.set(d.id, d);
      }
      // 端末にしか無い下書き（未送信）は残す
      const merged = [...byId.values()];
      localStorage.setItem(KEY + '-drafts', JSON.stringify(merged));
    }
  } catch {
    /* localStorage が使えない場合はコンソールのメモリ保持に任せる */
  }

  let opsSnapshot = bootOps ? JSON.stringify(bootOps) : null;
  let opsVersion = boot.ops && boot.ops.version ? boot.ops.version : 0;
  let opsTimer = null;

  async function putOps(data) {
    try {
      const res = await api('PUT', '/api/ops', { data, version: opsVersion });
      if (res && typeof res.version === 'number') opsVersion = res.version;
    } catch (err) {
      const message = (err && err.message) || '運用データを保存できませんでした';
      if (window.__MSF_UI__ && window.__MSF_UI__.toast) window.__MSF_UI__.toast(message, true);
      // 版番号が合わない＝ほかの端末が先に更新した。最新を読み込み直す（上書きしない）
      if (/先に更新|version/i.test(message)) setTimeout(() => location.reload(), 600);
    }
  }

  function scheduleOpsSync(data) {
    if (!data || !data.ops) return;
    const json = JSON.stringify(data.ops);
    if (json === opsSnapshot) return;
    opsSnapshot = json;
    clearTimeout(opsTimer);
    opsTimer = setTimeout(() => putOps(data.ops), 400);
  }

  let csrf = boot.csrf || '';
  const base = new Map(boot.items.map((r) => [r.id, r]));
  let syncing = false;
  let pending = false;

  async function api(method, path, body) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (csrf) headers['x-csrf-token'] = csrf;
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 403 && !path.startsWith('/api/auth/login')) {
      // セッションのCSRFが変わった可能性があるため1回だけ取り直す
      const c = await fetch('/api/auth/csrf', { credentials: 'same-origin' }).then((r) => r.json()).catch(() => null);
      if (c && c.csrf) {
        csrf = c.csrf;
        const retryHeaders = { ...headers, 'x-csrf-token': csrf };
        const retry = await fetch(path, { method, credentials: 'same-origin', headers: retryHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
        if (retry.ok) return retry.status === 204 ? null : retry.json();
      }
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const err = new Error((data && data.error && data.error.message) || '保存できませんでした');
      err.code = data && data.error && data.error.code;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function lastNote(it) {
    const h = (it.history || [])[it.history.length - 1];
    return h && h.note ? String(h.note) : '';
  }

  async function doSync(data) {
    const local = Array.isArray(data.items) ? data.items : [];
    const localIds = new Set(local.map((i) => i.id));
    // 1) 新規
    for (const it of local) {
      if (base.has(it.id)) continue;
      const res = await api('POST', '/api/requests', toServer(it));
      base.set(it.id, res.request);
    }
    // 2) 更新（状態 → 内容の順）
    for (const it of local) {
      const s = base.get(it.id);
      if (!s) continue;
      if (it.status && it.status !== s.status) {
        const payload = {
          to: it.status,
          version: s.version,
          reason: lastNote(it),
          checklistAcknowledged: true,
          redAcknowledged: true,
        };
        if (it.signalFinal) payload.signal = it.signalFinal;
        const res = await api('POST', `/api/requests/${encodeURIComponent(it.id)}/transitions`, payload);
        base.set(it.id, res.detail);
      } else if (contentSignature(it) !== contentSignature(toConsole(s))) {
        const res = await api('PATCH', `/api/requests/${encodeURIComponent(it.id)}`, { ...toServer(it), version: s.version });
        base.set(it.id, res.detail);
      }
      // 3) コメント（増えた分だけ）
      const sc = (s.comments || []).length;
      const lc = (it.comments || []).length;
      if (lc > sc) {
        for (const c of it.comments.slice(sc)) {
          if (!c || !c.text) continue;
          const res = await api('POST', `/api/requests/${encodeURIComponent(it.id)}/comments`, { text: c.text });
          base.set(it.id, res.detail);
        }
      }
    }
    // 4) 取消（コンソールから消えた依頼）
    for (const [id, s] of base.entries()) {
      if (!localIds.has(id) && !['done', 'hold', 'cancel'].includes(s.status)) {
        const res = await api('POST', `/api/requests/${encodeURIComponent(id)}/transitions`, {
          to: 'cancel',
          version: s.version,
          reason: 'コンソールから取消',
        });
        base.set(id, res.detail);
      }
    }
  }

  function persist(data) {
    scheduleOpsSync(data);
    if (syncing) {
      pending = true;
      return;
    }
    syncing = true;
    doSync(data)
      .catch((err) => {
        if (window.__MSF_UI__ && window.__MSF_UI__.toast) window.__MSF_UI__.toast(err.message || '保存できませんでした', true);
      })
      .finally(() => {
        syncing = false;
        if (pending) {
          pending = false;
          persist(data);
        }
      });
  }

  let draftTimers = new Map();
  function saveDraft(o) {
    if (!o || !o.draft) return Promise.resolve(null);
    const key = o.id || 'new';
    clearTimeout(draftTimers.get(key));
    return new Promise((resolve) => {
      draftTimers.set(
        key,
        setTimeout(() => {
          draftTimers.delete(key);
          const body = { draft: o.draft, step: o.step, editId: o.editId ?? null };
          const req = o.id ? api('PUT', `/api/drafts/${encodeURIComponent(o.id)}`, body) : api('POST', '/api/drafts', body);
          req.then(resolve).catch(() => resolve(null));
        }, 250),
      );
    });
  }

  function clearDraft(id) {
    for (const timer of draftTimers.values()) clearTimeout(timer);
    draftTimers.clear();
    return api('DELETE', id ? `/api/drafts/${encodeURIComponent(id)}` : '/api/drafts').catch(() => undefined);
  }

  function initialRole() {
    return ROLE_CODE[boot.role] ? boot.role : 'requester';
  }

  async function switchRole(role) {
    const mapped = ROLE_CODE[role];
    if (!mapped) return;
    try {
      await api('POST', '/api/auth/role', { role: mapped });
    } catch (err) {
      if (window.__MSF_UI__ && window.__MSF_UI__.toast) window.__MSF_UI__.toast(err.message, true);
    }
  }

  // ヘッダの「完全オフライン」表示を、サーバ保存であることに合わせる
  function relabel() {
    const el = document.querySelector('.offline');
    if (el) {
      el.innerHTML = '<i></i>サーバ保存（検証環境）';
      el.title = 'PostgreSQL に保存します（運用・DevOps・SecOps の一部は見本データ）';
    }
    const host = document.querySelector('.rolesw select');
    if (host && boot.user) host.title = `${boot.user.displayName}（${boot.user.email}）`;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', relabel);
  else relabel();

  // 初回起動時: サーバに運用データが無ければ、コンソールが生成した見本を保存して実データ化する
  function seedOpsIfNeeded() {
    if (opsSnapshot !== null) return;
    const d = window.__MSF_UI__ && window.__MSF_UI__.data ? window.__MSF_UI__.data() : null;
    if (d && d.ops) {
      opsSnapshot = JSON.stringify(d.ops);
      void putOps(d.ops);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(seedOpsIfNeeded, 800));
  else setTimeout(seedOpsIfNeeded, 800);

  window.__MSF__ = { initialRole, persist, switchRole, saveDraft, clearDraft, user: boot.user, api };
})();
