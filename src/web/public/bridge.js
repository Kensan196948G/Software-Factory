/**
 * みらいSF コンソール（mirai-construction-sf-console.html）と API/DB のブリッジ。
 *
 * - 起動時: サーバが HTML に注入した window.__MSF_BOOT__ を、コンソールの
 *   localStorage 形式（KEY: mirai-const-sf-console-v1）へ変換して書き込む。
 *   コンソールは従来どおり SF.load(KEY) で読み込む。
 * - 変更時: コンソールの persist() から persist() が呼ばれ、差分を API に同期する。
 *   結果は Promise で返し、失敗した依頼はサーバの最新（base）へ戻す。
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
  const ROLE_CODE = {
    requester: 'requester',
    desk: 'desk',
    approver: 'approver',
    ops: 'approver',
    sec: 'approver',
    admin: 'approver',
    auditor: 'approver',
  };

  const lines = (v) =>
    String(v || '')
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean);
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
      history: (r.history || []).map((h) => ({
        at: h.at,
        by: h.actorName,
        role: ROLE_LABEL[h.role] || h.role,
        action: h.action,
        note: h.note || '',
      })),
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
      const unsaved = local.filter((d) => d && !d.id); // サーバへ保存できていない端末の下書き
      for (const d of boot.drafts) {
        if (!d || !d.id) continue;
        const mine = byId.get(d.id);
        const mineAt = mine && mine.at ? Date.parse(mine.at) : NaN;
        const serverAt = d.at ? Date.parse(d.at) : NaN;
        if (!mine || !(Number.isFinite(mineAt) && mineAt > serverAt)) byId.set(d.id, d);
      }
      // 端末にしか無い下書き（未送信）は残す
      const merged = [...byId.values(), ...unsaved];
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

  async function api(method, path, body, extraHeaders) {
    const headers = { ...(extraHeaders || {}) };
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
      const c = await fetch('/api/auth/csrf', { credentials: 'same-origin' })
        .then((r) => r.json())
        .catch(() => null);
      if (c && c.csrf) {
        csrf = c.csrf;
        const retryHeaders = { ...headers, 'x-csrf-token': csrf };
        const retry = await fetch(path, {
          method,
          credentials: 'same-origin',
          headers: retryHeaders,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
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

  const CONFLICT_MESSAGE =
    '他の人が先に更新しました。最新の内容を読み込みました（入力は残しています）。内容を確かめて、もう一度操作してください';
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  /** 再描画が必要な差分だけを見る（履歴の時刻など、サーバとの細かな差では描き直さない） */
  function visibleSignature(it) {
    return JSON.stringify([
      it.id,
      it.status,
      it.signalFinal,
      contentSignature(it),
      (it.history || []).length,
      (it.comments || []).length,
    ]);
  }

  /** サーバの内容をローカルの依頼へ反映する。他の画面が参照を持つので、同じオブジェクトのまま更新する。 */
  function applyServer(live, server) {
    const next = toConsole(server);
    delete next.attachments; // 添付はサーバに無い（画面だけのメタ情報）
    delete live.__idem;
    delete live.__postAs;
    Object.assign(live, next);
  }

  /** 同期の成功後の反映。同期中に利用者が触った項目は残し、次の同期へ回す。 */
  function mergeServer(live, sent, server) {
    if (same(live, sent)) return applyServer(live, server);
    const next = toConsole(server);
    delete next.attachments;
    delete live.__idem;
    delete live.__postAs;
    for (const key of Object.keys(next)) {
      if (key === 'history' || key === 'comments') {
        const tail = (live[key] || []).slice((sent[key] || []).length);
        live[key] = [...next[key], ...tail];
      } else if (same(live[key], sent[key])) {
        live[key] = next[key];
      }
    }
  }

  /**
   * 依頼 1 件の同期。順序は 新規 → 内容（PATCH）→ 状態（返却された最新 version で）→ コメント。
   * 遷移するかどうかは PATCH 前の状態で決める（承認後の編集でサーバが承認待ちへ戻したとき、
   * 自動で承認へ遷移し直さないため）。途中で失敗しても、進んだ分は base に残る。
   * ctx.stages に工程ごとの結果（none / ok / failed）を残す。
   */
  async function syncItem(it, ctx) {
    const setBase = (detail) => {
      base.set(detail.id, detail);
      ctx.id = detail.id;
      return detail;
    };
    const path = (id) => `/api/requests/${encodeURIComponent(id)}`;
    const step = async (name, fn) => {
      ctx.current = name;
      await fn();
      ctx.stages[name] = 'ok';
    };
    let s = base.get(it.id);
    if (!s) {
      await step('create', async () => {
        // 応答が不明なまま入力が直されたときは、前回と同じ本文で照合してから PATCH で直す
        const body = toServer(it.__postAs || it);
        const res = await api('POST', '/api/requests', body, it.__idem ? { 'idempotency-key': it.__idem } : undefined);
        s = setBase(res.request);
      });
    }
    const wantsTransition = Boolean(it.status && it.status !== s.status);
    const serverComments = (s.comments || []).length;
    let warning = '';
    if (contentSignature(it) !== contentSignature(toConsole(s))) {
      await step('content', async () => {
        const res = await api('PATCH', path(s.id), { ...toServer(it), version: s.version });
        s = setBase(res.detail);
        const w = (res.warnings || []).find((x) => x.code === 'ERR-202');
        if (w) warning = w.message;
      });
    }
    let sentReason = false;
    if (wantsTransition && it.status !== s.status) {
      await step('transition', async () => {
        const reason = lastNote(it);
        const payload = {
          to: it.status,
          version: s.version,
          reason,
          checklistAcknowledged: true,
          redAcknowledged: true,
        };
        if (it.signalFinal) payload.signal = it.signalFinal;
        const res = await api('POST', `${path(s.id)}/transitions`, payload);
        s = setBase(res.detail);
        sentReason = Boolean(reason);
      });
    }
    // コメント（増えた分だけ）。遷移の理由はサーバがコメントにするので、理由として送った印の付いたものは送らない。
    const added = (it.comments || []).slice(serverComments).filter((c) => c && c.text && !(sentReason && c.__reason));
    if (added.length) {
      await step('comment', async () => {
        for (const c of added) {
          const res = await api('POST', `${path(s.id)}/comments`, { text: c.text });
          s = setBase(res.detail);
        }
      });
    }
    if (it.status && s.status !== it.status) {
      ctx.notice = { id: s.id, requested: it.status, actual: s.status, message: warning };
    }
  }

  /** 失敗の内容を、画面が扱う形にそろえる。ERR-301 は最新を取り直す（再送はしない）。 */
  async function describeFailure(err, ctx) {
    const code = (err && err.code) || null;
    const status = (err && err.status) || 0;
    let error = (err && err.message) || '保存できませんでした';
    if (!status) error = '通信できませんでした。接続を確かめて、もう一度お試しください';
    // 409 でも ERR-201（不正な遷移・権限）などは、サーバの理由をそのまま見せる
    if (code === 'ERR-301' || (status === 409 && !code)) {
      error = CONFLICT_MESSAGE;
      try {
        const res = await api('GET', `/api/requests/${encodeURIComponent(ctx.id)}`);
        if (res && res.request) base.set(res.request.id, res.request);
      } catch {
        /* 取り直せないときは手元の base のまま */
      }
    }
    const stage = ctx.current || null;
    if (stage && ctx.stages) ctx.stages[stage] = 'failed';
    if (stage === 'comment') {
      const prefix = ctx.stages.transition === 'ok' ? '状態の変更は保存しました。' : '';
      error = `${prefix}コメントを保存できませんでした（${error}）`;
    }
    return { id: ctx.localId, serverId: ctx.id, error, code, status, stage, stages: ctx.stages || null };
  }

  /** 1 回分の同期。送るのは呼び出し時点の写し。依頼ごとに独立して処理し、失敗した依頼だけ戻す。 */
  async function runSync(data) {
    const sent = clone(Array.isArray(data.items) ? data.items : []);
    const failures = [];
    const ids = {};
    const notices = [];
    const results = [];
    const stages = {};
    for (const it of sent) {
      const ctx = {
        localId: it.id,
        id: it.id,
        current: null,
        stages: { create: 'none', content: 'none', transition: 'none', comment: 'none' },
      };
      stages[it.id] = ctx.stages;
      let failure = null;
      try {
        await syncItem(it, ctx);
      } catch (err) {
        failure = await describeFailure(err, ctx);
        failures.push(failure);
      }
      if (ctx.id !== it.id) ids[it.id] = ctx.id;
      if (ctx.notice) notices.push(ctx.notice);
      results.push({ it, ctx, failure });
    }

    // コンソールから消えた依頼は取消にする。取消はサーバで戻せないので、同じ同期に 1 件でも失敗があれば行わず、
    // 消えた依頼を画面へ戻す（取り込みなどの全件置換は、全部の保存が成功したときだけ成立する）。
    const present = new Set(results.map((r) => r.ctx.id));
    const restore = [];
    for (const [id, s] of [...base.entries()]) {
      if (present.has(id)) continue;
      if (failures.length) {
        if (s.status !== 'cancel') restore.push(id);
        continue;
      }
      if (['done', 'hold', 'cancel'].includes(s.status)) continue;
      const ctx = {
        localId: id,
        id,
        current: 'transition',
        stages: { create: 'none', content: 'none', transition: 'none', comment: 'none' },
      };
      try {
        const res = await api('POST', `/api/requests/${encodeURIComponent(id)}/transitions`, {
          to: 'cancel',
          version: s.version,
          reason: 'コンソールから取消',
        });
        base.set(id, res.detail);
      } catch (err) {
        failures.push(await describeFailure(err, ctx));
        restore.push(id);
      }
    }

    // 画面側のデータへ結果を反映する
    let changed = false;
    const items = Array.isArray(data.items) ? data.items : [];
    const carried = [];
    for (const { it, ctx, failure } of results) {
      const live = items.find((x) => x.id === it.id);
      if (!live) continue;
      const before = visibleSignature(live);
      const server = base.get(ctx.id);
      if (failure) {
        // 同期中に触られた分も、同じ依頼は一緒に戻す（競合を上書きで再送しないため）。
        // その呼び出し元にも失敗を伝える。
        if (!same(live, it)) carried.push(failure);
        if (server) applyServer(live, server);
        else items.splice(items.indexOf(live), 1);
        changed = true;
        continue;
      }
      if (server) mergeServer(live, it, server);
      if (visibleSignature(live) !== before) changed = true;
      // 照合の結果、すでに一覧にある依頼だった場合は 1 行にまとめる
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i] !== live && items[i].id === live.id) {
          items.splice(i, 1);
          changed = true;
        }
      }
    }
    for (const id of restore) {
      const server = base.get(id);
      if (server && !items.some((x) => x.id === id)) {
        items.push(toConsole(server));
        changed = true;
      }
    }
    for (const id of [...Object.values(ids), ...restore]) {
      const n = Number(String(id).slice(-4));
      if (Number.isFinite(n) && n > (Number(data.seq) || 0)) data.seq = n;
    }
    return { failures, ids, notices, changed, carried, stages };
  }

  function toResult(outcome, carriedIn) {
    const failures = [...carriedIn, ...outcome.failures];
    const common = { ids: outcome.ids, notices: outcome.notices, stages: outcome.stages };
    if (!failures.length) return { ok: true, ...common };
    const first = failures[0];
    return { ok: false, error: first.error, code: first.code, status: first.status, failures, ...common };
  }

  let running = false;
  let queued = null;
  let carriedFailures = [];

  function notifyUi(changed) {
    const ui = window.__MSF_UI__;
    if (ui && ui.syncApplied) ui.syncApplied(changed);
  }

  /** 同期を 1 回走らせて結果を返す（必ず解決し、reject しない）。 */
  async function startRun(data) {
    running = true;
    const carriedIn = carriedFailures;
    carriedFailures = [];
    let result;
    try {
      const outcome = await runSync(data);
      carriedFailures = outcome.carried;
      notifyUi(outcome.changed);
      result = toResult(outcome, carriedIn);
    } catch (err) {
      const error = (err && err.message) || '保存できませんでした';
      result = { ok: false, error, code: null, status: 0, failures: carriedIn, ids: {}, notices: [], stages: {} };
    }
    running = false;
    if (queued) {
      const q = queued;
      queued = null;
      void startRun(q.data).then(q.resolve);
    } else {
      carriedFailures = [];
    }
    return result;
  }

  /**
   * 差分をサーバへ同期する。呼び出し時点の data を含む同期が終わると解決する。
   * { ok:true, ids, notices, stages } または { ok:false, error, code, status, failures, ids, notices, stages }。
   * stages[依頼ID] は工程（create / content / transition / comment）ごとの none / ok / failed。
   * failures[].stage は失敗した工程。
   * 同期中に呼ばれたら次の 1 回にまとめ、呼び出し元全員が同じ結果を受け取る。
   * opts.deferOps を付けると、この呼び出しでは運用データを送らない。
   */
  function persist(data, opts) {
    // 全件置換（取り込み・サンプルに戻す）は、依頼の同期が成功してから運用データを送る
    if (!(opts && opts.deferOps)) scheduleOpsSync(data);
    if (!running) return startRun(data);
    if (!queued) {
      let resolve;
      const promise = new Promise((r) => {
        resolve = r;
      });
      queued = { data, promise, resolve };
    } else {
      queued.data = data;
    }
    return queued.promise;
  }

  let draftTimers = new Map();
  const draftCreating = new WeakMap(); // 下書きオブジェクト → 作成（POST）の Promise
  function saveDraft(o) {
    if (!o || !o.draft) return Promise.resolve(null);
    const key = o.id || o.lk || 'new';
    clearTimeout(draftTimers.get(key));
    return new Promise((resolve) => {
      draftTimers.set(
        key,
        setTimeout(() => {
          draftTimers.delete(key);
          const body = { draft: o.draft, step: o.step, editId: o.editId ?? null };
          const put = (id) => api('PUT', `/api/drafts/${encodeURIComponent(id)}`, body);
          const post = () => {
            const created = api('POST', '/api/drafts', body);
            draftCreating.set(o.draft, created);
            return created;
          };
          let req;
          if (o.id) req = put(o.id);
          else if (draftCreating.has(o.draft)) {
            // 作成の応答を待ってから更新する（同じ下書きをサーバに二重に作らない）
            req = draftCreating.get(o.draft).then(
              (res) => (res && res.draft && res.draft.id ? put(res.draft.id) : post()),
              () => post(),
            );
          } else req = post();
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
