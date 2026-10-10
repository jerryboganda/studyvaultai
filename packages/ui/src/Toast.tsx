import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export interface ToastInput {
  message: string;
  tone?: 'neutral' | 'error';
  /** One follow-up action such as Undo. Toasts with an action stay longer. */
  action?: { label: string; onClick(): void };
  durationMs?: number;
}

interface ToastItem extends ToastInput {
  id: number;
}

interface ToastApi {
  push(toast: ToastInput): number;
  dismiss(id: number): void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside <ToastProvider>');
  return api;
}

const MAX_TOASTS = 4;

/** Polite live region: the region exists before any toast does, so screen readers announce them. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((all) => all.filter((t) => t.id !== id));
  }, []);
  const push = useCallback((toast: ToastInput) => {
    const id = nextId.current++;
    setToasts((all) => [...all, { ...toast, id }].slice(-MAX_TOASTS));
    return id;
  }, []);
  const api = useMemo(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="sv-toasts" role="status" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <ToastView key={t.id} toast={t} dismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastView({ toast, dismiss }: { toast: ToastItem; dismiss(id: number): void }) {
  // Hover/focus pauses the timer so the action can be reached without racing it.
  const [paused, setPaused] = useState(false);
  const { id, durationMs, action } = toast;

  useEffect(() => {
    if (paused) return undefined;
    const timer = setTimeout(() => dismiss(id), durationMs ?? (action ? 10_000 : 5_000));
    return () => clearTimeout(timer);
  }, [paused, id, durationMs, action, dismiss]);

  return (
    <div
      className={`sv-toast${toast.tone === 'error' ? ' sv-toast--error' : ''}`}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="sv-toast__text">{toast.message}</span>
      {action ? (
        <button
          type="button"
          className="sv-toast__btn"
          onClick={() => {
            dismiss(id);
            action.onClick();
          }}
        >
          {action.label}
        </button>
      ) : null}
      <button
        type="button"
        className="sv-toast__btn sv-toast__close"
        aria-label="Dismiss notification"
        onClick={() => dismiss(id)}
      >
        <span aria-hidden="true">✕</span>
      </button>
    </div>
  );
}
