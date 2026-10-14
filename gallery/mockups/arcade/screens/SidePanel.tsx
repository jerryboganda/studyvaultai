// Side panel (360 or 320 wide): mascot header with goal ring and streak, icon tab bar for the four
// core areas plus More, and the "This page" list of highlight cards.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import {
  AlertTriangle,
  FileText,
  Layers,
  LayoutDashboard,
  LayoutGrid,
  Library,
  LocateFixed,
  Play,
  Plus,
  Search,
  Settings,
  StickyNote,
  Trash2,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { BANKS, MORE, MORE_EXTRA, PAGE_HIGHLIGHTS, PLAYER, type Highlight } from '../data';
import {
  Bar,
  Button,
  Chip,
  Flash,
  IconButton,
  InfoTip,
  Kbd,
  Ring,
  Streak,
  Tag,
  useFlash,
} from '../ui';
import { VaultBuddy } from '../VaultBuddy';

type TabId = 'page' | 'banks' | 'review' | 'search' | 'more';

const TABS: { id: TabId; label: string; icon: LucideIcon; count?: number }[] = [
  { id: 'page', label: 'This page', icon: FileText },
  { id: 'banks', label: 'Banks', icon: Library },
  { id: 'review', label: 'Review', icon: Layers, count: PLAYER.due },
  { id: 'search', label: 'Search', icon: Search },
  { id: 'more', label: 'More', icon: LayoutGrid },
];

const bankOf = (name: string) => BANKS.find((b) => b.name === name);

function HighlightCard({
  h,
  onDelete,
  flash,
}: {
  h: Highlight;
  onDelete: () => void;
  flash: (m: string) => void;
}) {
  const bank = bankOf(h.bank);
  return (
    <article className={`sp-hl sv-c-${h.color}`} aria-label={`Highlight: ${h.quote.slice(0, 40)}…`}>
      <span className="sp-hl__stripe" aria-hidden />
      {h.attention && (
        <p className="sp-hl__attn">
          <span className="sv-badge sv-badge--warn">
            <AlertTriangle aria-hidden size={13} strokeWidth={2.8} /> Not found
          </span>
          <InfoTip label="Why not found">
            The page changed, so this passage could not be placed again. Your quote is kept safe.
          </InfoTip>
        </p>
      )}
      <blockquote className="sp-hl__quote">{h.quote}</blockquote>
      {h.note && (
        <p className="sp-hl__note">
          <StickyNote aria-hidden size={14} strokeWidth={2.6} /> {h.note}
        </p>
      )}
      <div className="sp-hl__foot">
        <span className="sp-hl__meta">
          {bank && (
            <Chip color={bank.color} icon={bank.icon}>
              {bank.name}
            </Chip>
          )}
          {h.tags.map((t) => (
            <Tag key={t}>{t}</Tag>
          ))}
        </span>
        <span className="sp-hl__actions">
          <IconButton
            label="Show on page"
            icon={LocateFixed}
            onClick={() => flash('Shown on the page')}
          />
          <IconButton label="Make card" icon={Layers} onClick={() => flash('Card made · +3 XP')} />
          <IconButton label="Delete" icon={Trash2} onClick={onDelete} />
        </span>
      </div>
    </article>
  );
}

function PagePanel({ empty, flash }: { empty: boolean; flash: (m: string) => void }) {
  const [items, setItems] = useState(PAGE_HIGHLIGHTS);
  const [undo, setUndo] = useState<{ h: Highlight; at: number } | null>(null);
  const undoBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (undo) undoBtn.current?.focus();
  }, [undo]);
  const list = empty ? [] : items;
  const attention = list.filter((h) => h.attention);
  const rest = list.filter((h) => !h.attention);
  const remove = (h: Highlight) => {
    setUndo({ h, at: items.indexOf(h) });
    setItems((xs) => xs.filter((x) => x !== h));
  };

  return (
    <>
      <div className="sp-page">
        <span className="sp-page__fav" aria-hidden>
          <FileText size={16} strokeWidth={2.6} />
        </span>
        <span className="sp-page__title">
          <b>Cell energy</b>
          <span>example.org</span>
        </span>
        <span className="sv-badge sv-badge--ok">On</span>
      </div>
      {list.length === 0 ? (
        <div className="sp-empty">
          <VaultBuddy pose="sleep" size={128} />
          <h3>Nothing saved here</h3>
          <p>Select text on the page to wake me up.</p>
          <p className="sp-empty__keys">
            <Kbd>Alt</Kbd>
            <Kbd>S</Kbd>
            <span>saves it</span>
          </p>
          <span className="sv-badge sv-badge--info">
            <Zap aria-hidden size={13} strokeWidth={2.8} /> +2 XP per save
          </span>
        </div>
      ) : (
        <div className="sp-list">
          {attention.length > 0 && (
            <>
              <h3 className="sv-eyebrow">Needs a look ({attention.length})</h3>
              {attention.map((h) => (
                <HighlightCard key={h.id} h={h} flash={flash} onDelete={() => remove(h)} />
              ))}
            </>
          )}
          <h3 className="sv-eyebrow">On this page ({rest.length})</h3>
          {rest.map((h) => (
            <HighlightCard key={h.id} h={h} flash={flash} onDelete={() => remove(h)} />
          ))}
        </div>
      )}
      {undo && (
        <div className="sp-toast" role="status">
          <span>Moved to Trash</span>
          <button
            ref={undoBtn}
            type="button"
            className="sp-toast__btn"
            onClick={() => {
              setItems((xs) => {
                const next = [...xs];
                next.splice(undo.at, 0, undo.h);
                return next;
              });
              setUndo(null);
            }}
          >
            Undo
          </button>
          <button
            type="button"
            className="sp-toast__x"
            aria-label="Dismiss"
            onClick={() => setUndo(null)}
          >
            ×
          </button>
        </div>
      )}
    </>
  );
}

function BanksPanel({ flash }: { flash: (m: string) => void }) {
  const [scope, setScope] = useState<string | null>(null);
  return (
    <div className="sp-pad">
      <ul className="sp-banks">
        {BANKS.map((b) => (
          <li key={b.id}>
            <button
              type="button"
              className={`sp-bank sv-c-${b.color}`}
              aria-pressed={scope === b.id}
              onClick={() => {
                const next = scope === b.id ? null : b.id;
                setScope(next);
                flash(next ? `Only ${b.name}` : 'Showing everything');
              }}
            >
              <span className="sp-bank__icon" aria-hidden>
                <b.icon size={20} strokeWidth={2.4} />
              </span>
              <span className="sp-bank__name">
                {b.name}
                <small>{b.items} items</small>
              </span>
              <span className="sv-badge">{b.due} due</span>
            </button>
          </li>
        ))}
      </ul>
      <Button icon={Plus} onClick={() => flash('New bank wizard')}>
        New bank
      </Button>
    </div>
  );
}

function ReviewPanel({ flash }: { flash: (m: string) => void }) {
  return (
    <div className="sp-pad sp-review">
      <div className="sp-due">
        <span className="sv-num sp-due__n">{PLAYER.due}</span>
        <span className="sp-due__label">cards due</span>
      </div>
      <p className="sp-mix">
        <span className="sv-badge sv-badge--info">{PLAYER.dueNew} new</span>
        <span className="sv-badge sv-badge--warn">4 learning</span>
        <span className="sv-badge sv-badge--ok">12 review</span>
      </p>
      <Button variant="primary" size="lg" icon={Play} onClick={() => flash('Review opened')}>
        Start review
      </Button>
      <h3 className="sv-eyebrow">By bank</h3>
      <ul className="sp-bybank">
        {BANKS.map((b) => (
          <li key={b.id}>
            <span className="sp-bybank__row">
              <span>{b.name}</span>
              <span className="sv-num">{b.due}</span>
            </span>
            <Bar
              value={b.due}
              max={PLAYER.due}
              size="sm"
              tone="pink"
              label={`${b.name}: ${b.due} due`}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function mark(text: string, q: string) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (!q || i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

function SearchPanel() {
  const [q, setQ] = useState('ATP');
  const id = useId();
  const hits = q.trim()
    ? PAGE_HIGHLIGHTS.filter((h) => h.quote.toLowerCase().includes(q.trim().toLowerCase()))
    : [];
  return (
    <div className="sp-pad">
      <label htmlFor={id} className="sv-sr">
        Search your vault
      </label>
      <div className="sp-search">
        <Search aria-hidden size={18} strokeWidth={2.6} />
        <input
          id={id}
          className="sv-input"
          type="search"
          value={q}
          placeholder="Search your vault"
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <p className="sp-hits" aria-live="polite">
        {q.trim() ? `${hits.length} ${hits.length === 1 ? 'match' : 'matches'}` : 'Works offline'}
      </p>
      {q.trim() && hits.length === 0 ? (
        <div className="sp-empty sp-empty--sm">
          <VaultBuddy pose="think" size={88} />
          <h3>No matches</h3>
        </div>
      ) : (
        <ul className="sp-results">
          {hits.map((h) => (
            <li key={h.id} className={`sp-result sv-c-${h.color}`}>
              <p>{mark(h.quote, q.trim())}</p>
              <span className="sp-result__meta">{h.bank} · example.org</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MorePanel({ flash }: { flash: (m: string) => void }) {
  return (
    <div className="sp-pad">
      <ul className="sp-more">
        {[...MORE, ...MORE_EXTRA].map((m) => (
          <li key={m.id}>
            <button
              type="button"
              className="sv-tile"
              onClick={() => flash(`${m.label} opens in the dashboard`)}
            >
              <span className="sv-tile__icon" aria-hidden>
                <m.icon size={20} strokeWidth={2.4} />
              </span>
              {m.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SidePanel({ empty }: { empty: boolean }) {
  const [tab, setTab] = useState<TabId>('page');
  const [msg, flash] = useFlash();
  const base = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKey = (e: KeyboardEvent, i: number) => {
    const last = TABS.length - 1;
    const next =
      e.key === 'ArrowRight'
        ? i === last
          ? 0
          : i + 1
        : e.key === 'ArrowLeft'
          ? i === 0
            ? last
            : i - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : -1;
    if (next < 0) return;
    e.preventDefault();
    const t = TABS[next];
    if (!t) return;
    setTab(t.id);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="sp">
      <header className="sp-head">
        <VaultBuddy pose="wave" size={38} />
        <Ring
          value={PLAYER.xpToday}
          max={PLAYER.goal}
          size={46}
          stroke={6}
          label={`Daily goal: ${PLAYER.xpToday} of ${PLAYER.goal} XP`}
        >
          <span className="sv-num sp-head__ring">{PLAYER.xpToday}</span>
        </Ring>
        <Streak days={PLAYER.streak} />
        <span className="sp-head__gap" />
        <IconButton
          tip="below"
          label="Open dashboard"
          icon={LayoutDashboard}
          onClick={() => flash('Dashboard opened')}
        />
        <IconButton
          tip="below-end"
          label="Settings"
          icon={Settings}
          onClick={() => flash('Settings opened')}
        />
      </header>
      <div className="sp-tabs" role="tablist" aria-label="Side panel">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`${base}-panel`}
            tabIndex={tab === t.id ? 0 : -1}
            className="sp-tab"
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            <span className="sp-tab__icon" aria-hidden>
              <t.icon size={20} strokeWidth={2.5} />
              {t.count !== undefined && <span className="sp-tab__count">{t.count}</span>}
            </span>
            <span className="sp-tab__label">{t.label}</span>
            {t.count !== undefined && <span className="sv-sr">, {t.count} due</span>}
          </button>
        ))}
      </div>
      <div
        className="sp-body"
        role="tabpanel"
        id={`${base}-panel`}
        aria-labelledby={`${base}-tab-${tab}`}
        tabIndex={0}
      >
        {tab === 'page' && <PagePanel empty={empty} flash={flash} />}
        {tab === 'banks' && <BanksPanel flash={flash} />}
        {tab === 'review' && <ReviewPanel flash={flash} />}
        {tab === 'search' && <SearchPanel />}
        {tab === 'more' && <MorePanel flash={flash} />}
      </div>
      <Flash msg={msg} />
    </div>
  );
}
