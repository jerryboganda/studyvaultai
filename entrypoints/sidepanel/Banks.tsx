import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  House,
  Inbox,
  Layers,
  MessagesSquare,
  Plus,
  Search,
  X,
} from 'lucide-react';
import type { BankLite } from '@shared';
import { listBankInfos, listBanksWithCounts, listFolderTree, type FolderNode } from '@storage';
import {
  Button,
  BuddyEmptyState,
  ChunkyButton,
  InlineNotice,
  useAction,
  useObserved,
  useSettings,
} from '@ui';
import { openDashboard } from '@ui/vault';
import { IconAction } from './IconAction';
import type { BankScope } from './model';
import { NewBankWizard } from './NewBankWizard';

/** Due cards per bank id (`DueSummary.byBank`); null while unknown or when review is off. */
export type DueByBank = Readonly<Record<string, { total: number }>> | null;

/**
 * Banks tab. Names are typed here, in the extension origin, because the page overlay has no text
 * input (ADR-005); the overlay only picks among these banks. Choosing a bank opens it here (its
 * highlights, folders and actions) and also narrows Recent and Search to it until "All banks".
 * Folders are managed (created, moved, merged) in the dashboard.
 */
export function Banks({
  scope,
  onScope,
  due,
  onSearch,
  list,
}: {
  scope: BankScope | null;
  /** Open a bank / folder (narrows Recent and Search too); null goes back to all banks. */
  onScope(next: BankScope | null): void;
  due: DueByBank;
  /** Show the Search tab (already narrowed to the open bank). */
  onSearch(): void;
  /** The open bank's highlights. */
  list: ReactNode;
}) {
  const banks = useObserved(() => listBanksWithCounts(), []);
  // A bank's icon (user emoji) is extra: a bank without one, or a failed read, shows its letter.
  const infos = useObserved(() => listBankInfos(), []);
  const icons = new Map((infos.data ?? []).map((b) => [b.id, b.icon]));
  const newBank = useRef<HTMLButtonElement>(null);
  // Chat with a bank's notes is an AI feature: null while the settings are being read.
  const { settings } = useSettings();
  const aiOn = settings === null ? null : settings.features.ai;
  const [creating, setCreating] = useState(false);
  // The pressed control goes with the view, so focus is handed on (never dropped on <body>): to the
  // open bank's heading, and on the way back to the card of the bank that was open.
  const [focusHeading, setFocusHeading] = useState(false);
  const backTo = useRef<string | null>(null);
  const open = (bank: BankLite) => {
    setFocusHeading(true);
    onScope({ bankId: bank.id, bankName: bank.name, folderId: null, folderName: null });
  };

  if (scope) {
    const entry = banks.data?.find((b) => b.bank.id === scope.bankId);
    return (
      <BankDetail
        scope={scope}
        bank={entry?.bank ?? null}
        icon={icons.get(scope.bankId) ?? null}
        count={entry?.count ?? null}
        due={due?.[scope.bankId]?.total ?? (due ? 0 : null)}
        aiOn={aiOn}
        focusHeading={focusHeading}
        onHeadingFocused={() => setFocusHeading(false)}
        onBack={() => {
          backTo.current = scope.bankId;
          onScope(null);
        }}
        onScope={onScope}
        onSearch={onSearch}
        list={list}
      />
    );
  }

  return (
    <div className="sv-stack">
      <div className="sp-titlerow">
        <h2 className="sp-h">Banks</h2>
        <ChunkyButton
          ref={newBank}
          size="sm"
          variant="primary"
          icon={Plus}
          onClick={() => setCreating(true)}
        >
          New bank
        </ChunkyButton>
      </div>
      {creating ? (
        <NewBankWizard
          onClose={() => {
            setCreating(false);
            newBank.current?.focus();
          }}
          onOpen={(bank) => {
            setCreating(false);
            open(bank);
          }}
        />
      ) : null}
      {banks.error ? (
        <InlineNotice
          tone="error"
          title="Could not load banks"
          action={
            banks.retryable ? (
              <Button busy={banks.refreshing} onClick={banks.refresh}>
                Retry
              </Button>
            ) : undefined
          }
        >
          {banks.error}
        </InlineNotice>
      ) : !banks.data ? (
        <p className="sv-muted">Loading banks…</p>
      ) : banks.data.length === 0 ? (
        <BuddyEmptyState pose="sleep" title="No banks yet" text="Add one, or save a highlight." />
      ) : (
        <ul className="sp-list" aria-label="Your banks">
          {banks.data.map(({ bank, count }) => (
            <li key={bank.id} className="bank-item" data-testid="bank-item">
              <button
                type="button"
                className="sp-bank"
                data-testid="bank-filter"
                ref={(el) => {
                  if (el && backTo.current === bank.id) {
                    backTo.current = null;
                    el.focus();
                  }
                }}
                onClick={() => open(bank)}
              >
                <BankTile bank={bank} icon={icons.get(bank.id) ?? null} />
                <span className="sp-bank__text">
                  <strong dir="auto" className="sv-wrap">
                    {bank.name}
                  </strong>
                  <span>
                    {count} saved
                    {bank.isInbox ? <span className="sv-sr">, default bank</span> : null}
                  </span>
                </span>
                <DueBadge due={due ? (due[bank.id]?.total ?? 0) : null} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BankTile({ bank, icon }: { bank: BankLite; icon: string | null }) {
  return (
    <span className={`sp-tile sp-sw--${bank.color}`} aria-hidden="true">
      {icon ??
        (bank.isInbox ? (
          <Inbox strokeWidth={2.4} />
        ) : (
          (Array.from(bank.name.trim())[0] ?? '?').toUpperCase()
        ))}
    </span>
  );
}

/** Fixed-width status: cards due, a check when none are, nothing while unknown. */
function DueBadge({ due }: { due: number | null }) {
  if (due === null) return null;
  return due > 0 ? (
    <span className="sp-due sp-due--on">
      <Layers aria-hidden="true" strokeWidth={2.4} />
      {due}
      <span className="sv-sr"> due</span>
    </span>
  ) : (
    <span className="sp-due sp-due--off">
      <Check aria-hidden="true" strokeWidth={3} />
      <span className="sv-sr">Nothing due</span>
    </span>
  );
}

function BankDetail({
  scope,
  bank,
  icon,
  count,
  due,
  aiOn,
  focusHeading,
  onHeadingFocused,
  onBack,
  onScope,
  onSearch,
  list,
}: {
  scope: BankScope;
  bank: BankLite | null;
  icon: string | null;
  count: number | null;
  due: number | null;
  aiOn: boolean | null;
  /** Opened by a press here: the heading takes focus (not when the tab is merely shown again). */
  focusHeading: boolean;
  onHeadingFocused(): void;
  onBack(): void;
  onScope(next: BankScope | null): void;
  onSearch(): void;
  list: ReactNode;
}) {
  const uid = useId();
  const [foldersOpen, setFoldersOpen] = useState(scope.folderId !== null);
  const name = scope.bankName;
  const dashboard = useAction(() => openDashboard({ bank: scope.bankId }));
  const chat = useAction(() => openDashboard({ bank: scope.bankId, view: 'chat' }));
  const whole = { ...scope, folderId: null, folderName: null };
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!focusHeading) return;
    heading.current?.focus();
    onHeadingFocused();
  }, [focusHeading, onHeadingFocused]);

  return (
    <div className="sv-stack">
      <div>
        <ChunkyButton size="sm" variant="ghost" icon={ArrowLeft} onClick={onBack}>
          All banks
        </ChunkyButton>
      </div>
      <section className="sp-bankhead" data-testid="bank-scope" aria-labelledby={`${uid}-name`}>
        {bank ? <BankTile bank={bank} icon={icon} /> : null}
        <div className="sp-bank__text">
          <h2 id={`${uid}-name`} ref={heading} tabIndex={-1} className="sp-h sv-wrap" dir="auto">
            {name}
          </h2>
          {count !== null ? <span>{count} saved</span> : null}
        </div>
        <DueBadge due={due} />
      </section>
      <div className="sp-bankbar">
        <IconAction icon={Search} label={`Search in ${name}`} tipSide="bottom" onClick={onSearch} />
        <IconAction
          icon={House}
          label={`Open ${name} in the dashboard`}
          tipSide="bottom"
          busy={dashboard.busy}
          onClick={() => void dashboard.run()}
        />
        <IconAction
          icon={MessagesSquare}
          label={`Chat with the notes of ${name} (AI)`}
          tipSide="bottom"
          busy={chat.busy}
          data-testid="bank-chat"
          disabledReason={
            aiOn === true
              ? undefined
              : aiOn === false
                ? 'AI features are off, so nothing is sent anywhere. Turn them on in the AI settings.'
                : 'Reading your settings…'
          }
          onClick={() => void chat.run()}
        />
        <span className="hl-card__spacer" />
        <button
          type="button"
          className="sp-pill"
          aria-expanded={foldersOpen}
          aria-controls={`${uid}-folders`}
          aria-label={`${foldersOpen ? 'Hide' : 'Show'} folders of ${name}`}
          data-testid="bank-folders-toggle"
          onClick={() => setFoldersOpen((v) => !v)}
        >
          {foldersOpen ? (
            <FolderOpen aria-hidden="true" strokeWidth={2.4} />
          ) : (
            <Folder aria-hidden="true" strokeWidth={2.4} />
          )}
          Folders
          {foldersOpen ? (
            <ChevronDown aria-hidden="true" strokeWidth={2.4} />
          ) : (
            <ChevronRight aria-hidden="true" strokeWidth={2.4} />
          )}
        </button>
      </div>
      {dashboard.error || chat.error ? (
        <InlineNotice tone="error" title="Could not open the dashboard">
          {dashboard.error ?? chat.error}
        </InlineNotice>
      ) : null}
      {foldersOpen ? (
        <div id={`${uid}-folders`}>
          <Folders bank={{ id: scope.bankId, name }} scope={scope} onScope={onScope} />
        </div>
      ) : null}
      {scope.folderName ? (
        <p className="sp-scope" data-testid="folder-scope">
          <FolderOpen aria-hidden="true" strokeWidth={2.4} />
          <span dir="auto" className="sv-wrap">
            Only {scope.folderName}
          </span>
          <button
            type="button"
            className="sp-scope__x"
            aria-label={`Show all of ${name}`}
            onClick={() => onScope(whole)}
          >
            <X aria-hidden="true" strokeWidth={2.6} />
          </button>
        </p>
      ) : null}
      {list}
    </div>
  );
}

function Folders({
  bank,
  scope,
  onScope,
}: {
  bank: { id: string; name: string };
  scope: BankScope | null;
  onScope(next: BankScope | null): void;
}) {
  const tree = useObserved(() => listFolderTree(bank.id), [bank.id]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  if (tree.error) {
    return (
      <InlineNotice
        tone="error"
        title="Could not load folders"
        action={
          tree.retryable ? (
            <Button busy={tree.refreshing} onClick={tree.refresh}>
              Retry
            </Button>
          ) : undefined
        }
      >
        {tree.error}
      </InlineNotice>
    );
  }
  if (!tree.data) return <p className="sv-small sv-muted">Loading folders…</p>;
  if (tree.data.length === 0) {
    return <p className="sv-small sv-muted">No folders in this bank yet.</p>;
  }
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <FolderItems
      nodes={tree.data}
      label={`Folders in ${bank.name}`}
      bank={bank}
      scope={scope}
      onScope={onScope}
      expanded={expanded}
      toggle={toggle}
    />
  );
}

function FolderItems({
  nodes,
  label,
  bank,
  scope,
  onScope,
  expanded,
  toggle,
}: {
  nodes: readonly FolderNode[];
  label: string;
  bank: { id: string; name: string };
  scope: BankScope | null;
  onScope(next: BankScope | null): void;
  expanded: ReadonlySet<string>;
  toggle(id: string): void;
}) {
  return (
    <ul className="folder-list" aria-label={label}>
      {nodes.map((node) => {
        const { folder } = node;
        const active = scope?.folderId === folder.id;
        const hasChildren = node.children.length > 0;
        const open = expanded.has(folder.id);
        return (
          <li key={folder.id} data-testid="folder-item">
            <div className="folder-row">
              {hasChildren ? (
                <button
                  type="button"
                  className="folder-twist"
                  aria-expanded={open}
                  aria-label={`${open ? 'Collapse' : 'Expand'} ${folder.name}`}
                  onClick={() => toggle(folder.id)}
                >
                  {open ? (
                    <ChevronDown aria-hidden="true" strokeWidth={2.4} />
                  ) : (
                    <ChevronRight aria-hidden="true" strokeWidth={2.4} />
                  )}
                </button>
              ) : null}
              <button
                type="button"
                className="folder-name"
                aria-pressed={active}
                aria-label={`Show ${folder.name} in Recent and Search`}
                data-testid="folder-filter"
                onClick={() =>
                  onScope(
                    active
                      ? { bankId: bank.id, bankName: bank.name, folderId: null, folderName: null }
                      : {
                          bankId: bank.id,
                          bankName: bank.name,
                          folderId: folder.id,
                          folderName: folder.name,
                        },
                  )
                }
              >
                <Folder aria-hidden="true" strokeWidth={2.4} />
                <span dir="auto" className="sv-wrap">
                  {folder.name}
                </span>
                <span className="folder-count">{node.totalCount}</span>
                {active ? <Check aria-hidden="true" strokeWidth={3} /> : null}
              </button>
            </div>
            {hasChildren && open ? (
              <FolderItems
                nodes={node.children}
                label={`Folders in ${folder.name}`}
                bank={bank}
                scope={scope}
                onScope={onScope}
                expanded={expanded}
                toggle={toggle}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
