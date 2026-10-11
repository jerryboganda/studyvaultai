import { useCallback, useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import { parseSrc, pdfReaderPath } from '@pdf/readerUrl';
import type { ColorId, HighlightKind } from '@shared';
import { callBackground, callTab } from '@runtime';
import {
  acceptFiling,
  attachTags,
  createNote,
  createTag,
  detachTags,
  dismissFiling,
  getHighlightDetail,
  listHighlights,
  listPageHighlights,
  listRecentHighlights,
  listTags,
  restoreHighlight,
  softDeleteHighlight,
  undoFiling,
  updateHighlight,
  updateNote,
  type HighlightListItem,
} from '@storage';
import {
  Button,
  COMMAND,
  EmptyState,
  InlineNotice,
  ShortcutHints,
  Tabs,
  ToastProvider,
  errorMessage,
  pickCommands,
  plural,
  useAction,
  useActiveTab,
  useApplyTheme,
  useAsync,
  useDataEpoch,
  useFocusRescue,
  useObserved,
  useSearchFocusRequest,
  useSettings,
  useShortcuts,
  useToast,
  type Loadable,
} from '@ui';
import { useSearchHost } from '@ui/panel';
import { ReminderNotice, ReviewTab, useDueCount } from '@ui/review';
import { openDashboard, storageLinks, type RelatedPort } from '@ui/vault';
import { Banks } from './Banks';
import {
  HighlightCard,
  type CardActions,
  type CardContext,
  type CardDetail,
} from './HighlightCard';
import { extensionPageUrl, openFlashcardAuthor, openInTab, optionsUrl } from './links';
import {
  VIEWS,
  derivePageState,
  groupPageItems,
  revealAvailability,
  scopeLabel,
  viewFromHash,
  type BankScope,
  type PageIdentity,
  type PageState,
  type View,
} from './model';
import { SearchTab } from './Search';
import { useFilingSuggestions } from './useFilingSuggestions';
import { usePendingFocus } from './usePendingFocus';

const RECENT_LIMIT = 50;

/** Where focus goes when a toast that held it closes: the panel content, never <body>. */
const panelContent = () => document.querySelector<HTMLElement>('[role="tabpanel"]');

export function SidePanel() {
  return (
    <ToastProvider returnFocus={panelContent}>
      <Panel />
    </ToastProvider>
  );
}

const TAG_LIST_ID = 'sv-tag-options';

/** The tab shown on open: the address hash (`sidepanel.html#search`), else the current page. */
const initialView = (): View => viewFromHash(window.location.hash) ?? 'page';

function Panel() {
  const settingsState = useSettings();
  const { settings, error: settingsError } = settingsState;
  useApplyTheme(settings?.theme);
  const tabState = useActiveTab();
  const { tab, loading: tabLoading, error: tabError } = tabState;
  const epoch = useDataEpoch();
  const toast = useToast();
  // A removed tag chip or a deleted card takes its focused button with it: focus stays on the card/tab.
  const rescueRef = useFocusRescue();
  const [view, setViewState] = useState<View>(initialView);
  const [scope, setScope] = useState<BankScope | null>(null);
  const [searchText, setSearchText] = useState('');
  // The index is opened the first time Search is shown, not when the panel opens.
  const [searchSeen, setSearchSeen] = useState(view === 'search');
  if (view === 'search' && !searchSeen) setSearchSeen(true);
  const search = useSearchHost(searchSeen);

  const setView = useCallback((next: View) => {
    setViewState(next);
    try {
      window.history.replaceState(null, '', `#${next}`);
    } catch {
      /* the address is a convenience; the tab still changes */
    }
  }, []);
  useEffect(() => {
    const onHash = () => {
      const next = viewFromHash(window.location.hash);
      if (next) setViewState(next);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  // The page overlay asked for a note: the card to focus is in "This page".
  usePendingFocus(() => setView('page'));
  // The manifest command "focus-search": show Search and put the cursor in its box. A request that
  // arrives before the tab exists (the panel was closed) is kept until the tab consumes it.
  const [focusSearch, setFocusSearch] = useState(false);
  useSearchFocusRequest('panel', () => {
    setView('search');
    setFocusSearch(true);
  });

  // The content script is the authority on the page's identity (canonical URL, live title).
  const status = useAsync(
    () => (tab ? callTab(tab.id, 'content.pageStatus', {}) : Promise.reject(new Error('No tab'))),
    [tab?.id, tab?.url],
    [epoch, tab?.status],
  );

  const pageState = derivePageState({
    tabLoaded: !tabLoading && settings !== null,
    tab,
    status: status.data ?? null,
    statusSettled: !status.loading,
    denyList: settings?.denyList ?? [],
  });
  const identity =
    pageState.kind === 'live' || pageState.kind === 'inactive' ? pageState.identity : null;
  const live = pageState.kind === 'live';
  const tabId = tab?.id ?? null;
  const reviewOn = settings?.features.review ?? true;
  const aiOn = settings ? settings.features.ai : null;

  const pageItems = useObserved(
    () =>
      identity
        ? listPageHighlights(identity.url, identity.canonicalUrl)
        : Promise.resolve([] as HighlightListItem[]),
    [identity?.url, identity?.canonicalUrl],
  );
  const recent = useObserved(
    () =>
      scope
        ? listHighlights({
            bankId: scope.bankId,
            ...(scope.folderId ? { folderId: scope.folderId } : {}),
            limit: RECENT_LIMIT,
          }).then((page) => page.items)
        : listRecentHighlights(RECENT_LIMIT),
    [scope?.bankId, scope?.folderId],
  );
  const tags = useObserved(() => listTags(), []);
  const filing = useFilingSuggestions();
  const refreshSuggestions = filing.refresh;
  const due = useDueCount();
  const pageIds = useMemo(
    () => new Set((pageItems.data ?? []).map((i) => i.highlight.id)),
    [pageItems.data],
  );

  /** Tell the page to repaint; best effort, the data is already saved. */
  const repaint = useCallback(async () => {
    if (live && tabId !== null) await callTab(tabId, 'content.refresh', {}).catch(() => undefined);
  }, [live, tabId]);

  const actions: CardActions = useMemo(() => {
    const restore = async (id: string) => {
      try {
        await restoreHighlight(id);
        await repaint();
        toast.push({ message: 'Highlight restored.' });
      } catch (err) {
        toast.push({
          tone: 'error',
          message: `Could not restore the highlight: ${errorMessage(err)}`,
        });
      }
    };
    return {
      update: async (id, patch) => {
        await updateHighlight(id, patch);
        await repaint();
      },
      remove: async (id) => {
        await softDeleteHighlight(id);
        await repaint();
        // Deletion is soft (the row stays so Undo works); say so instead of implying it is gone.
        // The card that held focus is gone: Undo takes it, so the keyboard is not dropped on <body>.
        toast.push({
          message:
            'Highlight deleted. It stays in Trash until you delete it forever there or delete all data in Settings.',
          action: { label: 'Undo', onClick: () => void restore(id) },
          focusAction: true,
        });
      },
      reveal: (id) => {
        if (tabId === null) return Promise.reject(new Error('There is no active tab.'));
        return callTab(tabId, 'content.reveal', { id });
      },
      openDashboard: (id) => openDashboard({ highlight: id }),
      makeFlashcard: (id) => openFlashcardAuthor(id),
      addTag: async (highlightId, name) => {
        const { tag } = await createTag(name);
        await attachTags({ highlightIds: [highlightId], tagIds: [tag.id] });
      },
      removeTag: async (highlightId, tagId) => {
        await detachTags({ highlightIds: [highlightId], tagIds: [tagId] });
      },
      saveNote: async ({ highlightId, sourceId, noteId, body }) => {
        if (noteId === null) await createNote({ highlightId, sourceId, body });
        else await updateNote(noteId, { body });
      },
      // A filing rule's pending suggestion (docs/adr/017-filing-rules.md).
      fileSuggestion: async (id) => {
        const out = await acceptFiling(id);
        refreshSuggestions();
        if (out.status !== 'filed') {
          toast.push({ message: out.status === 'unavailable' ? out.reason : 'Nothing was filed.' });
          return;
        }
        const where =
          out.folderName === null ? out.bank.name : `${out.bank.name} / ${out.folderName}`;
        toast.push({
          message: `Filed in ${where} by rule '${out.ruleName}'.`,
          focusAction: true,
          action: {
            label: 'Undo',
            onClick: () => {
              undoFiling(id).then(
                (done) =>
                  toast.push({
                    message: done.restored
                      ? 'Filing undone. The highlight is back where it was.'
                      : (done.reason ?? 'Nothing was undone.'),
                  }),
                (err: unknown) =>
                  toast.push({
                    tone: 'error',
                    message: `Could not undo the filing: ${errorMessage(err)}`,
                  }),
              );
            },
          },
        });
      },
      dismissSuggestion: async (id) => {
        await dismissFiling(id);
        refreshSuggestions();
        toast.announce('Suggestion dismissed. The highlight stays where it is.');
      },
    };
  }, [refreshSuggestions, repaint, tabId, toast]);

  const paletteFor = useCallback(
    (kind: HighlightKind): ColorId => settings?.palette[kind] ?? 'amber',
    [settings],
  );
  // Related highlights share the Search tab's index; opening the first card's section starts it.
  const related = useMemo<RelatedPort>(
    () => ({
      state: search.state,
      revision: search.revision,
      request: () => setSearchSeen(true),
      find: (id, options) => search.host.related(id, options),
    }),
    [search.state, search.revision, search.host],
  );
  // Links: the picker finds items in the same index; "Show in graph" opens the dashboard's view.
  const links = useMemo<NonNullable<CardContext['links']>>(
    () => ({
      port: storageLinks,
      search: {
        state: search.state,
        revision: search.revision,
        request: () => setSearchSeen(true),
        search: (query, options) => search.host.search(query, options),
      },
      onShowGraph: (item) => {
        void openDashboard({
          highlight: item.kind === 'highlight' ? item.id : null,
          view: 'graph',
        });
      },
    }),
    [search.state, search.revision, search.host],
  );
  const suggestions = filing.suggestions;
  const context: CardContext = useMemo(
    () => ({ reviewOn, aiOn, tagListId: TAG_LIST_ID, related, links, suggestions }),
    [reviewOn, aiOn, related, links, suggestions],
  );

  const openSettings = useAction(async () => {
    await browser.runtime.openOptionsPage();
  });
  const dashboard = useAction(() => openDashboard());

  const count = pageItems.data?.length;
  const fatal = settingsError ?? tabError;
  const dueCount = reviewOn && due.count !== null && due.count > 0 ? due.count : undefined;

  return (
    <div ref={rescueRef} className="panel">
      <header className="panel__head">
        <div className="panel__bar">
          <h1>StudyVault</h1>
          <div className="sv-row">
            <Button variant="ghost" busy={dashboard.busy} onClick={() => void dashboard.run()}>
              Open dashboard
            </Button>
            <Button
              variant="ghost"
              busy={openSettings.busy}
              onClick={() => void openSettings.run()}
            >
              Settings
            </Button>
          </div>
        </div>
        {/* Title and count appear together: a count line that pops in later shifts the layout. */}
        {identity && (pageItems.data !== undefined || pageItems.error !== null) ? (
          <PageContext identity={identity} list={pageItems.data} />
        ) : null}
      </header>
      {openSettings.error ? (
        <InlineNotice tone="error">Could not open settings: {openSettings.error}</InlineNotice>
      ) : null}
      {dashboard.error ? (
        <InlineNotice tone="error">Could not open the dashboard: {dashboard.error}</InlineNotice>
      ) : null}
      <main className="panel__main">
        {reviewOn && !fatal ? (
          <div className="panel__reminder">
            <ReminderNotice
              count={due.count}
              action={
                <Button variant="primary" onClick={() => setView('review')}>
                  Show review
                </Button>
              }
              onDismissed={() => panelContent()?.focus()}
            />
          </div>
        ) : null}
        {fatal ? (
          <div className="panel__body">
            <InlineNotice
              tone="error"
              title="StudyVault could not start"
              action={
                <Button
                  onClick={() => {
                    if (settingsError) settingsState.retry();
                    if (tabError) tabState.retry();
                  }}
                >
                  Retry
                </Button>
              }
            >
              {fatal}
            </InlineNotice>
          </div>
        ) : (
          <Tabs
            label="Highlights"
            tabs={[
              { id: 'page', label: 'This page', count },
              { id: 'recent', label: 'Recent' },
              { id: 'search', label: 'Search' },
              { id: 'banks', label: 'Banks' },
              { id: 'review', label: 'Review', count: dueCount },
            ]}
            value={view}
            onChange={(id) => {
              if ((VIEWS as readonly string[]).includes(id)) setView(id as View);
            }}
          >
            <div className="panel__body">
              {/* One suggestion list for every tag field of every card (see CardTags). */}
              <datalist id={TAG_LIST_ID}>
                {(tags.data ?? []).map(({ tag }) => (
                  <option key={tag.id} value={tag.name} />
                ))}
              </datalist>
              {view === 'page' ? (
                <ThisPage
                  state={pageState}
                  items={pageItems}
                  tabId={tabId}
                  tabUrl={tab?.url}
                  pdfReaderOn={settings?.features.pdfReader ?? true}
                  statusError={status.error}
                  onActivated={status.refresh}
                  paletteFor={paletteFor}
                  actions={actions}
                  context={context}
                  pageIds={pageIds}
                />
              ) : view === 'recent' ? (
                <Recent
                  items={recent}
                  live={live}
                  scope={scope}
                  onClearScope={() => setScope(null)}
                  pageIds={pageIds}
                  paletteFor={paletteFor}
                  actions={actions}
                  context={context}
                />
              ) : view === 'search' ? (
                <SearchTab
                  search={search}
                  text={searchText}
                  onText={setSearchText}
                  scope={scope}
                  onClearScope={() => setScope(null)}
                  live={live}
                  pageIds={pageIds}
                  paletteFor={paletteFor}
                  actions={actions}
                  reviewOn={reviewOn}
                  focusRequested={focusSearch}
                  onFocused={() => setFocusSearch(false)}
                />
              ) : view === 'banks' ? (
                <Banks scope={scope} onScope={setScope} />
              ) : (
                <ReviewPanel enabled={settings ? settings.features.review : null} />
              )}
            </div>
          </Tabs>
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

/** The page in the active tab: title, site and how many highlights are saved on it. */
function PageContext({
  identity,
  list,
}: {
  identity: PageIdentity;
  list: HighlightListItem[] | undefined;
}) {
  const attention = list ? groupPageItems(list).attention.length : 0;
  return (
    <div className="sv-stack sv-stack--tight panel__context" data-testid="page-context">
      <h2 className="panel__title sv-wrap" dir="auto">
        {identity.title || identity.host}
      </h2>
      <p className="sv-muted sv-wrap">{identity.host}</p>
      {list ? (
        <p>
          <strong>{plural(list.length, 'highlight')}</strong> saved
          {attention > 0 ? ` · ${attention} need${attention === 1 ? 's' : ''} attention` : ''}
        </p>
      ) : null}
    </div>
  );
}

function ReviewPanel({ enabled }: { enabled: boolean | null }) {
  const open = useAction(() => openInTab(optionsUrl('review')));
  if (enabled === null) return <p className="sv-muted">Loading review…</p>;
  if (!enabled) {
    return (
      <div className="sv-stack">
        <h2 className="sv-sr">Review</h2>
        <EmptyState
          title="Review is turned off"
          action={
            <Button busy={open.busy} onClick={() => void open.run()}>
              Open settings
            </Button>
          }
        >
          <p>
            Flashcards and spaced review are switched off in Settings. Your highlights and notes are
            unaffected, and nothing is scheduled.
          </p>
        </EmptyState>
        {open.error ? (
          <InlineNotice tone="error">Could not open settings: {open.error}</InlineNotice>
        ) : null}
      </div>
    );
  }
  return (
    <div className="sv-stack">
      <h2 className="sv-sr">Review</h2>
      <ReviewTab />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function ThisPage({
  state,
  items,
  tabId,
  tabUrl,
  pdfReaderOn,
  statusError,
  onActivated,
  paletteFor,
  actions,
  context,
  pageIds,
}: {
  state: PageState;
  items: Loadable<HighlightListItem[]>;
  tabId: number | null;
  tabUrl: string | undefined;
  pdfReaderOn: boolean;
  /** Why the page did not answer; shown as a detail when StudyVault is not running here. */
  statusError: string | null;
  onActivated(): void;
  paletteFor(kind: HighlightKind): ColorId;
  actions: CardActions;
  context: CardContext;
  pageIds: ReadonlySet<string>;
}) {
  const activate = useAction(async () => {
    if (tabId === null) throw new Error('There is no active tab.');
    await callBackground('tab.activate', { tabId });
    onActivated();
  });
  const openSettings = useAction(async () => {
    await browser.runtime.openOptionsPage();
  });

  if (state.kind === 'loading') return <p className="sv-muted">Loading this page…</p>;
  if (state.kind === 'no-tab') {
    return (
      <EmptyState title="No page to show">
        Open a web page in this window to see its highlights here.
      </EmptyState>
    );
  }
  if (state.kind === 'unavailable') {
    return (
      <Unavailable
        state={state}
        settings={openSettings}
        tabUrl={tabUrl}
        pdfReaderOn={pdfReaderOn}
      />
    );
  }

  const live = state.kind === 'live';
  const list = items.data;
  const groups = list ? groupPageItems(list) : null;
  const reveal = (id: string) => revealAvailability({ live, onActivePage: pageIds.has(id) });

  return (
    <div className="sv-stack">
      <h2 className="sv-sr">This page</h2>

      {state.kind === 'inactive' ? (
        <InlineNotice
          tone="info"
          title="StudyVault is not running on this tab"
          action={
            <Button variant="primary" busy={activate.busy} onClick={() => void activate.run()}>
              Activate on this tab
            </Button>
          }
        >
          <p>
            {state.identity
              ? 'Saved highlights for this page are listed below, but they are not painted on the page until you activate StudyVault here. Activating lasts until you navigate or reload.'
              : 'Chrome has not shared this tab with StudyVault. Activating works for this tab until you navigate or reload.'}
          </p>
          {statusError ? <p className="sv-small sv-muted">Chrome reported: {statusError}</p> : null}
        </InlineNotice>
      ) : null}
      {activate.error ? (
        <InlineNotice
          tone="error"
          title="Could not activate StudyVault"
          action={activate.retryable ? <Button onClick={activate.retry}>Retry</Button> : undefined}
        >
          {activate.error}
        </InlineNotice>
      ) : null}

      {state.kind === 'live' && !state.status.paintingSupported ? (
        <InlineNotice tone="warning" title="Highlights cannot be painted in this browser">
          <p>Your saved quotes are listed here, but they will not be coloured on the page.</p>
        </InlineNotice>
      ) : null}
      {state.kind === 'live' && state.status.blocked === 'toolbar-disabled' ? (
        <InlineNotice tone="info">
          The floating toolbar is turned off in Settings. The keyboard shortcut and the context menu
          still save a selection.
        </InlineNotice>
      ) : null}
      {state.kind === 'live' && state.status.blocked === 'denied-site' ? (
        <InlineNotice tone="warning">
          StudyVault is turned off on this site, so nothing new can be saved here. Your existing
          highlights are listed below.
        </InlineNotice>
      ) : null}

      {items.error ? (
        <InlineNotice
          tone="error"
          title="Could not load highlights"
          action={
            items.retryable ? (
              <Button busy={items.refreshing} onClick={items.refresh}>
                Retry
              </Button>
            ) : undefined
          }
        >
          {items.error}
        </InlineNotice>
      ) : !groups ? (
        <p className="sv-muted">Loading highlights…</p>
      ) : groups.attention.length + groups.rest.length === 0 ? (
        <EmptyState title="No highlights on this page yet">
          <p>Select text on the page and use the StudyVault toolbar to save it to a bank.</p>
          <KeyHints />
        </EmptyState>
      ) : (
        <>
          {groups.attention.length > 0 ? (
            <section className="sv-stack" aria-labelledby="attention-heading">
              <h3 id="attention-heading">Needs attention ({groups.attention.length})</h3>
              <p className="sv-muted">
                These could not be placed on the page, so they are not painted. Your saved quotes
                and notes are unchanged.
              </p>
              <CardList
                items={groups.attention}
                showSource={false}
                paletteFor={paletteFor}
                reveal={reveal}
                actions={actions}
                context={context}
              />
            </section>
          ) : null}
          {groups.rest.length > 0 ? (
            <section className="sv-stack" aria-labelledby="page-heading">
              <h3 id="page-heading" className={groups.attention.length ? undefined : 'sv-sr'}>
                {groups.attention.length ? 'On this page' : 'Highlights on this page'}
              </h3>
              <CardList
                items={groups.rest}
                showSource={false}
                paletteFor={paletteFor}
                reveal={reveal}
                actions={actions}
                context={context}
              />
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

/** The keys that save and move between highlights, as Chrome has them now (never hard-coded). */
function KeyHints() {
  const { commands } = useShortcuts();
  if (!commands) return null;
  const shown = pickCommands(commands, [
    COMMAND.quickSave,
    COMMAND.focusToolbar,
    COMMAND.nextHighlight,
  ]);
  return <ShortcutHints commands={shown} />;
}

function Unavailable({
  state,
  settings,
  tabUrl,
  pdfReaderOn,
}: {
  state: Extract<PageState, { kind: 'unavailable' }>;
  settings: { busy: boolean; run(): Promise<void> };
  tabUrl: string | undefined;
  pdfReaderOn: boolean;
}) {
  const a = state.address;
  const reader = useAction(async () => {
    if (!tabUrl) throw new Error('Chrome did not share the address of this tab.');
    await openInTab(extensionPageUrl(pdfReaderPath({ src: tabUrl })));
  });
  if (a.kind === 'denied') {
    return (
      <div className="sv-stack">
        <InlineNotice tone="warning" title={`StudyVault is off on ${a.host}`}>
          <p>
            This site is on your deny list ({a.entries.join(', ')}), so capture and highlights stay
            off here.
          </p>
        </InlineNotice>
        <Button busy={settings.busy} onClick={() => void settings.run()}>
          Edit the deny list in Settings
        </Button>
      </div>
    );
  }
  if (a.kind === 'pdf') {
    const check = tabUrl ? parseSrc(tabUrl) : null;
    return (
      <div className="sv-stack">
        <InlineNotice tone="info" title="PDFs open in Chrome's built-in viewer">
          <p>
            Chrome does not let extensions read or mark up its built-in PDF viewer. StudyVault has
            its own PDF reader, where you can highlight and take notes.
          </p>
          {!pdfReaderOn ? (
            <p>The StudyVault PDF reader is turned off in Settings.</p>
          ) : check && !check.ok ? (
            <p>This PDF cannot be opened there: {check.message}</p>
          ) : null}
        </InlineNotice>
        {pdfReaderOn && check?.ok ? (
          <div>
            <Button variant="primary" busy={reader.busy} onClick={() => void reader.run()}>
              Open in StudyVault
            </Button>
          </div>
        ) : null}
        {reader.error ? (
          <InlineNotice tone="error" title="Could not open the PDF reader">
            {reader.error}
          </InlineNotice>
        ) : null}
      </div>
    );
  }
  return (
    <InlineNotice tone="info" title="StudyVault cannot run on this page">
      <p>
        {a.kind === 'unsupported' ? `This tab uses the "${a.scheme}" address type. ` : ''}
        StudyVault works on http and https pages only. Chrome blocks extensions on its own pages and
        the Chrome Web Store, and local files (file://) are not supported.
      </p>
    </InlineNotice>
  );
}

// ---------------------------------------------------------------------------------------------

function Recent({
  items,
  live,
  scope,
  onClearScope,
  pageIds,
  paletteFor,
  actions,
  context,
}: {
  items: Loadable<HighlightListItem[]>;
  live: boolean;
  scope: BankScope | null;
  onClearScope(): void;
  pageIds: ReadonlySet<string>;
  paletteFor(kind: HighlightKind): ColorId;
  actions: CardActions;
  context: CardContext;
}) {
  const dashboard = useAction(() => openDashboard(scope ? { bank: scope.bankId } : {}));
  const scopeBar = scope ? (
    <div className="sv-row" data-testid="recent-scope">
      <span className="sv-small sv-wrap" dir="auto">
        Only {scopeLabel(scope)}
      </span>
      <Button variant="ghost" onClick={onClearScope}>
        Show everything
      </Button>
    </div>
  ) : null;

  if (items.error) {
    return (
      <div className="sv-stack">
        {scopeBar}
        <InlineNotice
          tone="error"
          title="Could not load recent highlights"
          action={
            items.retryable ? (
              <Button busy={items.refreshing} onClick={items.refresh}>
                Retry
              </Button>
            ) : undefined
          }
        >
          {items.error}
        </InlineNotice>
      </div>
    );
  }
  if (!items.data) return <p className="sv-muted">Loading recent highlights…</p>;
  if (items.data.length === 0) {
    return (
      <div className="sv-stack">
        {scopeBar}
        <EmptyState title={scope ? 'Nothing here yet' : 'Nothing saved yet'}>
          {scope
            ? `No highlights are filed in ${scopeLabel(scope)}.`
            : 'Highlights you save on any page appear here, newest first.'}
        </EmptyState>
      </div>
    );
  }
  const capped = items.data.length >= RECENT_LIMIT;
  return (
    <div className="sv-stack">
      <h2 className="sv-sr">Recent highlights</h2>
      {scopeBar}
      <p className="sv-muted sv-small">
        {scope
          ? `Your ${items.data.length} newest ${scopeLabel(scope)} saves from all pages.`
          : `Your ${items.data.length} most recent saves from all pages.`}{' '}
        A badge shows how a highlight was last found on its page.
      </p>
      <CardList
        items={items.data}
        showSource
        paletteFor={paletteFor}
        reveal={(id) => revealAvailability({ live, onActivePage: pageIds.has(id) })}
        actions={actions}
        context={context}
      />
      {capped ? (
        <div className="sv-stack sv-stack--tight">
          <p className="sv-small sv-muted">
            Showing the newest {RECENT_LIMIT}. The dashboard has the rest.
          </p>
          <div>
            <Button busy={dashboard.busy} onClick={() => void dashboard.run()}>
              Open in dashboard
            </Button>
          </div>
          {dashboard.error ? (
            <InlineNotice tone="error">
              Could not open the dashboard: {dashboard.error}
            </InlineNotice>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Tags and notes of the listed highlights, read together so a list of fifty costs one subscription.
 * A highlight whose detail cannot be read maps to null. The previous answer is kept while the list
 * changes (a highlight was added or deleted), so the other cards do not blink back to "Loading".
 */
function useCardDetails(items: readonly HighlightListItem[]) {
  const key = items.map((i) => i.highlight.id).join(',');
  const loaded = useObserved(async () => {
    const ids = key === '' ? [] : key.split(',');
    const entries = await Promise.all(
      ids.map(
        async (id) =>
          [id, await getHighlightDetail(id).catch((): CardDetail | null => null)] as const,
      ),
    );
    return new Map<string, CardDetail | null>(entries);
  }, [key]);
  const [kept, setKept] = useState<ReadonlyMap<string, CardDetail | null> | undefined>();
  if (loaded.data !== undefined && loaded.data !== kept) setKept(loaded.data);
  return loaded.data ?? kept;
}

function CardList({
  items,
  showSource,
  paletteFor,
  reveal,
  actions,
  context,
}: {
  items: HighlightListItem[];
  showSource: boolean;
  paletteFor(kind: HighlightKind): ColorId;
  reveal(id: string): ReturnType<typeof revealAvailability>;
  actions: CardActions;
  context: CardContext;
}) {
  const details = useCardDetails(items);
  return (
    <ul className="hl-list">
      {items.map((item) => (
        <li key={item.highlight.id}>
          <HighlightCard
            item={item}
            detail={details?.has(item.highlight.id) ? details.get(item.highlight.id) : undefined}
            context={context}
            showSource={showSource}
            paletteFor={paletteFor}
            reveal={reveal(item.highlight.id)}
            actions={actions}
          />
        </li>
      ))}
    </ul>
  );
}
