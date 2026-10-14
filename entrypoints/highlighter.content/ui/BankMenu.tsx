import { useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { COLOR_SWATCH, type BankLite } from '@shared';
import type { BankState } from './banks';
import { rove } from './context';
import { Icon } from './icons';

interface BankMenuProps {
  state: BankState;
  /** The bank the toolbar saves into right now (null while the list is not ready). */
  current: string | null;
  onPick(bankId: string): void;
  onRetry(): void;
  /** Opens the side panel, where a bank is named (no text is typed in the page). */
  onNewBank(): void;
  /** Escape or Tab: close and hand focus back to the chip. */
  onClose(): void;
}

export function BankDot({ bank }: { bank: BankLite }) {
  return (
    <span
      className="sv-bank-dot"
      aria-hidden="true"
      style={{ background: COLOR_SWATCH[bank.color].solid }}
    />
  );
}

const ITEM = 'sv-btn sv-menu-item';
const items = (menu: HTMLElement | null): HTMLElement[] =>
  Array.from(menu?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);

/**
 * The chip's menu of banks (WAI-ARIA APG menu button): focus moves to the checked bank when it opens
 * (or when the list arrives), arrows / Home / End move, Escape and Tab close it back to the chip.
 */
export function BankMenu({ state, current, onPick, onRetry, onNewBank, onClose }: BankMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  // A layout effect, like the More options panel: a key pressed right after the click must land here.
  useLayoutEffect(() => {
    const menu = ref.current;
    const active = menu && (menu.getRootNode() as ShadowRoot).activeElement;
    // A refresh (window focus) must not pull focus off an item the user has moved to.
    if (!menu || (active && active !== menu && menu.contains(active))) return;
    const list = items(menu);
    (list.find((el) => el.getAttribute('aria-checked') === 'true') ?? list[0] ?? menu).focus({
      preventScroll: true,
    });
  }, [state.status]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    const list = items(ref.current).filter((el) => el.getAttribute('aria-disabled') !== 'true');
    const next = rove(
      e.key,
      list.indexOf(e.target as HTMLElement),
      list.length,
      ['ArrowUp'],
      ['ArrowDown'],
    );
    if (next === -1) return;
    e.preventDefault();
    list[next]?.focus({ preventScroll: true });
  };

  return (
    <div
      ref={ref}
      className="sv-menu"
      role="menu"
      aria-label="Save to bank"
      aria-busy={state.status === 'loading'}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {state.status === 'ready' ? (
        <>
          {state.banks.map((bank) => (
            <button
              key={bank.id}
              type="button"
              className={ITEM}
              role="menuitemradio"
              aria-checked={bank.id === current}
              tabIndex={-1}
              onClick={() => onPick(bank.id)}
            >
              <BankDot bank={bank} />
              <span className="sv-menu-name">{bank.name}</span>
              {bank.id === current ? <Icon name="check" size={16} /> : null}
            </button>
          ))}
          {state.banks.length > 0 ? <div className="sv-menu-sep" role="separator" /> : null}
          <button type="button" className={ITEM} role="menuitem" tabIndex={-1} onClick={onNewBank}>
            <Icon name="plus" size={16} />
            New bank...
          </button>
        </>
      ) : (
        <div
          className={state.status === 'error' ? `${ITEM} sv-menu-error` : ITEM}
          role="menuitem"
          aria-disabled="true"
          tabIndex={-1}
        >
          {state.status === 'error' ? state.message : 'Loading banks…'}
        </div>
      )}
      {state.status === 'error' ? (
        <button type="button" className={ITEM} role="menuitem" tabIndex={-1} onClick={onRetry}>
          <Icon name="retry" size={16} />
          Retry
        </button>
      ) : null}
    </div>
  );
}
