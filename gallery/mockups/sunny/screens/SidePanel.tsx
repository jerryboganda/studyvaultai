import { useState } from 'react';
import {
  Check,
  Ellipsis,
  FileText,
  Globe,
  House,
  Layers,
  Library,
  Plus,
  Search,
  Settings,
  TriangleAlert,
} from 'lucide-react';
import { BANKS, GAME, HIGHLIGHTS, PAGE } from '../data';
import { BankTile, HighlightCard, MORE_ITEMS, MoreGrid } from '../shared';
import { VaultBuddy } from '../VaultBuddy';
import { Badge, Bar, Button, GoalRing, IconButton, Kbd, Streak, useTabs } from '../ui';

const TABS = ['page', 'banks', 'review', 'search', 'more'] as const;
type Tab = (typeof TABS)[number];
const TAB_META: Record<Tab, { label: string; icon: typeof FileText; count?: number }> = {
  page: { label: 'This page', icon: FileText, count: 4 },
  banks: { label: 'Banks', icon: Library },
  review: { label: 'Review', icon: Layers, count: GAME.due },
  search: { label: 'Search', icon: Search },
  more: { label: 'More', icon: Ellipsis },
};

export function SidePanel({ empty }: { empty: boolean }) {
  const tabs = useTabs(TABS, 'page');
  return (
    <div className="sv-screen sp">
      <header className="sp__head">
        <VaultBuddy pose="wave" size={40} />
        <GoalRing value={GAME.todayXp} goal={GAME.goalXp} size={42} stroke={6}>
          <span className="sp__ringNum">{GAME.todayXp}</span>
        </GoalRing>
        <Streak days={GAME.streak} />
        <span className="sv-spacer" />
        <IconButton icon={House} label="Dashboard" />
        <IconButton icon={Settings} label="Settings" tipSide="left" />
      </header>

      <div className="sp__tabs" role="tablist" aria-label="Side panel" onKeyDown={tabs.onKeyDown}>
        {TABS.map((id) => {
          const { label, icon: Icon, count } = TAB_META[id];
          const n = id === 'page' && empty ? undefined : count;
          return (
            <button key={id} type="button" className="sp__tab" {...tabs.tab(id)}>
              <span className="sp__tabIcon" aria-hidden="true">
                <Icon strokeWidth={2.4} />
                {n !== undefined && <span className="sp__tabCount">{n}</span>}
              </span>
              <span className="sp__tabLabel">
                {label}
                {n !== undefined && <span className="sv-vh"> ({n})</span>}
              </span>
            </button>
          );
        })}
      </div>

      <div className="sp__body" {...tabs.panel(tabs.active)}>
        {tabs.active === 'page' && <PageTab empty={empty} />}
        {tabs.active === 'banks' && <BanksTab />}
        {tabs.active === 'review' && <ReviewTab />}
        {tabs.active === 'search' && <SearchTab />}
        {tabs.active === 'more' && (
          <>
            <h4 className="sp__h">More</h4>
            {/* Settings already sits in the header. */}
            <MoreGrid items={MORE_ITEMS.filter((m) => m.id !== 'settings')} cols={3} />
          </>
        )}
      </div>
    </div>
  );
}

function PageTab({ empty }: { empty: boolean }) {
  const attention = HIGHLIGHTS.filter((h) => h.attention);
  const onPage = HIGHLIGHTS.filter((h) => !h.attention);
  return (
    <>
      <div className="sv-row sp__site">
        <Globe aria-hidden="true" className="sp__siteIcon" />
        <strong className="sp__host">{PAGE.host}</strong>
        <Badge tone="success" icon={Check}>
          On
        </Badge>
      </div>
      {empty ? (
        <div className="sv-empty sp__empty">
          <VaultBuddy pose="sleep" size={132} />
          <h4>Nothing saved yet</h4>
          <p className="sv-row sp__keys">
            <span className="sv-muted">Select text, then</span>
            <Kbd>Alt</Kbd>
            <Kbd>S</Kbd>
          </p>
        </div>
      ) : (
        <>
          <h4 className="sp__h sp__h--warn">
            <TriangleAlert aria-hidden="true" /> Needs a look
            <span className="sp__hCount">{attention.length}</span>
          </h4>
          <ul className="sp__list">
            {attention.map((h) => (
              <li key={h.id}>
                <HighlightCard h={h} />
              </li>
            ))}
          </ul>
          <h4 className="sp__h">
            On this page <span className="sp__hCount">{onPage.length}</span>
          </h4>
          <ul className="sp__list">
            {onPage.map((h) => (
              <li key={h.id}>
                <HighlightCard h={h} />
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function BanksTab() {
  return (
    <>
      <div className="sv-row">
        <h4 className="sp__h">Banks</h4>
        <span className="sv-spacer" />
        <Button size="sm" icon={Plus}>
          New bank
        </Button>
      </div>
      <ul className="sp__list">
        {BANKS.map((b) => (
          <li key={b.id}>
            <button type="button" className="sv-card sp__bank">
              <BankTile emoji={b.emoji} colour={b.colour} size={40} />
              <span className="sp__bankText">
                <strong>{b.name}</strong>
                <span className="sv-muted">{b.highlights} saved</span>
                <Bar
                  value={b.mastered}
                  max={100}
                  label={`${b.name} mastered`}
                  tone="success"
                  size="sm"
                />
              </span>
              {b.due > 0 ? (
                <Badge tone="sun" icon={Layers}>
                  {b.due}
                  <span className="sv-vh"> due</span>
                </Badge>
              ) : (
                <Badge tone="success" icon={Check}>
                  <span className="sv-vh">Nothing due</span>
                </Badge>
              )}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function ReviewTab() {
  return (
    <>
      <section className="sv-card sv-card--pad sp__due">
        <VaultBuddy pose="think" size={72} />
        <p className="sp__dueNum">
          {GAME.due} <span>due</span>
        </p>
        <div className="sv-row sp__mix">
          <Badge tone="primary">{GAME.dueMix.fresh} new</Badge>
          <Badge tone="warning">{GAME.dueMix.learning} learning</Badge>
          <Badge tone="success">{GAME.dueMix.review} review</Badge>
        </div>
        <Button variant="sun" size="lg" icon={Layers} block>
          Start review
        </Button>
      </section>
      <h4 className="sp__h">By bank</h4>
      <ul className="sp__list">
        {BANKS.filter((b) => b.due > 0).map((b) => (
          <li key={b.id} className="sv-row sp__byBank">
            <BankTile emoji={b.emoji} colour={b.colour} size={32} />
            <strong>{b.name}</strong>
            <span className="sv-spacer" />
            <Badge tone="sun">{b.due}</Badge>
          </li>
        ))}
      </ul>
    </>
  );
}

function SearchTab() {
  const [q, setQ] = useState('valve');
  const hits = HIGHLIGHTS.filter((h) => q && h.quote.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <label className="sp__search">
        <Search aria-hidden="true" />
        <span className="sv-vh">Search your vault</span>
        <input
          className="sv-input"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search your vault"
        />
      </label>
      <p className="sv-muted sp__hint" role="status">
        {q ? `${hits.length} found` : 'Works offline'}
      </p>
      <ul className="sp__list">
        {hits.map((h) => {
          const i = h.quote.toLowerCase().indexOf(q.toLowerCase());
          return (
            <li key={h.id} className={`sv-card sp__hit sv-hlcard--${h.colour}`}>
              {h.quote.slice(0, i)}
              <mark>{h.quote.slice(i, i + q.length)}</mark>
              {h.quote.slice(i + q.length)}
            </li>
          );
        })}
      </ul>
      {q && hits.length === 0 && (
        <div className="sv-empty">
          <VaultBuddy pose="think" size={88} />
          <h4>No matches</h4>
        </div>
      )}
    </>
  );
}
