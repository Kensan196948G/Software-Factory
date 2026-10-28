import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { SIGNAL_LABEL, STATUS_LABEL, type Signal, type Status } from '@shared/domain.js';

export function SignalPill({ signal, label }: { signal: Signal; label?: string }): React.ReactElement {
  return (
    <span className={`pill ${signal}`} title={`信号：${SIGNAL_LABEL[signal]}`}>
      {label ?? SIGNAL_LABEL[signal]}
    </span>
  );
}

export function StatusPill({ status }: { status: Status }): React.ReactElement {
  const closed = ['done', 'hold', 'cancel'].includes(status);
  return <span className={`pill ${closed ? 'n' : 'plain'}`}>{STATUS_LABEL[status]}</span>;
}

export function StaleBadge({ days, level }: { days: number; level: 'ok' | 'warn' | 'danger' }): React.ReactElement | null {
  if (days <= 0) return null;
  return <span className={`stale ${level === 'ok' ? '' : level}`}>{level === 'danger' ? `${days}日目（要対応）` : `${days}日目`}</span>;
}

export function Banner({
  kind = 'info',
  children,
  action,
}: {
  kind?: 'info' | 'warn' | 'err' | 'ok';
  children: ReactNode;
  action?: ReactNode;
}): React.ReactElement {
  return (
    <div className={`banner ${kind}`} role={kind === 'err' ? 'alert' : undefined}>
      <div className="grow">{children}</div>
      {action}
    </div>
  );
}

export function EmptyState({
  icon = '◫',
  title,
  children,
  action,
}: {
  icon?: string;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}): React.ReactElement {
  return (
    <div className="empty">
      <div className="ic" aria-hidden="true">
        {icon}
      </div>
      <div>
        <b>{title}</b>
        {children ? <div>{children}</div> : null}
      </div>
      {action}
    </div>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }): React.ReactElement {
  return (
    <div aria-busy="true" aria-live="polite" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span className="sr-only">読み込み中</span>
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="skeleton" style={{ width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  actions,
  small = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  small?: boolean;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const first = ref.current?.querySelector<HTMLElement>('button, input, select, textarea, [tabindex]');
    first?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div className="overlay center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${small ? 'small' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref} data-testid="modal">
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="btn ghost sm close-btn" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>
        {children}
        {actions ? <div className="modal-actions">{actions}</div> : null}
      </div>
    </div>
  );
}

export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="drawer" role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1} data-testid="drawer">
        {children}
      </div>
    </div>
  );
}

export interface ToastItem {
  id: number;
  message: string;
  kind?: 'ok' | 'err';
  undo?: () => void;
}

interface ToastApi {
  push: (message: string, opts?: { kind?: 'ok' | 'err'; undo?: () => void }) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const push = useCallback((message: string, opts?: { kind?: 'ok' | 'err'; undo?: () => void }) => {
    const id = ++seq.current;
    setItems((prev) => [...prev, { id, message, kind: opts?.kind, undo: opts?.undo }]);
    window.setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 7000);
  }, []);

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="toast-wrap" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind === 'err' ? 'err' : ''}`} role={t.kind === 'err' ? 'alert' : 'status'}>
            <span aria-hidden="true">{t.kind === 'err' ? '!' : '✓'}</span>
            <span>{t.message}</span>
            {t.undo ? (
              <button
                type="button"
                className="undo"
                onClick={() => {
                  t.undo?.();
                  setItems((prev) => prev.filter((x) => x.id !== t.id));
                }}
              >
                元に戻す
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('ToastProvider がありません');
  return ctx;
}

export function ProgressBand({ status }: { status: Status }): React.ReactElement {
  const order: Status[] = ['received', 'review', 'wait', 'approved', 'dev', 'verify', 'field', 'release_wait', 'done'];
  const idx = order.indexOf(status);
  return (
    <div className="progress" aria-label={`進み具合：${STATUS_LABEL[status]}`}>
      {order.map((s, i) => (
        <i key={s} className={idx >= 0 && i <= idx ? 'on' : ''} title={STATUS_LABEL[s]} />
      ))}
    </div>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  required,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  required?: boolean;
}): React.ReactElement {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>
        {label}
        {required ? <span style={{ color: 'var(--danger)' }}> *</span> : null}
      </label>
      {children}
      {hint && !error ? <div className="hint">{hint}</div> : null}
      {error ? (
        <div className="error-text" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
