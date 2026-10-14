import { Check, Layers } from 'lucide-react';
import { COLOR_SWATCH, type ColorId } from '@shared';
import { BarMeter } from '@ui';

/** A bank's icon (its emoji or first letter) on a tile tinted with the bank colour. */
export function BankTile({
  name,
  icon,
  color,
  size = 44,
}: {
  name: string;
  icon: string | null;
  color: ColorId | null;
  size?: number;
}) {
  return (
    <span
      className="bankcard__tile"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.48,
        background: color ? COLOR_SWATCH[color].bg : undefined,
      }}
    >
      {icon?.trim() || name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

export interface BankCardData {
  name: string;
  icon: string | null;
  color: ColorId | null;
  /** Highlights in the bank. */
  saved: number;
  /** Cards, or null while unknown. */
  cards: number | null;
  /** Measured retention (0..1); null: too few reviews ("n/a"); undefined: not known yet. */
  retention: number | null | undefined;
  /** Cards ready today, or null while unknown. */
  due: number | null;
}

/** Bank card (UX_DESIGN 7.3): tile, name, "12 saved · 4 cards", retention bar or n/a, due badge. */
export function BankCardView({
  bank,
  onOpen,
  testId,
}: {
  bank: BankCardData;
  onOpen?(): void;
  testId?: string;
}) {
  const pct = typeof bank.retention === 'number' ? Math.round(bank.retention * 100) : null;
  const status =
    bank.saved === 0 && !bank.cards ? (
      <span className="sv-badge sv-badge--info">New</span>
    ) : bank.due === null ? null : bank.due > 0 ? (
      <span className="bankcard__due">
        <Layers aria-hidden="true" strokeWidth={2.5} />
        {bank.due.toLocaleString()}
        <span className="sv-vh"> due</span>
      </span>
    ) : (
      <span className="bankcard__done">
        <Check aria-hidden="true" strokeWidth={3} />
        <span className="sv-vh">Nothing due</span>
      </span>
    );
  const body = (
    <>
      <span className="bankcard__top">
        <BankTile name={bank.name} icon={bank.icon} color={bank.color} />
        <span className="bankcard__text">
          <span className="bankcard__name" dir="auto">
            {bank.name}
          </span>
          <span className="bankcard__meta">
            {bank.saved.toLocaleString()} saved
            {bank.cards !== null ? ` · ${bank.cards.toLocaleString()} cards` : ''}
          </span>
        </span>
      </span>
      <span className="bankcard__progress">
        {pct !== null ? (
          <>
            <BarMeter
              value={pct}
              max={100}
              label={`${bank.name} recall`}
              valueText={`${pct}% recalled`}
              tone="success"
              size="sm"
              className="bankcard__bar"
            />
            <span className="bankcard__pct">{pct}%</span>
          </>
        ) : (
          <span className="bankcard__na">{bank.retention === null ? 'n/a' : ''}</span>
        )}
        {status}
      </span>
    </>
  );
  return onOpen ? (
    <button type="button" className="bankcard" onClick={onOpen} data-testid={testId}>
      {body}
    </button>
  ) : (
    <div className="bankcard" data-testid={testId}>
      {body}
    </div>
  );
}
