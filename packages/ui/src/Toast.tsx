import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

export interface ToastInput {
  message: string;
  /** Errors are role="alert", marked with a glyph and a text prefix, and stay until dismissed. */
  tone?: 'neutral' | 'error';
  /** One follow-up action such as Undo. Toasts with an action stay longer. */
  action?: { label: string; onClick(): void };
  durationMs?: number;
  /**
   * Move keyboard focus to the action when the toast appears. For when the control that had focus
   * has just been removed (a deleted card): focus would otherwise fall to <body>.
   */
  focusAction?: boolean;
}

interface ToastItem extends ToastInput {
  id: number;
}

interface ToastApi {
  push(toast: ToastInput): number;
  dismiss(id: number): void;
  /** Say `message` through this surface's one polite status region; nothing is shown. */
  announce(message: string): void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside <ToastProvider>');
  return api;
}

const MAX_TOASTS = 4;
const ANNOUNCEMENT_MS = 4_000;

/**
 * The surface's single polite live region. It is rendered before the page content (so it comes
 * first in the tab order when focus has fallen to <body>) and exists before any message does, so
 * screen readers announce what is put into it. Errors are separate role="alert" elements.
 *
 * `returnFocus` names where focus goes when a toast that held focus closes.
 */
export function ToastProvider({
  children,
  returnFocus,
}: {
  children: ReactNode;
  returnFocus?: () => HTMLElement | null;
}) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // `flip` makes a repeated sentence a text change, which is what gets announced.
  const [spoken, setSpoken] = useState({ text: '', flip: false });
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((all) => all.filter((t) => t.id !== id));
  }, []);
  const push = useCallback((toast: ToastInput) => {
    const id = nextId.current++;
    setToasts((all) => [...all, { ...toast, id }].slice(-MAX_TOASTS));
    return id;
  }, []);
  const announce = useCallback((text: string) => {
    setSpoken((s) => ({ text, flip: !s.flip }));
  }, []);
  const api = useMemo(() => ({ push, dismiss, announce }), [push, dismiss, announce]);

  useEffect(() => {
    if (spoken.text === '') return undefined;
    const timer = setTimeout(() => setSpoken({ text: '', flip: false }), ANNOUNCEMENT_MS);
    return () => clearTimeout(timer);
  }, [spoken]);

  const view = (t: ToastItem) => (
    <ToastView key={t.id} toast={t} dismiss={dismiss} returnFocus={returnFocus} />
  );

  return (
    <ToastContext.Provider value={api}>
      <div className="sv-toasts">
        <div className="sv-toasts__polite" role="status" aria-live="polite" aria-atomic="false">
          <span className="sv-sr">
            {spoken.text}
            {spoken.flip ? ' ' : ''}
          </span>
          {toasts.filter((t) => t.tone !== 'error').map(view)}
        </div>
        {toasts.filter((t) => t.tone === 'error').map(view)}
      </div>
      {children}
    </ToastContext.Provider>
  );
}

function ToastView({
  toast,
  dismiss,
  returnFocus,
}: {
  toast: ToastItem;
  dismiss(id: number): void;
  returnFocus: (() => HTMLElement | null) | undefined;
}) {
  // Hover/focus pauses the timer so the action can be reached without racing it.
  const [paused, setPaused] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const textId = useId();
  const { id, durationMs, action, focusAction } = toast;
  const error = toast.tone === 'error';

  const close = useCallback(
    (then?: () => void) => {
      const held = root.current?.contains(document.activeElement) ?? false;
      dismiss(id);
      then?.();
      // The element that held focus is about to disappear: hand focus to a stable place.
      if (held) queueMicrotask(() => returnFocus?.()?.focus());
    },
    [dismiss, id, returnFocus],
  );

  useEffect(() => {
    if (paused || error) return undefined;
    const timer = setTimeout(() => close(), durationMs ?? (action ? 10_000 : 5_000));
    return () => clearTimeout(timer);
  }, [paused, error, durationMs, action, close]);

  useEffect(() => {
    if (focusAction) root.current?.querySelector<HTMLElement>('[data-toast-action]')?.focus();
  }, [focusAction]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };

  return (
    <div
      ref={root}
      className={`sv-toast${error ? ' sv-toast--error' : ''}`}
      role={error ? 'alert' : undefined}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onKeyDown={onKeyDown}
    >
      {error ? (
        <>
          <span className="sv-toast__glyph" aria-hidden="true">
            ✕
          </span>
          <span className="sv-sr">Error: </span>
        </>
      ) : null}
      <span id={textId} className="sv-toast__text">
        {toast.message}
      </span>
      {action ? (
        <button
          type="button"
          className="sv-toast__btn"
          data-toast-action=""
          aria-describedby={textId}
          onClick={() => close(action.onClick)}
        >
          {action.label}
        </button>
      ) : null}
      <button
        type="button"
        className="sv-toast__btn sv-toast__close"
        aria-label="Dismiss notification"
        onClick={() => close()}
      >
        <span aria-hidden="true">✕</span>
      </button>
    </div>
  );
}
