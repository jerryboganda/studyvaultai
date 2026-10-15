import { useCallback, useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  ArrowLeft,
  BookOpen,
  Check,
  FileText,
  Globe,
  Layers,
  Library,
  Power,
  RefreshCw,
  Search,
  ShieldOff,
  TriangleAlert,
} from 'lucide-react';
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
  BuddyEmptyState,
  COMMAND,
  ChunkyButton,
  IconTabBar,
  InfoTip,
  InlineNotice,
  Kbd,
  ToastProvider,
  VaultBuddy,
  errorMessage,
  pickCommands,
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
import { useGame } from '@ui/game';
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
  derivePageState,
  groupPageItems,
  revealAvailability,
  scopeLabel,
  tabOf,
  viewFromHash,
  type BankScope,
  type PageIdentity,
  type PageState,
  type TabId,
  type View,
} from './model';
import { MoreTab } from './MoreTab';
import { PanelHeader } from './PanelHeader';
import { SearchTab } from './Search';
import { useFilingSuggestions } from './useFilingSuggestions';
import { usePendingFocus } from './usePendingFocus';
import { CardMemory } from './useCardMemory';

const RECENT_LIMIT = 50;
/** Newest saves shown under the empty Search box. */
const SEARCH_RECENT = 3;

/** Where focus goes when a toast that held it closes: the panel content, never <body>. */
const panelContent = () => document.querySelector<HTMLElement>('[role="tabpanel"]');

export function SidePanel() {
  // Open drawers and half-typed notes outlive the card lists, which remount on every tab switch.
  const [cardMemory] = useState(() => new Map<string, unknown>());
  return (
    <ToastProvider returnFocus={panelContent}>
      <CardMemory.Provider value={cardMemory}>
        <Panel />
      </CardMemory.Provider>
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
  const game = useGame();
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
        // Deletion is soft (the row stays so Undo works). The card that held focus is gone: Undo
        // takes it, so the keyboard is not dropped on <body>.
        toast.push({
          message: 'Highlight deleted. It stays in Trash.',
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
  const reveal = (id: string) => revealAvailability({ live, onActivePage: pageIds.has(id) });
  const cards = { paletteFor, actions, context };

  return (
    <div ref={rescueRef} className="panel">
      <PanelHeader
        game={game.data}
        onRetryGame={() => void game.retryBackfill()}
        onDashboard={() => void dashboard.run()}
        onSettings={() => void openSettings.run()}
      />
      {openSettings.error ? (
        <InlineNotice tone="error">Could not open settings: {openSettings.error}</InlineNotice>
      ) : null}
      {dashboard.error ? (
        <InlineNotice tone="error">Could not open the dashboard: {dashboard.error}</InlineNotice>
      ) : null}
      {fatal ? (
        <main className="panel__body">
          <BuddyEmptyState
            pose="think"
            title="Could not start"
            text={fatal}
            heading="h2"
            action={{
              label: 'Retry',
              icon: RefreshCw,
              onClick: () => {
                if (settingsError) settingsState.retry();
                if (tabError) tabState.retry();
              },
            }}
          />
        </main>
      ) : (
        <IconTabBar<TabId>
          label="Side panel"
          className="panel__tabs"
          tabs={[
            { id: 'page', label: 'This page', icon: FileText, count },
            { id: 'banks', label: 'Banks', icon: Library },
            { id: 'review', label: 'Review', icon: Layers, count: dueCount },
            { id: 'search', label: 'Search', icon: Search },
          ]}
          more={{ id: 'more' }}
          active={tabOf(view)}
          onChange={setView}
        >
          <main className="panel__body">
            {reviewOn ? (
              <div className="panel__reminder">
                <ReminderNotice
                  count={due.count}
                  action={
                    // On the Review tab Start is right below: a "Show review" there would do nothing.
                    view === 'review' ? undefined : (
                      <Button variant="primary" onClick={() => setView('review')}>
                        Show review
                      </Button>
                    )
                  }
                  onDismissed={() => panelContent()?.focus()}
                />
              </div>
            ) : null}
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
                reveal={reveal}
                {...cards}
              />
            ) : view === 'recent' ? (
              <Recent
                items={recent}
                scope={scope}
                onClearScope={() => setScope(null)}
                onBack={() => setView('more')}
                reveal={reveal}
                {...cards}
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
                recent={
                  recent.data && recent.data.length > 0 ? (
                    <section className="sv-stack" aria-labelledby="search-recent">
                      <div className="sp-titlerow">
                        <h3 id="search-recent" className="sp-h">
                          Recent
                        </h3>
                        <button type="button" className="sp-link" onClick={() => setView('recent')}>
                          See all
                        </button>
                      </div>
                      <CardList
                        items={recent.data.slice(0, SEARCH_RECENT)}
                        showSource
                        reveal={reveal}
                        {...cards}
                      />
                    </section>
                  ) : null
                }
              />
            ) : view === 'banks' ? (
              <Banks
                scope={scope}
                onScope={setScope}
                due={reviewOn ? (due.summary?.byBank ?? null) : null}
                onSearch={() => setView('search')}
                list={<Recent items={recent} scope={scope} inBank reveal={reveal} {...cards} />}
              />
            ) : view === 'more' ? (
              <MoreTab features={settings?.features ?? null} onRecent={() => setView('recent')} />
            ) : (
              <ReviewPanel enabled={settings ? settings.features.review : null} />
            )}
          </main>
        </IconTabBar>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function ReviewPanel({ enabled }: { enabled: boolean | null }) {
  const open = useAction(() => openInTab(optionsUrl('review')));
  if (enabled === null) return <p className="sv-muted">Loading review…</p>;
  if (!enabled) {
    return (
      <div className="sv-stack">
        <h2 className="sv-sr">Review</h2>
        <BuddyEmptyState
          pose="sleep"
          title="Review is off"
          text="Turn it on in Settings."
          action={{ label: 'Open settings', icon: Power, onClick: () => void open.run() }}
        />
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

interface CardsProps {
  paletteFor(kind: HighlightKind): ColorId;
  actions: CardActions;
  context: CardContext;
  reveal(id: string): ReturnType<typeof revealAvailability>;
}

/** Loading over a second shows the thinking mascot, never a fake number (UX_DESIGN 12). */
function Waiting({ label }: { label: string }) {
  return (
    <p className="panel__wait">
      <VaultBuddy pose="think" size={48} />
      <span>{label}</span>
    </p>
  );
}

function ThisPage({
  state,
  items,
  tabId,
  tabUrl,
  pdfReaderOn,
  statusError,
  onActivated,
  ...cards
}: {
  state: PageState;
  items: Loadable<HighlightListItem[]>;
  tabId: number | null;
  tabUrl: string | undefined;
  pdfReaderOn: boolean;
  /** Why the page did not answer; shown as a detail when StudyVault is not running here. */
  statusError: string | null;
  onActivated(): void;
} & CardsProps) {
  const activate = useAction(async () => {
    if (tabId === null) throw new Error('There is no active tab.');
    await callBackground('tab.activate', { tabId });
    onActivated();
  });

  if (state.kind === 'loading') return <Waiting label="Loading this page…" />;
  if (state.kind === 'no-tab') {
    return (
      <BuddyEmptyState
        pose="sleep"
        title="No page to show"
        text="Open a web page in this window."
        heading="h2"
      />
    );
  }
  if (state.kind === 'unavailable') {
    return <Unavailable state={state} tabUrl={tabUrl} pdfReaderOn={pdfReaderOn} />;
  }

  const live = state.kind === 'live';
  const list = items.data;
  const groups = list ? groupPageItems(list) : null;

  return (
    <div className="sv-stack">
      {state.identity ? (
        <SiteCard
          identity={state.identity}
          live={live}
          denied={live && state.status.blocked === 'denied-site'}
        />
      ) : (
        <h2 className="sv-sr">This page</h2>
      )}

      {state.kind === 'inactive' ? (
        <section className="sp-callout" aria-labelledby="inactive-title">
          <Power className="sp-callout__icon" aria-hidden="true" strokeWidth={2.4} />
          <div className="sp-callout__body">
            <p id="inactive-title" className="sp-callout__title">
              StudyVault is not running on this tab
            </p>
            <ChunkyButton
              variant="primary"
              size="sm"
              aria-busy={activate.busy || undefined}
              onClick={() => {
                if (!activate.busy) void activate.run();
              }}
            >
              Activate on this tab
            </ChunkyButton>
          </div>
          <InfoTip label="About activating" align="end">
            {state.identity
              ? 'Saved highlights are listed, but not painted until you activate. It lasts until you navigate or reload.'
              : 'Chrome has not shared this tab with StudyVault. Activating lasts until you navigate or reload.'}
            {statusError ? ` Chrome reported: ${statusError}` : ''}
          </InfoTip>
        </section>
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
        <InlineNotice tone="warning" title="Cannot paint here">
          Your quotes are listed, but this browser cannot colour them on the page.
        </InlineNotice>
      ) : null}
      {state.kind === 'live' && state.status.blocked === 'toolbar-disabled' ? (
        <InlineNotice tone="info">
          Toolbar off. The shortcut and right-click still save.
        </InlineNotice>
      ) : null}
      {state.kind === 'live' && state.status.blocked === 'denied-site' ? (
        <InlineNotice tone="warning">Off on this site: nothing new can be saved here.</InlineNotice>
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
        <Waiting label="Loading highlights…" />
      ) : groups.attention.length + groups.rest.length === 0 ? (
        <div className="sp-empty">
          <BuddyEmptyState pose="sleep" title="Nothing saved yet" heading="h3" />
          <SaveHint />
        </div>
      ) : (
        <>
          {groups.attention.length > 0 ? (
            <section className="sv-stack" aria-labelledby="attention-heading">
              <div className="sp-titlerow sp-titlerow--start">
                <h3 id="attention-heading" className="sp-h sp-h--warn">
                  <TriangleAlert aria-hidden="true" strokeWidth={2.4} />
                  Needs a look{' '}
                  <span className="sp-count">
                    <span className="sv-sr">(</span>
                    {groups.attention.length}
                    <span className="sv-sr">)</span>
                  </span>
                </h3>
                <InfoTip label="About Needs a look" align="start">
                  These could not be placed on the page, so they are not painted. Your quotes and
                  notes are unchanged.
                </InfoTip>
              </div>
              <CardList items={groups.attention} showSource={false} {...cards} />
            </section>
          ) : null}
          {groups.rest.length > 0 ? (
            <section className="sv-stack" aria-labelledby="page-heading">
              <h3 id="page-heading" className="sp-h">
                On this page{' '}
                <span className="sp-count">
                  <span className="sv-sr">(</span>
                  {groups.rest.length}
                  <span className="sv-sr">)</span>
                </span>
              </h3>
              <CardList items={groups.rest} showSource={false} {...cards} />
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

/** The page in the active tab: its title, site and whether StudyVault runs on it. */
function SiteCard({
  identity,
  live,
  denied,
}: {
  identity: PageIdentity;
  live: boolean;
  denied: boolean;
}) {
  return (
    <div className="sp-site" data-testid="page-context">
      <Globe className="sp-site__icon" aria-hidden="true" strokeWidth={2.4} />
      <div className="sp-site__text">
        <h2 className="sp-site__title sv-wrap" dir="auto">
          {identity.title || identity.host}
        </h2>
        {identity.title ? <p className="sp-site__host">{identity.host}</p> : null}
      </div>
      {denied ? (
        <span className="sp-badge sp-badge--warn">
          <ShieldOff aria-hidden="true" strokeWidth={2.4} />
          Off
        </span>
      ) : live ? (
        <span className="sp-badge sp-badge--on">
          <Check aria-hidden="true" strokeWidth={3} />
          On
        </span>
      ) : (
        <span className="sp-badge">
          <Power aria-hidden="true" strokeWidth={2.4} />
          Not running
        </span>
      )}
    </div>
  );
}

/** "Select text, then <the real quick-save keys>", as Chrome has them now (never hard-coded). */
function SaveHint() {
  const { commands } = useShortcuts();
  if (!commands) return null;
  const [save] = pickCommands(commands, [COMMAND.quickSave]);
  return (
    <p className="sp-keys">
      <span>Select text, then</span>
      {save?.shortcut ? <Kbd shortcut={save.shortcut} /> : <span>use the toolbar</span>}
    </p>
  );
}

function Unavailable({
  state,
  tabUrl,
  pdfReaderOn,
}: {
  state: Extract<PageState, { kind: 'unavailable' }>;
  tabUrl: string | undefined;
  pdfReaderOn: boolean;
}) {
  const a = state.address;
  const reader = useAction(async () => {
    if (!tabUrl) throw new Error('Chrome did not share the address of this tab.');
    await openInTab(extensionPageUrl(pdfReaderPath({ src: tabUrl })));
  });
  // The deny list lives in Settings > Site access.
  const editDeny = useAction(() => openInTab(optionsUrl('site-access')));
  if (a.kind === 'denied') {
    return (
      <div className="sv-stack">
        <BuddyEmptyState
          pose="sleep"
          title="Off on this site"
          text={a.host}
          heading="h2"
          action={{
            label: 'Edit the deny list',
            icon: ShieldOff,
            onClick: () => void editDeny.run(),
          }}
        />
        <p className="sp-why">
          <span aria-hidden="true">Why?</span>
          <InfoTip label="Why it is off" align="center">
            {`This site is on your deny list (${a.entries.join(', ')}), so capture and highlights stay off here.`}
          </InfoTip>
        </p>
        {editDeny.error ? (
          <InlineNotice tone="error">Could not open settings: {editDeny.error}</InlineNotice>
        ) : null}
      </div>
    );
  }
  if (a.kind === 'pdf') {
    const check = tabUrl ? parseSrc(tabUrl) : null;
    const canOpen = pdfReaderOn && check?.ok === true;
    return (
      <div className="sv-stack">
        <BuddyEmptyState
          pose="think"
          title="PDF in Chrome"
          text={
            !pdfReaderOn
              ? 'The PDF reader is off in Settings.'
              : check && !check.ok
                ? `It cannot open there: ${check.message}`
                : 'Open it in the StudyVault reader to highlight.'
          }
          heading="h2"
          action={
            canOpen
              ? {
                  label: 'Open in StudyVault',
                  icon: BookOpen,
                  onClick: () => {
                    if (!reader.busy) void reader.run(); // one tab per press
                  },
                }
              : undefined
          }
        />
        <p className="sp-why">
          <span aria-hidden="true">Why?</span>
          <InfoTip label="Why not here" align="center">
            Chrome does not let extensions read or mark up its built-in PDF viewer. StudyVault has
            its own PDF reader.
          </InfoTip>
        </p>
        {reader.error ? (
          <InlineNotice tone="error" title="Could not open the PDF reader">
            {reader.error}
          </InlineNotice>
        ) : null}
      </div>
    );
  }
  return (
    <div className="sv-stack">
      <BuddyEmptyState
        pose="sleep"
        title="Can't run here"
        text={
          a.kind === 'unsupported' ? `"${a.scheme}" pages are not supported.` : 'A browser page.'
        }
        heading="h2"
      />
      <p className="sp-why">
        <span aria-hidden="true">Why?</span>
        <InfoTip label="Where StudyVault runs" align="center">
          StudyVault works on http and https pages only. Chrome blocks extensions on its own pages
          and the Chrome Web Store, and local files are not supported.
        </InfoTip>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function Recent({
  items,
  scope,
  onClearScope,
  onBack,
  inBank = false,
  ...cards
}: {
  items: Loadable<HighlightListItem[]>;
  scope: BankScope | null;
  onClearScope?(): void;
  /** Back to the More grid (Recent is one of its pages). */
  onBack?(): void;
  /** Shown inside an open bank: the bank header already names the scope. */
  inBank?: boolean;
} & CardsProps) {
  const dashboard = useAction(() => openDashboard(scope ? { bank: scope.bankId } : {}));
  const top = inBank ? null : (
    <>
      {onBack ? (
        <div>
          <ChunkyButton size="sm" variant="ghost" icon={ArrowLeft} onClick={onBack}>
            More
          </ChunkyButton>
        </div>
      ) : null}
      <h2 className="sp-h">Recent</h2>
      {scope && onClearScope ? (
        <p className="sp-pill sp-pill--on" data-testid="recent-scope">
          <span className="sv-wrap" dir="auto">
            Only {scopeLabel(scope)}
          </span>
          <button type="button" className="sp-link" onClick={onClearScope}>
            Show everything
          </button>
        </p>
      ) : null}
    </>
  );

  if (items.error) {
    return (
      <div className="sv-stack">
        {top}
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
  if (!items.data) {
    return (
      <div className="sv-stack">
        {top}
        <Waiting label="Loading recent highlights…" />
      </div>
    );
  }
  if (items.data.length === 0) {
    return (
      <div className="sv-stack">
        {top}
        <BuddyEmptyState
          pose="sleep"
          title={scope ? 'Nothing here yet' : 'Nothing saved yet'}
          text={scope ? `Nothing is filed in ${scopeLabel(scope)}.` : 'Your saves show up here.'}
        />
      </div>
    );
  }
  const capped = items.data.length >= RECENT_LIMIT;
  return (
    <div className="sv-stack">
      {top}
      <CardList items={items.data} showSource {...cards} />
      {capped ? (
        <div className="sv-stack sv-stack--tight">
          <p className="sv-small sv-muted">Showing the newest {RECENT_LIMIT}.</p>
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
} & CardsProps) {
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
