import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api.js';
import { useAuth } from '../auth.js';
import { Banner, Field, Modal, SignalPill, useToast } from '../components/ui.js';
import {
  APPROVALS,
  CONSTRAINTS,
  DATA_HANDLING,
  DATA_READY,
  DECIDES_LABEL,
  FREQUENCIES,
  KINDS,
  KIND_LABEL,
  PARTIES,
  PARTY_LABEL,
  PLACES,
  SIGNAL_LABEL,
  SPREAD,
  USERS,
  checkCriteria,
  computeMeasure,
  evaluateSignal,
  rewriteGroupsFor,
  type Decides,
  type FrequencyKey,
  type Kind,
  type Party,
} from '@shared/domain.js';
import type { CatalogTool, DepartmentRow, RequestDetail } from '@shared/types.js';

interface Draft {
  title: string;
  kind: Kind;
  deptCode: string;
  applicant: string;
  contact: string;
  toolId: string;
  problem: string;
  purpose: string;
  users: string[];
  people: string;
  places: string[];
  scope: string;
  outOfScope: string;
  criteria: string[];
  decides: Decides | '';
  dataHandling: string[];
  parties: Party;
  constraints: string[];
  constraintsOther: string;
  approvals: string[];
  frequency: FrequencyKey | '';
  minutesPerTime: string;
  dataReady: '' | '1' | '3' | '5';
  spread: '' | '1' | '3' | '5';
  wishDate: string;
  approver: string;
}

const EMPTY: Draft = {
  title: '',
  kind: 'new_tool',
  deptCode: 'dx',
  applicant: '',
  contact: '',
  toolId: '',
  problem: '',
  purpose: '',
  users: [],
  people: '',
  places: [],
  scope: '',
  outOfScope: '',
  criteria: [''],
  decides: '',
  dataHandling: [],
  parties: 'internal',
  constraints: ['いまのログイン方法は変えない', '本物のデータを練習用の場所に持ち込まない'],
  constraintsOther: '',
  approvals: [],
  frequency: '',
  minutesPerTime: '',
  dataReady: '',
  spread: '',
  wishDate: '',
  approver: '鈴木 一郎',
};

const STEP_LABELS = [
  'だれの、どんな困りごと',
  '何を作るか',
  'だれが・どこで使う',
  'この道具がすること',
  '合格の条件',
  '扱う情報・守ること',
  '確認して登録',
];

interface ApiErrorLike {
  code?: string;
  message?: string;
}

export function NewRequest(): React.ReactElement {
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();
  const editId = params.get('edit');
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>({ ...EMPTY, applicant: user?.displayName ?? '', deptCode: user?.deptCode ?? 'dx' });
  const [version, setVersion] = useState<number | null>(null);
  const [departments, setDepartments] = useState<DepartmentRow[]>([]);
  const [tools, setTools] = useState<CatalogTool[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [resume, setResume] = useState<{ payload: Draft; step: number; editId: string | null; at: string } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    api.get<{ items: DepartmentRow[] }>('/api/catalog/departments').then((r) => setDepartments(r.items)).catch(() => undefined);
    api.get<{ items: CatalogTool[] }>('/api/catalog/tools').then((r) => setTools(r.items)).catch(() => undefined);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        if (editId) {
          const res = await api.get<{ request: RequestDetail }>(`/api/requests/${editId}`);
          const r = res.request;
          setDraft({
            ...EMPTY,
            title: r.title,
            kind: r.kind,
            deptCode: r.deptCode,
            applicant: r.applicant,
            contact: r.contact ?? '',
            toolId: r.toolId ?? '',
            problem: r.problem,
            purpose: r.purpose,
            users: r.users,
            people: r.people ? String(r.people) : '',
            places: r.places,
            scope: r.scope.join('\n'),
            outOfScope: r.outOfScope.join('\n'),
            criteria: r.criteria.length ? r.criteria : [''],
            decides: r.decides,
            dataHandling: r.dataHandling,
            parties: r.parties,
            constraints: r.constraints,
            constraintsOther: r.constraintsOther.join('\n'),
            approvals: r.approvals,
            frequency: r.frequency ?? '',
            minutesPerTime: r.minutesPerTime ? String(r.minutesPerTime) : '',
            dataReady: r.dataReady ? (String(r.dataReady) as '1' | '3' | '5') : '',
            spread: r.spread ? (String(r.spread) as '1' | '3' | '5') : '',
            wishDate: r.wishDate ?? '',
            approver: r.approver,
          });
          setVersion(r.version);
        } else {
          const d = await api.get<{ draft: { payload: Draft; step: number; editId: string | null; at: string } | null }>('/api/draft');
          if (d.draft && isMeaningful(d.draft.payload)) setResume(d.draft);
        }
      } finally {
        setLoaded(true);
      }
    })();
  }, [editId]);

  // カタログから「この道具で依頼を作る」で来た場合の初期値
  useEffect(() => {
    const toolId = params.get('tool');
    if (!toolId || editId || tools.length === 0) return;
    const tool = tools.find((t) => t.id === toolId);
    if (!tool) return;
    setDraft((prev) => (prev.toolId ? prev : { ...prev, toolId: tool.id, deptCode: tool.deptCode, title: prev.title || tool.name }));
  }, [tools, params, editId]);

  // 下書きの自動保存（0.4秒後）
  useEffect(() => {
    if (!loaded || editId) return;
    if (!isMeaningful(draft)) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      api
        .put('/api/draft', { draft, step, editId: null })
        .then(() => setSavedAt(new Date()))
        .catch(() => undefined);
    }, 400);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [draft, step, loaded, editId]);

  const selectedTool = tools.find((t) => t.id === draft.toolId) ?? null;
  const signal = useMemo(
    () =>
      evaluateSignal({
        decides: draft.decides || null,
        catalogSignal: selectedTool?.signal ?? null,
        dataHandling: draft.dataHandling,
        parties: draft.parties,
        approvals: draft.approvals,
      }),
    [draft.decides, draft.dataHandling, draft.parties, draft.approvals, selectedTool?.signal],
  );
  const measure = computeMeasure({
    people: Number(draft.people || 0),
    frequency: draft.frequency || null,
    minutesPerTime: Number(draft.minutesPerTime || 0),
  });

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: '' }));
  };

  const toggle = (key: 'users' | 'places' | 'dataHandling' | 'constraints' | 'approvals', value: string) => {
    setDraft((prev) => {
      const list = prev[key];
      return { ...prev, [key]: list.includes(value) ? list.filter((v) => v !== value) : [...list, value] };
    });
    setErrors((prev) => ({ ...prev, [key]: '' }));
  };

  const validateStep = (s: number): boolean => {
    const e: Record<string, string> = {};
    if (s === 0) {
      if (!draft.title.trim()) e.title = '件名を入れてください';
      else if (draft.title.length > 60) e.title = '件名は60文字までです';
      if (!draft.problem.trim()) e.problem = '困っていることを入れてください';
      if (!draft.purpose.trim()) e.purpose = '目的を入れてください';
    }
    if (s === 1) {
      if (!lines(draft.scope).length) e.scope = '作るものを1つ以上入れてください';
    }
    if (s === 2) {
      if (draft.users.length === 0) e.users = 'だれが使う？を1つ以上選んでください';
    }
    if (s === 3) {
      if (!draft.decides) e.decides = 'この道具がすることを選んでください';
    }
    if (s === 4) {
      const filled = draft.criteria.map((c) => c.trim()).filter(Boolean);
      if (filled.length === 0) e.criteria = '合格の条件を1つ以上入れてください';
      else if (filled.length > 8) e.criteria = '合格の条件は8件までです';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const go = (delta: number) => {
    if (delta > 0 && !validateStep(step)) return;
    setStep((s) => Math.min(6, Math.max(0, s + delta)));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const submit = async () => {
    for (let s = 0; s <= 4; s += 1) {
      if (!validateStep(s)) {
        setStep(s);
        return;
      }
    }
    const payload = {
      title: draft.title.trim(),
      kind: draft.kind,
      deptCode: draft.deptCode,
      applicant: draft.applicant.trim() || (user?.displayName ?? ''),
      contact: draft.contact.trim() || null,
      toolId: draft.toolId || null,
      problem: draft.problem.trim(),
      purpose: draft.purpose.trim(),
      users: draft.users,
      people: draft.people === '' ? null : Number(draft.people),
      places: draft.places,
      scope: lines(draft.scope),
      outOfScope: lines(draft.outOfScope),
      criteria: draft.criteria.map((c) => c.trim()).filter(Boolean),
      decides: draft.decides,
      dataHandling: draft.dataHandling,
      parties: draft.parties,
      constraints: draft.constraints,
      constraintsOther: lines(draft.constraintsOther),
      approvals: draft.approvals,
      frequency: draft.frequency || null,
      minutesPerTime: draft.minutesPerTime === '' ? null : Number(draft.minutesPerTime),
      dataReady: draft.dataReady === '' ? null : Number(draft.dataReady),
      spread: draft.spread === '' ? null : Number(draft.spread),
      wishDate: draft.wishDate || null,
      approver: draft.approver.trim() || '鈴木 一郎',
    };
    setBusy(true);
    setSubmitError(null);
    try {
      if (editId && version !== null) {
        const res = await api.patch<{ detail: RequestDetail; warnings?: ApiErrorLike[] }>(`/api/requests/${editId}`, { ...payload, version });
        toast.push(` ${editId} を更新しました`);
        if (res.warnings?.length) toast.push(res.warnings[0]?.message ?? '承認をやり直してください', { kind: 'err' });
        navigate(`/?request=${editId}`);
      } else {
        const key = crypto.randomUUID();
        const res = await api.post<{ request: RequestDetail }>('/api/requests', payload, { 'idempotency-key': key });
        await api.del('/api/draft').catch(() => undefined);
        toast.push(`${res.request.id} を登録しました`);
        navigate(`/?request=${res.request.id}`);
      }
    } catch (err) {
      setSubmitError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    await api.del('/api/draft').catch(() => undefined);
    setDraft({ ...EMPTY, applicant: user?.displayName ?? '', deptCode: user?.deptCode ?? 'dx' });
    setStep(0);
    setSavedAt(null);
    toast.push('下書きを破棄しました');
  };

  if (!loaded) return <div className="skeleton" style={{ height: 200 }} />;

  return (
    <>
      {resume ? (
        <Modal
          title="書きかけの依頼があります"
          small
          onClose={() => setResume(null)}
          actions={
            <>
              <button type="button" className="btn" onClick={() => { setResume(null); void discard(); }}>破棄して新しく始める</button>
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  setDraft({ ...EMPTY, ...resume.payload });
                  setStep(Math.min(6, Math.max(0, resume.step)));
                  setResume(null);
                  toast.push('書きかけの依頼の続きから再開します');
                }}
              >
                続きから再開
              </button>
            </>
          }
        >
          <p style={{ fontSize: 13 }}>
            「{resume.payload.title || '（件名なし）'}」の入力が {new Date(resume.at).toLocaleString('ja-JP')} に保存されています（STEP {resume.step + 1}）。
          </p>
        </Modal>
      ) : null}

      <div className="wizard">
        <nav className="stepper" aria-label="入力ステップ">
          {STEP_LABELS.map((label, i) => (
            <div key={label} className={`step ${i === step ? 'on' : i < step ? 'done' : ''}`}>
              <span className="no">{i < step ? '✓' : i + 1}</span>
              <span>{label}</span>
            </div>
          ))}
        </nav>

        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div className="crumb">STEP {step + 1} / 7{editId ? `（${editId} を編集中）` : ''}</div>
            <h2 style={{ fontSize: 18 }}>{STEP_LABELS[step]}</h2>
          </div>

          {step === 0 ? (
            <>
              <Field label="件名" htmlFor="title" required error={errors.title} hint="60文字まで。あとから直せます。">
                <input id="title" className="input" value={draft.title} maxLength={60} aria-invalid={Boolean(errors.title)} onChange={(e) => set('title', e.target.value)} />
              </Field>
              <div className="grid-2">
                <Field label="所属部署" htmlFor="dept" required>
                  <select id="dept" className="select" value={draft.deptCode} onChange={(e) => set('deptCode', e.target.value)}>
                    {departments.map((d) => (
                      <option key={d.code} value={d.code}>{d.name}</option>
                    ))}
                  </select>
                </Field>
                <Field label="起票者" htmlFor="applicant" required>
                  <input id="applicant" className="input" value={draft.applicant} onChange={(e) => set('applicant', e.target.value)} />
                </Field>
              </div>
              <div className="grid-2">
                <Field label="依頼区分" htmlFor="kind" required>
                  <select id="kind" className="select" value={draft.kind} onChange={(e) => set('kind', e.target.value as Kind)}>
                    {KINDS.map((k) => (
                      <option key={k} value={k}>{KIND_LABEL[k]}</option>
                    ))}
                  </select>
                </Field>
                <Field label="連絡先（任意）" htmlFor="contact">
                  <input id="contact" className="input" value={draft.contact} onChange={(e) => set('contact', e.target.value)} placeholder="内線・携帯など" />
                </Field>
              </div>
              <Field label="いま困っていること" htmlFor="problem" required error={errors.problem} hint="だれが・いつ・どれくらい困っているかを書くと伝わります。">
                <textarea id="problem" className="textarea" value={draft.problem} aria-invalid={Boolean(errors.problem)} onChange={(e) => set('problem', e.target.value)} />
              </Field>
              <Field label="目的（どうなればよいか）" htmlFor="purpose" required error={errors.purpose}>
                <textarea id="purpose" className="textarea" value={draft.purpose} aria-invalid={Boolean(errors.purpose)} onChange={(e) => set('purpose', e.target.value)} />
              </Field>
            </>
          ) : null}

          {step === 1 ? (
            <>
              <Field label="近い道具（カタログ）" htmlFor="tool" hint="選ぶと件名・部署・信号の候補に反映されます。カタログ外でも登録できます。">
                <select
                  id="tool"
                  className="select"
                  value={draft.toolId}
                  onChange={(e) => {
                    const id = e.target.value;
                    const tool = tools.find((t) => t.id === id);
                    setDraft((prev) => ({
                      ...prev,
                      toolId: id,
                      ...(tool ? { deptCode: tool.deptCode, title: prev.title || tool.name, decides: prev.decides || (tool.signal === 'r' ? 'r' : tool.signal === 'y' ? 'y' : 'g') } : {}),
                    }));
                  }}
                >
                  <option value="">カタログ外</option>
                  {tools.map((t) => (
                    <option key={t.id} value={t.id}>{t.id} {t.name}（{SIGNAL_LABEL[t.signal]}）</option>
                  ))}
                </select>
              </Field>
              <Field label="作るもの" htmlFor="scope" required error={errors.scope} hint="1行に1項目。箇条書きの記号は自動で除きます。">
                <textarea id="scope" className="textarea" value={draft.scope} aria-invalid={Boolean(errors.scope)} onChange={(e) => set('scope', e.target.value)} placeholder={'圏外での一時保存\n電波が戻った時の自動送信'} />
              </Field>
              <Field label="今回は作らない" htmlFor="outOfScope" hint="作りすぎ・手戻りを防ぎます。空だと承認前に△になります。">
                <textarea id="outOfScope" className="textarea" value={draft.outOfScope} onChange={(e) => set('outOfScope', e.target.value)} placeholder={'発注者システムへの直接提出\n写真の加工・編集'} />
              </Field>
            </>
          ) : null}

          {step === 2 ? (
            <>
              <Field label="だれが使う？" required error={errors.users}>
                <div className="check-grid">
                  {USERS.map((u) => (
                    <label key={u} className={`check-chip ${draft.users.includes(u) ? 'on' : ''}`}>
                      <input type="checkbox" checked={draft.users.includes(u)} onChange={() => toggle('users', u)} />
                      {u}
                    </label>
                  ))}
                </div>
              </Field>
              <Field label="どこで使う？">
                <div className="check-grid">
                  {PLACES.map((p) => (
                    <label key={p} className={`check-chip ${draft.places.includes(p) ? 'on' : ''}`}>
                      <input type="checkbox" checked={draft.places.includes(p)} onChange={() => toggle('places', p)} />
                      {p}
                    </label>
                  ))}
                </div>
              </Field>
              <Field label="人数（任意）" htmlFor="people">
                <input id="people" className="input" type="number" min={0} value={draft.people} onChange={(e) => set('people', e.target.value)} />
              </Field>
            </>
          ) : null}

          {step === 3 ? (
            <>
              <Field label="この道具がすること" required error={errors.decides} hint="「決める」を選ぶと赤信号になります。AIに決めさせない範囲です。">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {(['g', 'y', 'r'] as Decides[]).map((d) => (
                    <label key={d} className={`check-chip ${draft.decides === d ? 'on' : ''}`} style={{ borderRadius: 8, padding: '8px 10px' }}>
                      <input type="radio" name="decides" checked={draft.decides === d} onChange={() => set('decides', d)} />
                      <b>{SIGNAL_LABEL[d === 'g' ? 'g' : d === 'y' ? 'y' : 'r']}</b>　{DECIDES_LABEL[d]}
                    </label>
                  ))}
                </div>
              </Field>
              <div className="banner info">
                <div className="grow">
                  <b>信号の候補：<SignalPill signal={signal.color} /></b>
                  <ul style={{ margin: '4px 0 0 16px', fontSize: 12 }}>
                    {signal.reasons.map((r) => <li key={r}>{r}</li>)}
                  </ul>
                  <div className="hint" style={{ marginTop: 6 }}>最終決定は承認者が行います。社外や個人情報が関わっても、自動では赤になりません。</div>
                </div>
              </div>
            </>
          ) : null}

          {step === 4 ? (
            <>
              <p className="hint">「使いやすい」「早く」などは人によって受け取り方がちがいます。数字や「〜できる／できない」で書くと検査できます（1件以上・最大8件）。</p>
              {draft.criteria.map((c, i) => {
                const check = checkCriteria(c);
                const groups = rewriteGroupsFor(c);
                return (
                  <div key={i} className={`criteria-item ${check.kind === 'ok' ? 'ok' : c.trim() ? 'warn' : ''}`}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <b style={{ fontSize: 12 }}>合格の条件 {i + 1}</b>
                      {c.trim() ? <span className={`pill ${check.kind === 'ok' ? 'ok' : 'y'} plain`}>{check.kind === 'ok' ? 'OK' : 'あいまい'}</span> : null}
                      {draft.criteria.length > 1 ? (
                        <button type="button" className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={() => set('criteria', draft.criteria.filter((_, idx) => idx !== i))}>
                          削除
                        </button>
                      ) : null}
                    </div>
                    <input className="input" value={c} aria-invalid={check.kind !== 'ok' && c.trim() !== ''} onChange={(e) => set('criteria', draft.criteria.map((v, idx) => (idx === i ? e.target.value : v)))} />
                    {check.kind !== 'ok' && check.message ? <div className="error-text" style={{ color: 'var(--warn)' }}>{check.message}</div> : null}
                    {groups.map((g) => (
                      <div key={g.id} className="rewrite">
                        <b>{g.words.find((w) => c.includes(w)) ?? ''} の書きかえ候補</b>
                        <div>{g.hint}</div>
                        <div className="ex">
                          {g.examples.map((ex) => (
                            <button
                              key={ex}
                              type="button"
                              className="btn sm"
                              onClick={() => {
                                set('criteria', draft.criteria.map((v, idx) => (idx === i ? ex : v)));
                                toast.push('置きかえました。選ばれている「〇〇」に、そのまま入力できます');
                              }}
                            >
                              {ex}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })}
              {errors.criteria ? <div className="error-text" role="alert">{errors.criteria}</div> : null}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button type="button" className="btn sm" disabled={draft.criteria.length >= 8} onClick={() => set('criteria', [...draft.criteria, ''])}>＋ 条件を追加</button>
                <button type="button" className="btn sm" onClick={() => set('criteria', [...draft.criteria.filter((c) => c.trim()), '〇〇しても消えない'])}>
                  よく使う書き方を追加
                </button>
              </div>
            </>
          ) : null}

          {step === 5 ? (
            <>
              <Field label="扱う情報" hint="選ぶと信号の候補が黄以上になります。">
                <div className="check-grid">
                  {DATA_HANDLING.map((d) => (
                    <label key={d.key} className={`check-chip ${draft.dataHandling.includes(d.key) ? 'on' : ''}`}>
                      <input type="checkbox" checked={draft.dataHandling.includes(d.key)} onChange={() => toggle('dataHandling', d.key)} />
                      {d.label}
                    </label>
                  ))}
                </div>
              </Field>
              <Field label="関わる相手" htmlFor="parties">
                <select id="parties" className="select" value={draft.parties} onChange={(e) => set('parties', e.target.value as Party)}>
                  {PARTIES.map((p) => (
                    <option key={p} value={p}>{PARTY_LABEL[p]}</option>
                  ))}
                </select>
              </Field>
              <Field label="守ること">
                <div className="check-grid">
                  {CONSTRAINTS.map((c) => (
                    <label key={c} className={`check-chip ${draft.constraints.includes(c) ? 'on' : ''}`}>
                      <input type="checkbox" checked={draft.constraints.includes(c)} onChange={() => toggle('constraints', c)} />
                      {c}
                    </label>
                  ))}
                </div>
              </Field>
              <Field label="必ず人に聞くこと">
                <div className="check-grid">
                  {APPROVALS.map((a) => (
                    <label key={a} className={`check-chip ${draft.approvals.includes(a) ? 'on' : ''}`}>
                      <input type="checkbox" checked={draft.approvals.includes(a)} onChange={() => toggle('approvals', a)} />
                      {a}
                    </label>
                  ))}
                </div>
              </Field>
              <div className="grid-3">
                <Field label="頻度" htmlFor="frequency">
                  <select id="frequency" className="select" value={draft.frequency} onChange={(e) => set('frequency', e.target.value as FrequencyKey | '')}>
                    <option value="">未選択</option>
                    {FREQUENCIES.map((f) => (
                      <option key={f.key} value={f.key}>{f.label}</option>
                    ))}
                  </select>
                </Field>
                <Field label="1回あたりの手間（分）" htmlFor="minutes">
                  <input id="minutes" className="input" type="number" min={0} value={draft.minutesPerTime} onChange={(e) => set('minutesPerTime', e.target.value)} />
                </Field>
                <Field label="月あたり削減見込み">
                  <div className="input" style={{ background: 'var(--surface-2)' }}>{measure.toFixed(1)} h/月</div>
                </Field>
              </div>
              <div className="grid-2">
                <Field label="元になるデータ" htmlFor="dataReady">
                  <select id="dataReady" className="select" value={draft.dataReady} onChange={(e) => set('dataReady', e.target.value as '' | '1' | '3' | '5')}>
                    <option value="">未選択</option>
                    {DATA_READY.map((d) => (
                      <option key={d.value} value={String(d.value)}>{d.label}</option>
                    ))}
                  </select>
                </Field>
                <Field label="広げられる範囲" htmlFor="spread">
                  <select id="spread" className="select" value={draft.spread} onChange={(e) => set('spread', e.target.value as '' | '1' | '3' | '5')}>
                    <option value="">未選択</option>
                    {SPREAD.map((s) => (
                      <option key={s.value} value={String(s.value)}>{s.label}</option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="grid-2">
                <Field label="承認者" htmlFor="approver" required>
                  <select id="approver" className="select" value={draft.approver} onChange={(e) => set('approver', e.target.value)}>
                    {['鈴木 一郎', '田中 誠司', '松本 綾'].map((a) => (
                      <option key={a} value={a}>{a}</option>
                    ))}
                  </select>
                </Field>
                <Field label="希望時期（任意）" htmlFor="wish">
                  <input id="wish" className="input" type="date" value={draft.wishDate} onChange={(e) => set('wishDate', e.target.value)} />
                </Field>
              </div>
            </>
          ) : null}

          {step === 6 ? (
            <>
              <div className="banner info">
                <div className="grow">
                  <b>この内容で登録します</b>
                  <div className="hint">登録すると受付番号が付き、受付担当の確認待ちになります。</div>
                </div>
                <SignalPill signal={signal.color} />
              </div>
              <dl className="dl">
                <dt>件名</dt><dd>{draft.title}</dd>
                <dt>部署</dt><dd>{departments.find((d) => d.code === draft.deptCode)?.name ?? draft.deptCode}</dd>
                <dt>起票者</dt><dd>{draft.applicant}</dd>
                <dt>依頼区分</dt><dd>{KIND_LABEL[draft.kind]}</dd>
                <dt>困っていること</dt><dd>{draft.problem}</dd>
                <dt>目的</dt><dd>{draft.purpose}</dd>
                <dt>作るもの</dt><dd>{lines(draft.scope).join(' / ')}</dd>
                <dt>今回は作らない</dt><dd>{lines(draft.outOfScope).join(' / ') || '（未設定）'}</dd>
                <dt>だれが使う</dt><dd>{draft.users.join('・')}</dd>
                <dt>合格の条件</dt><dd>{draft.criteria.filter((c) => c.trim()).map((c, i) => <div key={i}>{i + 1}. {c}</div>)}</dd>
                <dt>信号の候補</dt><dd><SignalPill signal={signal.color} /> {signal.reasons.join(' / ')}</dd>
                <dt>承認者</dt><dd>{draft.approver}</dd>
              </dl>
              {submitError ? <Banner kind="err">{submitError}</Banner> : null}
            </>
          ) : null}

          <div className="sticky-actions">
            <button type="button" className="btn" disabled={step === 0} onClick={() => go(-1)}>戻る</button>
            {!editId ? (
              <button type="button" className="btn ghost" onClick={() => void discard()}>下書きを破棄</button>
            ) : null}
            <span className="hint" style={{ marginLeft: 'auto' }}>{savedAt ? `✓ 下書きを自動保存しました ${savedAt.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}` : ''}</span>
            {step < 6 ? (
              <button type="button" className="btn primary" onClick={() => go(1)}>次へ（STEP {step + 2}）</button>
            ) : (
              <button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>{busy ? '登録中…' : editId ? 'この内容で更新する' : 'この内容で登録する'}</button>
            )}
          </div>
        </div>

        <aside className="card preview" style={{ background: 'var(--surface-2)', position: 'sticky', top: 80 }}>
          <div className="card-head">
            <h3>注文書プレビュー</h3>
            <span className="count">{signal.color === 'r' ? '赤' : signal.color === 'y' ? '黄' : '青'}</span>
          </div>
          <pre className="pre">{buildPreview(draft, signal.color)}</pre>
          <div className="hint" style={{ marginTop: 6 }}>入力に合わせて更新されます。</div>
        </aside>
      </div>
    </>
  );
}

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((v) => v.replace(/^\s*[-・●]\s*/, '').trim())
    .filter(Boolean);
}

function isMeaningful(d: Partial<Draft> | null | undefined): boolean {
  if (!d) return false;
  return Boolean(d.toolId || d.title?.trim() || d.problem?.trim() || d.purpose?.trim() || d.scope?.trim() || (d.criteria ?? []).some((c) => c.trim()));
}

function buildPreview(draft: Draft, signal: string): string {
  const q = (v: string) => `"${(v ?? '').replace(/\n/g, ' ').replace(/"/g, '\\"')}"`;
  const list = (key: string, vals: string[]) => (vals.length ? [`${key}:`, ...vals.map((v) => ` - ${q(v)}`)] : [`${key}: []`]);
  return [
    `id: "（登録時に採番）"`,
    `title: ${q(draft.title || '（件名）')}`,
    `department: ${q(draft.deptCode)}`,
    `signal:`,
    `  suggested: ${q(SIGNAL_LABEL[signal as 'g' | 'y' | 'r'] ?? '青')}`,
    ...list('scope', lines(draft.scope)),
    ...list('out_of_scope', lines(draft.outOfScope)),
    ...list('acceptance_criteria', draft.criteria.map((c) => c.trim()).filter(Boolean)),
  ].join('\n');
}
