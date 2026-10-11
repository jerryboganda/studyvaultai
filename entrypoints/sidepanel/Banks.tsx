import { useId, useState, type FormEvent } from 'react';
import { createBank, listBanksWithCounts, listFolderTree, type FolderNode } from '@storage';
import {
  Badge,
  Button,
  InlineNotice,
  plural,
  useAction,
  useObserved,
  useSettings,
  useToast,
} from '@ui';
import { openDashboard } from '@ui/vault';
import { scopeLabel, validateBankName, type BankScope } from './model';

/**
 * Banks tab. Names are typed here, in the extension origin, because the page overlay has no text
 * input (ADR-005); the overlay only picks among the banks listed below. The list is also a
 * read-only map of bank > folder with counts: choosing one narrows Recent and Search to it.
 * Folders are managed (created, moved, merged) in the dashboard.
 */
export function Banks({
  scope,
  onScope,
}: {
  scope: BankScope | null;
  /** Narrow Recent and Search to this bank / folder (null clears). */
  onScope(next: BankScope | null): void;
}) {
  const banks = useObserved(() => listBanksWithCounts(), []);
  // Chat with a bank's notes is an AI feature: null while the settings are being read.
  const { settings } = useSettings();
  const aiOn = settings === null ? null : settings.features.ai;
  return (
    <div className="sv-stack">
      <h2 className="sv-sr">Banks</h2>
      <NewBankForm />
      {scope ? (
        <div className="sv-row" data-testid="bank-scope">
          <Badge>
            <span dir="auto">Recent and Search show only {scopeLabel(scope)}</span>
          </Badge>
          <Button variant="ghost" onClick={() => onScope(null)}>
            Show everything
          </Button>
        </div>
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
      ) : (
        <>
          <p className="sv-small sv-muted">
            Choose a bank or folder to see only its highlights in Recent and Search. Organise
            folders in the dashboard.
          </p>
          <ul className="bank-list" aria-label="Your banks">
            {banks.data.map(({ bank, count }) => (
              <BankRow
                key={bank.id}
                bank={bank}
                count={count}
                scope={scope}
                onScope={onScope}
                aiOn={aiOn}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function BankRow({
  bank,
  count,
  scope,
  onScope,
  aiOn,
}: {
  bank: { id: string; name: string; isInbox: boolean };
  count: number;
  scope: BankScope | null;
  onScope(next: BankScope | null): void;
  aiOn: boolean | null;
}) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const active = scope?.bankId === bank.id && scope.folderId === null;
  const dashboard = useAction(() => openDashboard({ bank: bank.id }));
  const chat = useAction(() => openDashboard({ bank: bank.id, view: 'chat' }));

  return (
    <li className="bank-item" data-testid="bank-item">
      <div className="sv-row">
        <Button
          variant="ghost"
          className="sv-grow bank-name"
          aria-pressed={active}
          aria-label={`Show ${bank.name} in Recent and Search`}
          data-testid="bank-filter"
          onClick={() =>
            onScope(
              active
                ? null
                : { bankId: bank.id, bankName: bank.name, folderId: null, folderName: null },
            )
          }
        >
          <span dir="auto" className="sv-wrap">
            {bank.name}
          </span>
        </Button>
        {bank.isInbox ? <Badge>Default</Badge> : null}
        <Badge>{plural(count, 'highlight')}</Badge>
      </div>
      <div className="sv-row">
        <Button
          variant="ghost"
          aria-expanded={open}
          aria-controls={`${uid}-folders`}
          aria-label={`${open ? 'Hide' : 'Show'} folders of ${bank.name}`}
          data-testid="bank-folders-toggle"
          onClick={() => setOpen((v) => !v)}
        >
          Folders
        </Button>
        <Button
          variant="ghost"
          busy={dashboard.busy}
          aria-label={`Open ${bank.name} in the dashboard`}
          onClick={() => void dashboard.run()}
        >
          Open in dashboard
        </Button>
        <Button
          variant="ghost"
          busy={chat.busy}
          aria-label={`Chat with the notes of ${bank.name} (AI)`}
          data-testid="bank-chat"
          {...(aiOn === true
            ? {}
            : {
                disabledReason:
                  aiOn === false
                    ? 'AI features are off, so nothing is sent anywhere. Turn them on in the AI settings.'
                    : 'Reading your settings…',
              })}
          onClick={() => void chat.run()}
        >
          Chat (AI)
        </Button>
      </div>
      {dashboard.error || chat.error ? (
        <InlineNotice tone="error" title="Could not open the dashboard">
          {dashboard.error ?? chat.error}
        </InlineNotice>
      ) : null}
      {open ? (
        <div id={`${uid}-folders`}>
          <Folders bank={bank} scope={scope} onScope={onScope} />
        </div>
      ) : null}
    </li>
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
            <div className="sv-row">
              {hasChildren ? (
                <Button
                  variant="ghost"
                  className="folder-twist"
                  aria-expanded={open}
                  aria-label={`${open ? 'Collapse' : 'Expand'} ${folder.name}`}
                  onClick={() => toggle(folder.id)}
                >
                  <span aria-hidden="true">{open ? '▾' : '▸'}</span>
                </Button>
              ) : null}
              <Button
                variant="ghost"
                className="sv-grow bank-name"
                aria-pressed={active}
                aria-label={`Show ${folder.name} in Recent and Search`}
                data-testid="folder-filter"
                onClick={() =>
                  onScope(
                    active
                      ? null
                      : {
                          bankId: bank.id,
                          bankName: bank.name,
                          folderId: folder.id,
                          folderName: folder.name,
                        },
                  )
                }
              >
                <span dir="auto" className="sv-wrap">
                  {folder.name}
                </span>
              </Button>
              <Badge>{node.totalCount}</Badge>
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

function NewBankForm() {
  const uid = useId();
  const toast = useToast();
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const create = useAction(async (bankName: string) => {
    const bank = await createBank(bankName);
    setName('');
    toast.push({ message: `Bank "${bank.name}" created.` });
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (create.busy) return; // aria-disabled buttons still submit; one bank per request
    const invalid = validateBankName(name);
    setProblem(invalid);
    if (invalid === null) void create.run(name.trim());
  };

  return (
    <form className="sv-stack sv-stack--tight" onSubmit={onSubmit} noValidate>
      <div className="sv-field">
        <label className="sv-label" htmlFor={`${uid}-name`}>
          New bank
        </label>
        <input
          id={`${uid}-name`}
          className="sv-control"
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="For example: Cardiology"
          value={name}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${uid}-problem` : undefined}
          onChange={(e) => {
            setName(e.target.value);
            setProblem(null);
          }}
        />
      </div>
      <div>
        <Button type="submit" variant="primary" busy={create.busy}>
          Create bank
        </Button>
      </div>
      {problem ? (
        <p id={`${uid}-problem`} role="alert" className="panel__error">
          Error: {problem}
        </p>
      ) : null}
      {create.error ? (
        <InlineNotice
          tone="error"
          title="Could not create the bank"
          action={create.retryable ? <Button onClick={create.retry}>Retry</Button> : undefined}
        >
          {create.error}
        </InlineNotice>
      ) : null}
    </form>
  );
}
