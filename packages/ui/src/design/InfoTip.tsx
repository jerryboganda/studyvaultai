import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Info, X } from 'lucide-react';

export type InfoTipProps = {
  /** Accessible name of the (i) button, e.g. "About streak freezes". */
  label: string;
  /** The detail kept out of the main UI (labels stay <= 3 words). */
  children: ReactNode;
  side?: 'bottom' | 'top';
  align?: 'center' | 'start' | 'end';
};

/**
 * (i) button with a popover (UX_DESIGN 6.12, as in the Sunny mockup): click, Enter or Space toggles
 * it; it never opens on hover. Escape closes only the popover (not a dialog around it) and puts
 * focus back on the button; a click outside or the close button closes it too. The text also
 * describes the button (aria-describedby), so a screen reader hears it without opening anything.
 */
export function InfoTip({ label, children, side = 'bottom', align = 'center' }: InfoTipProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    // Capture on the document: runs before React's root listener, so the dialog never sees it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      if (wrap.current?.contains(document.activeElement)) btn.current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <span className="sv-infotip" ref={wrap}>
      <button
        ref={btn}
        type="button"
        className="sv-infotip__btn"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        aria-describedby={`${id}-text`}
        onClick={() => setOpen(!open)}
      >
        <Info aria-hidden="true" strokeWidth={2.6} />
      </button>
      <span
        id={id}
        className={`sv-infotip__pop sv-infotip__pop--${side} sv-infotip__pop--${align}`}
        hidden={!open}
      >
        <span id={`${id}-text`}>{children}</span>
        <button
          type="button"
          className="sv-infotip__close"
          aria-label="Close"
          onClick={() => {
            setOpen(false);
            btn.current?.focus();
          }}
        >
          <X aria-hidden="true" strokeWidth={2.6} />
        </button>
      </span>
    </span>
  );
}
