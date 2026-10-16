// Pieces shared by several Sunny Vault screens.
import {
  Check,
  Copy,
  Ellipsis,
  FileInput,
  HardDrive,
  Layers,
  ListTree,
  LocateFixed,
  MessagesSquare,
  Network,
  RefreshCw,
  Settings,
  SlidersHorizontal,
  Sparkles,
  NotebookPen,
  Timer,
  Trash,
  TriangleAlert,
  Workflow,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { BANKS, type Bank, type Highlight } from './data';
import { Badge, Bar, IconButton } from './ui';

/** The current product icon (blue tile, yellow highlight bar) as a scalable mark. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="sv-logo">
      <rect width="32" height="32" rx="8" fill="#2a62e5" />
      <rect x="7" y="8" width="18" height="3" rx="1.5" fill="#fff" />
      <rect x="5.5" y="13.5" width="21" height="5" rx="2" fill="#ffc83d" />
      <rect x="8.5" y="15.2" width="15" height="1.6" rx="0.8" fill="#18213b" />
      <rect x="7" y="21" width="12" height="3" rx="1.5" fill="#fff" />
    </svg>
  );
}

/** Bank colour -> soft tile class (shared with the create-bank wizard). */
export const BANK_TONE: Record<string, string> = {
  blue: 'primary',
  sun: 'sun',
  pink: 'danger',
  green: 'success',
  violet: 'violet',
  orange: 'warning',
};

export const bankById = (id: string): Bank => BANKS.find((b) => b.id === id) ?? BANKS[0]!;

export function BankChip({ id }: { id: string }) {
  const b = bankById(id);
  return (
    <span className={`sv-bankchip sv-art--${BANK_TONE[b.colour] ?? 'primary'}`}>
      <span aria-hidden="true">{b.emoji}</span>
      {b.name}
    </span>
  );
}

export function BankTile({
  emoji,
  colour,
  size = 44,
}: {
  emoji: string;
  colour: string;
  size?: number;
}) {
  return (
    <span
      className={`sv-banktile sv-art--${BANK_TONE[colour] ?? 'primary'}`}
      style={{ width: size, height: size, fontSize: size * 0.5 }}
      aria-hidden="true"
    >
      {emoji}
    </span>
  );
}

export function BankCard({ bank, as = 'button' }: { bank: Bank; as?: 'button' | 'div' }) {
  const status =
    bank.highlights === 0 ? (
      <Badge tone="primary">New</Badge>
    ) : bank.due > 0 ? (
      <Badge tone="sun" icon={Layers}>
        {bank.due}
        <span className="sv-vh"> due</span>
      </Badge>
    ) : (
      <Badge tone="success" icon={Check}>
        <span className="sv-vh">Nothing due</span>
      </Badge>
    );
  const body = (
    <>
      <span className="sv-row sv-bankcard__top">
        <BankTile emoji={bank.emoji} colour={bank.colour} size={42} />
        <span className="sv-bankcard__text">
          <span className="sv-bankcard__name">{bank.name || 'Untitled'}</span>
          <span className="sv-bankcard__meta">
            {bank.highlights} saved · {bank.cards} cards
          </span>
        </span>
      </span>
      <span className="sv-row sv-bankcard__progress">
        <Bar
          value={bank.mastered}
          max={100}
          label={`${bank.name} mastered`}
          tone="success"
          size="sm"
        />
        <span className="sv-bankcard__pct">{bank.mastered}%</span>
        {status}
      </span>
    </>
  );
  return as === 'button' ? (
    <button type="button" className="sv-card sv-bankcard">
      {body}
    </button>
  ) : (
    <div className="sv-card sv-bankcard">{body}</div>
  );
}

export function HighlightCard({ h }: { h: Highlight }) {
  return (
    <article
      className={`sv-card sv-hlcard sv-hlcard--${h.colour}`}
      aria-label={`Highlight: ${h.quote.slice(0, 40)}…`}
    >
      <div className="sv-hlcard__body">
        {h.attention && (
          <Badge tone="warning" icon={TriangleAlert} className="sv-hlcard__flag">
            Not found
          </Badge>
        )}
        <blockquote className="sv-hlcard__quote">{h.quote}</blockquote>
        {h.note && (
          <p className="sv-hlcard__note">
            <NotebookPen aria-hidden="true" strokeWidth={2.4} />
            {h.note}
          </p>
        )}
        <div className="sv-hlcard__meta">
          <BankChip id={h.bank} />
          {h.tags.map((t) => (
            <span key={t} className="sv-tag">
              #{t}
            </span>
          ))}
        </div>
        <div className="sv-hlcard__actions">
          <IconButton
            icon={NotebookPen}
            label="Add note"
            className="sv-iconbtn--sm"
            tipSide="top"
          />
          <IconButton icon={Layers} label="Make card" className="sv-iconbtn--sm" tipSide="top" />
          <IconButton
            icon={LocateFixed}
            label="Show on page"
            className="sv-iconbtn--sm"
            tipSide="top"
          />
          <span className="sv-spacer" />
          <IconButton
            icon={Ellipsis}
            label="More actions"
            className="sv-iconbtn--sm"
            tipSide="left"
          />
        </div>
      </div>
    </article>
  );
}

export type MoreItem = {
  id: string;
  label: string;
  icon: LucideIcon;
  tone: string;
  badge?: string;
};

export const MORE_ITEMS: MoreItem[] = [
  { id: 'rules', label: 'Rules', icon: Workflow, tone: 'primary' },
  { id: 'syllabus', label: 'Syllabus', icon: ListTree, tone: 'success' },
  { id: 'graph', label: 'Graph', icon: Network, tone: 'violet' },
  { id: 'exam', label: 'Exam', icon: Timer, tone: 'danger' },
  { id: 'dupes', label: 'Duplicates', icon: Copy, tone: 'warning' },
  { id: 'imports', label: 'Imports', icon: FileInput, tone: 'primary' },
  { id: 'ai', label: 'AI', icon: Sparkles, tone: 'violet', badge: 'Off' },
  { id: 'sync', label: 'Sync', icon: RefreshCw, tone: 'success', badge: 'Off' },
  { id: 'trash', label: 'Trash', icon: Trash, tone: 'danger' },
  { id: 'storage', label: 'Storage', icon: HardDrive, tone: 'sun' },
  { id: 'fields', label: 'Fields', icon: SlidersHorizontal, tone: 'warning' },
  { id: 'chat', label: 'Chat', icon: MessagesSquare, tone: 'primary', badge: 'Off' },
  { id: 'settings', label: 'Settings', icon: Settings, tone: 'neutral' },
];

export function MoreGrid({ items = MORE_ITEMS, cols }: { items?: MoreItem[]; cols?: number }) {
  return (
    <ul
      className="sv-moregrid"
      style={cols ? { gridTemplateColumns: `repeat(${cols}, 1fr)` } : undefined}
    >
      {items.map(({ id, label, icon: Icon, tone, badge }) => (
        <li key={id}>
          <button type="button" className="sv-moretile">
            <span className={`sv-moretile__icon sv-art--${tone}`} aria-hidden="true">
              <Icon strokeWidth={2.4} />
            </span>
            <span className="sv-moretile__label">{label}</span>
            {badge && <span className="sv-moretile__badge">{badge}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}
