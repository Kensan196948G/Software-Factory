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

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const approverState = (() => {
    if (!Array.isArray(boot.approvers)) {
      return {
        available: false,
        reason: '承認者一覧を取得できないため、承認者を選択できません。',
        items: [],
      };
    }
    const seen = new Set();
    const items = [];
    for (const entry of boot.approvers) {
      if (
        !entry ||
        typeof entry !== 'object' ||
        typeof entry.id !== 'string' ||
        !UUID_RE.test(entry.id) ||
        typeof entry.displayName !== 'string' ||
        !entry.displayName.trim()
      ) {
        return {
          available: false,
          reason: '承認者一覧に無効な項目があるため、承認者を選択できません。',
          items: [],
        };
      }
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      items.push({
        id: entry.id,
        displayName: entry.displayName.trim(),
        email: typeof entry.email === 'string' ? entry.email : '',
        deptCode: typeof entry.deptCode === 'string' ? entry.deptCode : '',
      });
    }
    return { available: true, reason: '', items };
  })();
  const approvers = approverState.items;
  const approverById = new Map(approvers.map((a) => [a.id, a]));
  const user =
    boot.user &&
    typeof boot.user === 'object' &&
    !Array.isArray(boot.user) &&
    typeof boot.user.id === 'string' &&
    UUID_RE.test(boot.user.id) &&
    typeof boot.user.displayName === 'string' &&
    boot.user.displayName.trim()
      ? boot.user
      : null;
  if (!user) {
    window.__MSF__ = null;
    return; // The boot marker keeps the console fail-closed, not in standalone sample mode.
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
      applicantUserId: r.applicantUserId || null,
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
      approverUserId: r.approverUserId || null,
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
      __orderVersion: r.orderVersion === null || r.orderVersion === undefined ? 0 : r.orderVersion,
      __issueNo: r.issueNo === null || r.issueNo === undefined ? null : r.issueNo,
      // 依頼ごとの投入先（L-12）。null は未指定（サーバの既定＝DEVLINE_TARGET_REPOS の先頭）
      __targetRepo: r.targetRepoId || null,
    };
  }

  /** コンソールの依頼 → サーバの依頼 */
  function toServer(it) {
    const activeApprover = approverState.available && it.approverUserId ? approverById.get(it.approverUserId) : null;
    const server = {
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
      approver: activeApprover ? activeApprover.displayName : String(it.approver || '').trim(),
      clientId: it.id && /^REQ-\d{4}-\d{4}$/.test(it.id) ? it.id : undefined,
    };
    // 投入先（L-12）は内容の同期では送らない（キー無し＝サーバが現状維持）。
    // 台帳から外れた値でも、無関係な内容の編集が ERR-405 にならないようにする。
    // 変更は専用の口（setTargetRepo → PATCH /api/requests/:id/devline-target）だけ。
    if (it.approverUserId) server.approverUserId = it.approverUserId;
    return server;
  }

  function requireSelectedApprover(it) {
    if (!approverState.available || !it.approverUserId || !approverById.has(it.approverUserId)) {
      const error = new Error('有効な承認者を利用者IDで選び直してください。名前だけでは保存できません');
      error.code = 'ERR-004';
      error.status = 400;
      throw error;
    }
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
  // 画面から外したあと、取消の対象にならなかった依頼（完了・見送り）。後の同期の失敗で画面へ戻さない
  const retired = new Set();
  // 画面に無い依頼を詳細から採用した直後、画面への反映が遅れても取消の対象にしないための印。
  const adopted = new Set();

  async function api(method, path, body, extraHeaders) {
    const headers = { ...(extraHeaders || {}) };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (csrf) headers['x-csrf-token'] = csrf;
    let res = await fetch(path, {
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
        // 再試行の応答が実際の結果。最初の 403 で報告すると、結果不明や競合を取り違える
        res = retry;
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
      err.details = (data && data.error && data.error.details) || null;
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

  /** 作られたときのままではない（作成は version 1、状態 received、受付の履歴 1 行、コメントなし）。 */
  function touchedSinceCreate(detail) {
    return (
      detail.version !== 1 ||
      detail.status !== 'received' ||
      (detail.history || []).length > 1 ||
      (detail.comments || []).length > 0
    );
  }

  /** 再描画が必要な差分だけを見る（履歴の時刻など、サーバとの細かな差では描き直さない） */
  function visibleSignature(it) {
    return JSON.stringify([
      it.id,
      it.status,
      it.signalFinal,
      it.__orderVersion,
      it.__issueNo,
      it.__targetRepo,
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
        requireSelectedApprover(it.__postAs || it);
        const body = toServer(it.__postAs || it);
        const res = await api('POST', '/api/requests', body, it.__idem ? { 'idempotency-key': it.__idem } : undefined);
        s = setBase(res.request);
      });
      // 照合で返った依頼を他の人が更新していたら、最新の版で上書きしない。利用者が競合の画面で選ぶまで何も送らない
      if (it.__idem && touchedSinceCreate(s)) {
        await step('content', async () => {
          const err = new Error(CONFLICT_MESSAGE);
          err.code = 'ERR-301';
          err.status = 409;
          throw err;
        });
      }
    }
    const wantsTransition = Boolean(it.status && it.status !== s.status);
    const serverComments = (s.comments || []).length;
    let warning = '';
    if (contentSignature(it) !== contentSignature(toConsole(s))) {
      await step('content', async () => {
        requireSelectedApprover(it);
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
    // 画面に現れた採用済みの依頼は、以後は通常の削除判定に戻す。
    for (const id of present) adopted.delete(id);
    const restore = [];
    for (const [id, s] of [...base.entries()]) {
      if (present.has(id)) continue;
      // 詳細から採用したが、まだ画面のデータへ反映されていない依頼を取消さない
      // （詳細を閉じた・別の依頼へ移った直後の競合で、依頼を消してしまうのを防ぐ）。
      if (adopted.has(id)) continue;
      if (failures.length) {
        if (s.status !== 'cancel' && !retired.has(id)) restore.push(id);
        continue;
      }
      if (['done', 'hold', 'cancel'].includes(s.status)) {
        retired.add(id);
        continue;
      }
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
      } else {
        if (server) mergeServer(live, it, server);
        if (visibleSignature(live) !== before) changed = true;
      }
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
  // running は門を待っている間も立つ。実際に送っている間だけ syncing を立て、始まるたびに syncEpoch を進める
  let syncing = false;
  let syncEpoch = 0;
  let queued = null;
  let handoffGate = Promise.resolve();
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
      // 投入の途中で古い version の保存を走らせない（投入の確定で version が上がる）
      await handoffGate;
      syncing = true;
      syncEpoch += 1;
      let outcome;
      try {
        outcome = await runSync(data);
      } finally {
        syncing = false;
      }
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

  /* ── 開発ラインへの投入（API-06） ── */

  const REFRESH_MAX_TRIES = 5;

  /**
   * サーバの依頼を取り直して base と画面へ反映する。API-06 は status / version を返さないので GET する。
   * 同期と重ねない。送信済みで base に未反映のコメントを含む応答を反映すると、手元のコメントが二重になり次の同期で再送される。
   * 同期の間は待ち、取得の間に同期が始まった応答は捨てて取り直す。門を待つ同期は待たない（投入は門を持ったままここへ来る）。
   */
  async function refreshRequest(id) {
    let res;
    for (let tries = 0; ; tries += 1) {
      if (tries >= REFRESH_MAX_TRIES) return false; // 手元のまま（次の読み込みで取り直す）
      while (syncing) await new Promise((r) => setTimeout(r, 50));
      const epoch = syncEpoch;
      try {
        res = await api('GET', `/api/requests/${encodeURIComponent(id)}`);
      } catch {
        return false; // 取り直せないときは手元のまま（次の保存で 409 になり、そこで取り直す）
      }
      if (!syncing && epoch === syncEpoch) break;
    }
    if (!res || !res.request) return false;
    // 同期が先に進めた版を、遅れて届いた古い応答で戻さない
    const prev = base.get(res.request.id);
    if (prev && prev.version > res.request.version) return true;
    base.set(res.request.id, res.request);
    const ui = window.__MSF_UI__;
    const data = ui && ui.data ? ui.data() : null;
    const live = data && Array.isArray(data.items) ? data.items.find((x) => x.id === res.request.id) : null;
    if (live) {
      const before = visibleSignature(live);
      // 投入の待ちの間に利用者が触った項目は残し、続く同期で送る
      if (prev) mergeServer(live, toConsole(prev), res.request);
      else applyServer(live, res.request);
      notifyUi(visibleSignature(live) !== before);
    }
    return true;
  }

  /**
   * 画面に無い依頼（別の端末で作られた等）を、詳細ごと取り直して画面のレコードにする。
   * 正規の取り直し（refreshRequest）を通すので base も同じ内容で揃う。画面の依頼を詳細で
   * 置き換えるだけなので、次の同期で作り直し（POST）や空の履歴での上書きは起きない。
   * 取れないときは null（画面の依頼は増やさない）。
   */
  async function adoptRequest(id) {
    const ok = await refreshRequest(id);
    if (!ok) return null;
    const s = base.get(id);
    if (!s) return null;
    const rec = toConsole(s);
    // 採用した依頼を画面のデータへも入れる。呼び出し側が詳細を閉じた・別の依頼へ移った
    // 直後でも、base だけに存在して次の同期で「画面から消えた＝取消」と誤判定されるのを防ぐ。
    adopted.add(id);
    const ui = window.__MSF_UI__;
    const data = ui && ui.data ? ui.data() : null;
    if (data && Array.isArray(data.items) && !data.items.some((x) => x.id === id)) {
      data.items.push(rec);
    }
    return rec;
  }

  /**
   * 一覧の要約（サーバの最新）と、未同期の編集を項目単位でマージする。
   * サーバの新しい status / 決定色 / 滞留日数 / 更新時刻は反映し、利用者がまだ送れていない
   * 項目（base と異なる項目）だけ手元を残す。履歴・コメントは一覧に含まれないため手元を残す。
   */
  function mergeSummary(local, item) {
    const fresh = toConsole(item);
    const s = base.get(local.id);
    if (!s) return fresh;
    const prev = toConsole(s);
    const merged = { ...fresh };
    delete merged.history;
    delete merged.comments;
    for (const key of Object.keys(merged)) {
      if (Object.prototype.hasOwnProperty.call(local, key) && !same(local[key], prev[key])) {
        merged[key] = local[key];
      }
    }
    merged.history = Array.isArray(local.history) ? local.history : [];
    merged.comments = Array.isArray(local.comments) ? local.comments : [];
    return merged;
  }

  /**
   * 画面の依頼がサーバの base と同じ内容か（未同期の編集が無いか）。
   * 一覧のサーバ絞り込みで、サーバの最新を表示してよいかの判定に使う。
   */
  function sameAsServer(it) {
    if (!it || typeof it.id !== 'string') return false;
    const s = base.get(it.id);
    if (!s) return false; // サーバに無い（まだ作っていない）→ 未同期として扱う
    return contentSignature(it) === contentSignature(toConsole(s));
  }

  /** 失敗を画面が扱う種類に分ける。ERR-304 は details.handoffState でしか区別できない。 */
  function handoffFailure(err) {
    const code = (err && err.code) || null;
    const status = (err && err.status) || 0;
    const details = (err && err.details) || {};
    const message = (err && err.message) || '';
    const of = (kind) => ({ ok: false, kind, code, status, message, details });
    if (!status) return of('network');
    // 別のリポジトリの結果不明も ERR-405 で返る。ここでは照合できないのでサーバの理由を出す
    if (code === 'ERR-405') return of('not_connected');
    if (details.handoffState === 'unknown') return of('unknown');
    if (code === 'ERR-205') return of('not_approved');
    if (code === 'ERR-202') return of('stale');
    if (code === 'ERR-301') return of('in_progress');
    if (code === 'ERR-302') return of('rate_limited');
    if (code === 'ERR-101') return of('denied');
    if (code === 'ERR-304') return of(details.handoffState === 'failed' ? 'rejected' : 'connect');
    return of('error');
  }

  /**
   * 注文書を開発ラインへ投入する。必ず解決し、reject しない。
   * { ok:true, result } または { ok:false, kind, code, status, message, details }。
   * 投入の確定で request.version が上がるので、応答の後にサーバの依頼を取り直す。
   */
  async function handoff(id, orderVersion, opts) {
    // 役割の切替を待つ間に同期が始まりうるので、先に待つ。同期の完了の確認から門の設置までは同期的に行う
    await roleSwitch;
    while (running) await new Promise((r) => setTimeout(r, 50));
    let done = () => undefined;
    const mine = new Promise((r) => {
      done = r;
    });
    handoffGate = handoffGate.then(() => mine);
    try {
      const body = { orderVersion };
      if (opts && opts.confirmAbsent) {
        body.confirmAbsent = true;
        body.reason = opts.reason;
      }
      const result = await api('POST', `/api/orders/${encodeURIComponent(id)}/handoff`, body);
      await refreshRequest(id);
      return { ok: true, result };
    } catch (err) {
      const failure = handoffFailure(err);
      // 確定が走ったかもしれない応答と、版が変わった応答は取り直す
      if (failure.kind !== 'not_connected' && failure.kind !== 'denied') await refreshRequest(id);
      return failure;
    } finally {
      done();
    }
  }

  /** job と投入の記録を読む。取得できなければ null（画面では未接続）。 */
  async function readJobs(id) {
    try {
      return await api('GET', `/api/requests/${encodeURIComponent(id)}/jobs`);
    } catch {
      return null;
    }
  }

  /* ── 依頼ごとの投入先（L-12） ── */

  /**
   * 投入先の候補。サーバが設定（DEVLINE_TARGET_REPOS）と許可台帳の積集合だけを返す。
   * 取れなければ null（画面は選択欄を出さず、既定のまま投入する）。1 回だけ読んで使い回す。
   */
  let targetRepoCache = null;
  let targetRepoPending = null;
  async function targetRepos() {
    if (targetRepoCache) return targetRepoCache;
    if (!targetRepoPending) {
      targetRepoPending = api('GET', '/api/devline/target-repos')
        .then((res) => {
          targetRepoCache = {
            items: Array.isArray(res && res.items) ? res.items : [],
            defaultRepo: (res && res.defaultRepo) || null,
          };
          return targetRepoCache;
        })
        .catch(() => null)
        .finally(() => {
          targetRepoPending = null;
        });
    }
    return targetRepoPending;
  }

  /**
   * 依頼の投入先を変える。内容の編集ではないので版（version・order_version）と承認は動かない
   * （サーバの PATCH /api/requests/:id/devline-target）。必ず解決し、reject しない。
   * 成功しても失敗してもサーバの依頼を取り直す（画面の選択を、サーバの値に合わせる）。
   */
  async function setTargetRepo(id, repoId) {
    await roleSwitch;
    while (running) await new Promise((r) => setTimeout(r, 50));
    let done = () => undefined;
    const mine = new Promise((r) => {
      done = r;
    });
    handoffGate = handoffGate.then(() => mine);
    try {
      const value = repoId === undefined || repoId === null || repoId === '' ? null : String(repoId);
      const result = await api('PATCH', `/api/requests/${encodeURIComponent(id)}/devline-target`, { targetRepoId: value });
      targetRepoCache = null; // 設定が変わっていることがあるので次に読み直す
      await refreshRequest(id);
      return { ok: true, result };
    } catch (err) {
      await refreshRequest(id);
      return {
        ok: false,
        code: (err && err.code) || null,
        status: (err && err.status) || 0,
        message: (err && err.message) || '投入先を変えられませんでした',
      };
    } finally {
      done();
    }
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

  let roleSwitch = Promise.resolve();
  function switchRole(role) {
    const mapped = ROLE_CODE[role];
    if (!mapped) return Promise.resolve();
    roleSwitch = roleSwitch
      .then(() => api('POST', '/api/auth/role', { role: mapped }))
      .catch((err) => {
        if (window.__MSF_UI__ && window.__MSF_UI__.toast) window.__MSF_UI__.toast(err.message, true);
      });
    return roleSwitch;
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

  // Cloudflare Access のログアウト URL（サーバが起動データへ入れる）。形が違う値は使わない。
  const logoutUrl = (() => {
    const raw = boot.auth && typeof boot.auth.logoutUrl === 'string' ? boot.auth.logoutUrl : '';
    try {
      const u = new URL(raw);
      if (u.protocol !== 'https:' || !/\.cloudflareaccess\.com$/.test(u.hostname)) return null;
      if (u.pathname !== '/cdn-cgi/access/logout') return null;
      return u.origin + u.pathname;
    } catch {
      return null;
    }
  })();

  window.__MSF__ = {
    initialRole,
    persist,
    switchRole,
    logoutUrl,
    saveDraft,
    clearDraft,
    approvers,
    approverState,
    user,
    api,
    handoff,
    readJobs,
    refreshRequest,
    targetRepos,
    setTargetRepo,
    // サーバの一覧応答（GET /api/requests の items）を画面の依頼レコードへ直す。
    // 一覧の絞り込みをサーバへ任せたとき（L-08）、起動データに無い依頼も同じ形で描くために使う。
    toRecord: toConsole,
    // 画面に無い依頼の詳細を取り直して画面へ加える（base も揃える）
    adoptRequest,
    // 画面の依頼がサーバの base と同じか（未同期の編集が無いか）
    sameAsServer,
    // 一覧の要約（サーバの最新）と未同期の編集を項目単位でマージする
    mergeSummary,
  };
})();
