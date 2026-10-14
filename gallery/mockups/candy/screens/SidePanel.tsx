// Side panel (360/320 wide): mascot header with goal ring and streak, icon tab bar for the core
// (This page, Banks, Review, Search) plus More, and highlight cards for the current page.
import { useId, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import {
  Check,
  CircleCheck,
  Ellipsis,
  Eye,
  FileText,
  Globe,
  Layers,
  LayoutGrid,
  Library,
  LoaderCircle,
  MapPinOff,
  Play,
  Plus,
  Search,
  StickyNote,
  Trash,
  TriangleAlert,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import { BANKS, HIGHLIGHTS, ME, MORE, bankOf, kindOf, type Highlight } from '../data';
import { VaultBuddy } from '../VaultBuddy';
import {
  Bar,
  Btn,
  IconButton,
  InfoTip,
  Ring,
  StreakFlame,
  TabBar,
  useGo,
  type TabDef,
} from '../ui';
import { SearchBox } from './Search';

type Tab = 'page' | 'banks' | 'review' | 'search' | 'more';

export function SidePanel({ empty }: { empty: boolean }) {
  const go = useGo();
  const base = useId();
  const [tab, setTab] = useState<Tab>('page');
  const pageCount = empty ? 0 : HIGHLIGHTS.length;
  const tabs: TabDef<Tab>[] = [
    {
      id: 'page',
      label: 'This page',
      icon: FileText,
      count: pageCount,
      countLabel: `${pageCount} saved`,
    },
    { id: 'banks', label: 'Banks', icon: Library },
    { id: 'review', label: 'Review', icon: Layers, count: ME.due, countLabel: `${ME.due} due` },
    { id: 'search', label: 'Search', icon: Search },
    { id: 'more', label: 'More', icon: Ellipsis },
  ];
  return (
    <div className="sp">
      <header className="sp-head">
        <VaultBuddy pose="wave" size={44} still />
        <div className="sp-head__hello">
          <span className="sp-head__name">Hi, Sam</span>
          <span className="sv-hint">Level {ME.level}</span>
        </div>
        <span className="sp-head__stats">
          <Ring
            value={ME.todayXp}
            max={ME.goal}
            size={38}
            stroke={5}
            label={`Daily goal: ${ME.todayXp} of ${ME.goal} XP`}
          >
            <span className="sp-ring__v">{ME.todayXp}</span>
          </Ring>
          <StreakFlame days={ME.streak} size={22} />
        </span>
        <IconButton
          label="Open dashboard"
          icon={LayoutGrid}
          tip="below-end"
          onClick={() => go('dashboard')}
        />
      </header>
      <nav className="sp-nav" aria-label="Side panel">
        <TabBar
          tabs={tabs}
          value={tab}
          onChange={setTab}
          label="Side panel sections"
          idBase={base}
        />
      </nav>
      <div
        className="sp-body"
        role="tabpanel"
        id={`${base}-panel`}
        aria-labelledby={`${base}-tab-${tab}`}
      >
        {tab === 'page' && <PagePanel key={String(empty)} empty={empty} />}
        {tab === 'banks' && <BanksPanel />}
        {tab === 'review' && <ReviewPanel />}
        {tab === 'search' && <SearchBox />}
        {tab === 'more' && <MorePanel />}
      </div>
    </div>
  );
}

// ---------- This page ----------
function PagePanel({ empty }: { empty: boolean }) {
  const [items, setItems] = useState<Highlight[]>(empty ? [] : HIGHLIGHTS);
  const [undo, setUndo] = useState<{ h: Highlight; at: number } | null>(null);
  const undoBtn = useRef<HTMLButtonElement>(null);
  const attention = items.filter((h) => h.attention);
  const rest = items.filter((h) => !h.attention);

  const remove = (h: Highlight) => {
    flushSync(() => {
      setUndo({ h, at: items.indexOf(h) });
      setItems((list) => list.filter((x) => x !== h));
    });
    undoBtn.current?.focus();
  };
  const restore = () => {
    if (!undo) return;
    setItems((list) => [...list.slice(0, undo.at), undo.h, ...list.slice(undo.at)]);
    setUndo(null);
  };

  return (
    <div className="sp-page">
      <div className="sp-site">
        <span className="sv-well sv-well--sm" data-tone="mint">
          <Globe aria-hidden="true" strokeWidth={2.4} />
        </span>
        <span className="sp-site__host">openmed.example.org</span>
        <span className="sv-chip" data-tone="mint">
          <CircleCheck aria-hidden="true" strokeWidth={2.6} />
          On
        </span>
      </div>

      {items.length === 0 ? (
        <div className="sv-empty sp-empty">
          <VaultBuddy pose="sleep" size={132} />
          <h3>Nothing saved yet</h3>
          <p>Select text, then press Save.</p>
          <p className="sp-keys">
            <kbd className="sv-kbd">Alt</kbd>
            <kbd className="sv-kbd">S</kbd>
            <span>Save</span>
            <kbd className="sv-kbd">Alt</kbd>
            <kbd className="sv-kbd">H</kbd>
            <span>Highlight</span>
          </p>
        </div>
      ) : (
        <>
          {attention.length > 0 && (
            <Group title="Needs check" count={attention.length} icon={TriangleAlert} tone="peach">
              {attention.map((h) => (
                <HlCard key={h.id} h={h} onDelete={() => remove(h)} />
              ))}
            </Group>
          )}
          {rest.length > 0 && (
            <Group title="On this page" count={rest.length} icon={FileText} tone="lavender">
              {rest.map((h) => (
                <HlCard key={h.id} h={h} onDelete={() => remove(h)} />
              ))}
            </Group>
          )}
        </>
      )}

      <div className="sp-toastzone" role="status">
        {undo && (
          <div className="sv-toast">
            <Trash aria-hidden="true" strokeWidth={2.4} />
            <span>Moved to Trash</span>
            <button ref={undoBtn} type="button" className="sv-btn sv-btn--sm" onClick={restore}>
              <Undo2 aria-hidden="true" strokeWidth={2.5} />
              Undo
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Group({
  title,
  count,
  icon: Icon,
  tone,
  children,
}: {
  title: string;
  count: number;
  icon: LucideIcon;
  tone: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="sp-group" aria-labelledby={id}>
      <h3 id={id} className="sp-group__title" data-tone={tone}>
        <span className="sv-well sv-well--sm">
          <Icon aria-hidden="true" strokeWidth={2.5} />
        </span>
        {title}
        <span className="sp-group__n">{count}</span>
      </h3>
      <div className="sp-group__list">{children}</div>
    </section>
  );
}

function HlCard({ h, onDelete }: { h: Highlight; onDelete: () => void }) {
  const go = useGo();
  const kind = kindOf(h.kind);
  const bank = bankOf(h.bank);
  const KindIcon = kind.icon;
  const BankIcon = bank.icon;
  const qid = useId();
  const noteId = useId();
  const long = h.quote.length > 110;
  const [full, setFull] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [card, setCard] = useState(false);
  const [xp, setXp] = useState(0);
  const timer = useRef(0);

  const type = (v: string) => {
    setNote(v);
    setSaving('saving');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setSaving('saved'), 700);
  };

  return (
    <article className="hl" data-tone={kind.tone} aria-labelledby={qid}>
      <div className="hl__top">
        <span className="sv-chip" data-tone={kind.tone}>
          <KindIcon aria-hidden="true" strokeWidth={2.6} />
          {kind.label}
        </span>
        {h.attention && (
          <>
            <span className="sv-chip" data-tone="peach">
              <MapPinOff aria-hidden="true" strokeWidth={2.6} />
              Not found
            </span>
            <InfoTip label="Why not found" align="end">
              The page changed, so this passage can&apos;t be shown there. Your saved copy is safe.
            </InfoTip>
          </>
        )}
      </div>
      <blockquote id={qid} className="hl__quote" data-clamped={long && !full ? '' : undefined}>
        {h.quote}
      </blockquote>
      {long && (
        <button
          type="button"
          className="sv-link hl__more"
          aria-expanded={full}
          onClick={() => setFull((f) => !f)}
        >
          {full ? 'Show less' : 'Show more'}
        </button>
      )}
      <div className="hl__meta">
        <span className="sv-chip" data-tone={bank.tone}>
          <BankIcon aria-hidden="true" strokeWidth={2.6} />
          {bank.name}
        </span>
        {h.tags.map((t) => (
          <span key={t} className="sv-chip sv-chip--tag">
            #{t}
          </span>
        ))}
      </div>
      {note !== null && (
        <div className="hl__note">
          <label htmlFor={noteId} className="sv-vh">
            Your note
          </label>
          <textarea
            id={noteId}
            className="sv-textarea"
            placeholder="Your note"
            value={note}
            onChange={(e) => type(e.target.value)}
          />
          <span className="hl__saved" role="status">
            {saving === 'saving' && (
              <>
                <LoaderCircle aria-hidden="true" className="sv-spin" strokeWidth={2.6} />
                Saving
              </>
            )}
            {saving === 'saved' && (
              <>
                <Check aria-hidden="true" strokeWidth={3} />
                Saved
              </>
            )}
          </span>
        </div>
      )}
      <div className="hl__actions">
        <IconButton
          size="sm"
          label="Show on page"
          icon={Eye}
          onClick={() => go('inpage')}
          disabledReason={h.attention ? 'Passage not on the page' : undefined}
        />
        <IconButton
          size="sm"
          label="Note"
          icon={StickyNote}
          pressed={note !== null}
          onClick={() => setNote((n) => (n === null ? '' : null))}
        />
        <IconButton
          size="sm"
          label="Make card"
          icon={Layers}
          pressed={card}
          onClick={() => {
            if (!card) setXp((x) => x + 1);
            setCard((c) => !c);
          }}
        />
        <span className="hl__spacer" />
        <IconButton size="sm" label="Delete" icon={Trash} tip="end" onClick={onDelete} />
        {xp > 0 && (
          <span key={xp} className="sv-xpfloat hl__xp" aria-hidden="true">
            +3 XP
          </span>
        )}
      </div>
    </article>
  );
}

// ---------- Banks ----------
function BanksPanel() {
  const go = useGo();
  return (
    <div className="sp-stack">
      <div className="sp-sechead">
        <h3>Banks</h3>
        <Btn size="sm" variant="soft" icon={Plus} onClick={() => go('create-bank')}>
          New bank
        </Btn>
      </div>
      <ul className="sp-banks">
        {BANKS.map((b) => {
          const Icon = b.icon;
          return (
            <li key={b.id} className="sp-bank" data-tone={b.tone}>
              <span className="sv-well sv-well--sm">
                <Icon aria-hidden="true" strokeWidth={2.4} />
              </span>
              <div className="sp-bank__main">
                <p className="sp-bank__name">{b.name}</p>
                <Bar
                  size="sm"
                  tone={b.tone}
                  value={b.learned}
                  max={100}
                  label={`${b.name} learned`}
                  valueText={`${b.learned}%`}
                />
              </div>
              <span className="sp-bank__n">
                {b.items}
                <span className="sv-vh"> items</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------- Review ----------
function ReviewPanel() {
  const go = useGo();
  const due = BANKS.filter((b) => b.due > 0);
  return (
    <div className="sp-stack">
      <section className="sv-card sp-due" aria-label="Due now">
        <VaultBuddy pose="think" size={76} />
        <p className="sp-due__n">
          <strong>{ME.due}</strong> cards due
        </p>
        <div className="sp-due__mix">
          <span className="sv-chip" data-tone="sky">
            {ME.mix.new} new
          </span>
          <span className="sv-chip" data-tone="butter">
            {ME.mix.learning} learning
          </span>
          <span className="sv-chip" data-tone="mint">
            {ME.mix.review} review
          </span>
        </div>
        <Btn variant="go" size="lg" block icon={Play} onClick={() => go('review')}>
          Start review
        </Btn>
      </section>
      <h3 className="sp-sub">By bank</h3>
      <ul className="sp-banks">
        {due.map((b) => {
          const Icon = b.icon;
          return (
            <li key={b.id} className="sp-bank" data-tone={b.tone}>
              <span className="sv-well sv-well--sm">
                <Icon aria-hidden="true" strokeWidth={2.4} />
              </span>
              <p className="sp-bank__name">{b.name}</p>
              <span className="sv-chip" data-tone="peach">
                {b.due} due
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------- More ----------
function MorePanel() {
  const go = useGo();
  return (
    <div className="sp-stack">
      <h3 className="sp-sub">More tools</h3>
      <p className="sv-hint">Each opens in the dashboard.</p>
      <ul className="sp-more">
        {MORE.map((m) => {
          const Icon = m.icon;
          return (
            <li key={m.id}>
              <button type="button" className="sp-tile" onClick={() => go('dashboard')}>
                <span className="sv-well sv-well--sm" data-tone="lavender">
                  <Icon aria-hidden="true" strokeWidth={2.3} />
                </span>
                <span>{m.label}</span>
                {m.status && <span className="sp-tile__st">{m.status}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
