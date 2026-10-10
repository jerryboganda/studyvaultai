import { useCallback, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import type { ColorId, HighlightKind } from '@shared';
import { callBackground, callTab } from '@runtime';
import {
  listPageHighlights,
  listRecentHighlights,
  restoreHighlight,
  softDeleteHighlight,
  updateHighlight,
  type HighlightListItem,
} from '@storage';
import {
  Button,
  EmptyState,
  InlineNotice,
  Tabs,
  ToastProvider,
  errorMessage,
  plural,
  useAction,
  useActiveTab,
  useApplyTheme,
  useAsync,
  useDataEpoch,
  useObserved,
  useSettings,
  useToast,
  type Loadable,
} from '@ui';
import { HighlightCard, type CardActions } from './HighlightCard';
import {
  derivePageState,
  groupPageItems,
  revealAvailability,
  type PageIdentity,
  type PageState,
} from './model';

const RECENT_LIMIT = 50;

export function SidePanel() {
  return (
    <ToastProvider>
      <Panel />
    </ToastProvider>
  );
}

type View = 'page' | 'recent';

function Panel() {
  const { settings, error: settingsError } = useSettings();
  useApplyTheme(settings?.theme);
  const { tab, loading: tabLoading, error: tabError } = useActiveTab();
  const epoch = useDataEpoch();
  const toast = useToast();
  const [view, setView] = useState<View>('page');

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

  const pageItems = useObserved(
    () =>
      identity
        ? listPageHighlights(identity.url, identity.canonicalUrl)
        : Promise.resolve([] as HighlightListItem[]),
    [identity?.url, identity?.canonicalUrl],
  );
  const recent = useObserved(() => listRecentHighlights(RECENT_LIMIT), []);
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
        toast.push({
          message: 'Highlight deleted.',
          action: { label: 'Undo', onClick: () => void restore(id) },
        });
      },
      reveal: (id) => {
        if (tabId === null) return Promise.reject(new Error('There is no active tab.'));
        return callTab(tabId, 'content.reveal', { id });
      },
    };
  }, [repaint, tabId, toast]);

  const paletteFor = useCallback(
    (kind: HighlightKind): ColorId => settings?.palette[kind] ?? 'amber',
    [settings],
  );

  const openSettings = useAction(async () => {
    await browser.runtime.openOptionsPage();
  });

  const count = pageItems.data?.length;
  const fatal = settingsError ?? tabError;

  return (
    <div className="panel">
      <header className="panel__head">
        <h1>StudyVault</h1>
        <Button variant="ghost" busy={openSettings.busy} onClick={() => void openSettings.run()}>
          Settings
        </Button>
      </header>
      {openSettings.error ? (
        <InlineNotice tone="error">Could not open settings: {openSettings.error}</InlineNotice>
      ) : null}
      <main className="panel__main">
        {fatal ? (
          <div className="panel__body">
            <InlineNotice tone="error" title="StudyVault could not start">
              {fatal}
            </InlineNotice>
          </div>
        ) : (
          <Tabs
            label="Highlights"
            tabs={[
              { id: 'page', label: 'This page', count },
              { id: 'recent', label: 'Recent' },
            ]}
            value={view}
            onChange={(id) => setView(id as View)}
          >
            <div className="panel__body">
              {view === 'page' ? (
                <ThisPage
                  state={pageState}
                  items={pageItems}
                  tabId={tabId}
                  statusError={status.error}
                  onActivated={status.refresh}
                  paletteFor={paletteFor}
                  actions={actions}
                  pageIds={pageIds}
                />
              ) : (
                <Recent
                  items={recent}
                  live={live}
                  pageIds={pageIds}
                  paletteFor={paletteFor}
                  actions={actions}
                />
              )}
            </div>
          </Tabs>
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function ThisPage({
  state,
  items,
  tabId,
  statusError,
  onActivated,
  paletteFor,
  actions,
  pageIds,
}: {
  state: PageState;
  items: Loadable<HighlightListItem[]>;
  tabId: number | null;
  /** Why the page did not answer; shown as a detail when StudyVault is not running here. */
  statusError: string | null;
  onActivated(): void;
  paletteFor(kind: HighlightKind): ColorId;
  actions: CardActions;
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

  if (state.kind === 'loading')
    return (
      <p className="sv-muted" role="status">
        Loading this page…
      </p>
    );
  if (state.kind === 'no-tab') {
    return (
      <EmptyState title="No page to show">
        Open a web page in this window to see its highlights here.
      </EmptyState>
    );
  }
  if (state.kind === 'unavailable') return <Unavailable state={state} settings={openSettings} />;

  const live = state.kind === 'live';
  const list = items.data;
  const groups = list ? groupPageItems(list) : null;
  const reveal = (id: string) => revealAvailability({ live, onActivePage: pageIds.has(id) });

  return (
    <div className="sv-stack">
      {state.identity ? (
        <PageHeader identity={state.identity} list={list} />
      ) : (
        <h2 className="sv-sr">This page</h2>
      )}

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
          action={<Button onClick={activate.retry}>Retry</Button>}
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
          action={<Button onClick={items.reload}>Retry</Button>}
        >
          {items.error}
        </InlineNotice>
      ) : !groups ? (
        <p className="sv-muted" role="status">
          Loading highlights…
        </p>
      ) : groups.attention.length + groups.rest.length === 0 ? (
        <EmptyState title="No highlights on this page yet">
          Select text on the page and use the StudyVault toolbar to save it to a bank.
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
              />
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

function PageHeader({
  identity,
  list,
}: {
  identity: PageIdentity;
  list: HighlightListItem[] | undefined;
}) {
  const attention = list ? groupPageItems(list).attention.length : 0;
  return (
    <div className="sv-stack sv-stack--tight">
      <h2 className="panel__title sv-wrap">{identity.title || identity.host}</h2>
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

function Unavailable({
  state,
  settings,
}: {
  state: Extract<PageState, { kind: 'unavailable' }>;
  settings: { busy: boolean; run(): Promise<void> };
}) {
  const a = state.address;
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
    return (
      <InlineNotice tone="info" title="PDFs open in Chrome's built-in viewer">
        <p>
          Chrome does not let extensions read or mark up its built-in PDF viewer. A StudyVault PDF
          reader is planned for a later release.
        </p>
      </InlineNotice>
    );
  }
  return (
    <InlineNotice tone="info" title="StudyVault cannot run on this page">
      <p>
        {a.kind === 'unsupported' ? `This tab uses the "${a.scheme}" address type. ` : ''}
        Extensions only run on http and https pages; Chrome blocks browser pages and the Chrome Web
        Store, and local files need a separate opt-in.
      </p>
    </InlineNotice>
  );
}

// ---------------------------------------------------------------------------------------------

function Recent({
  items,
  live,
  pageIds,
  paletteFor,
  actions,
}: {
  items: Loadable<HighlightListItem[]>;
  live: boolean;
  pageIds: ReadonlySet<string>;
  paletteFor(kind: HighlightKind): ColorId;
  actions: CardActions;
}) {
  if (items.error) {
    return (
      <InlineNotice
        tone="error"
        title="Could not load recent highlights"
        action={<Button onClick={items.reload}>Retry</Button>}
      >
        {items.error}
      </InlineNotice>
    );
  }
  if (!items.data) {
    return (
      <p className="sv-muted" role="status">
        Loading recent highlights…
      </p>
    );
  }
  if (items.data.length === 0) {
    return (
      <EmptyState title="Nothing saved yet">
        Highlights you save on any page appear here, newest first.
      </EmptyState>
    );
  }
  return (
    <div className="sv-stack">
      <h2 className="sv-sr">Recent highlights</h2>
      <p className="sv-muted sv-small">
        Your {items.data.length} most recent saves from all pages. A badge shows how a highlight was
        last found on its page.
      </p>
      <CardList
        items={items.data}
        showSource
        paletteFor={paletteFor}
        reveal={(id) => revealAvailability({ live, onActivePage: pageIds.has(id) })}
        actions={actions}
      />
    </div>
  );
}

function CardList({
  items,
  showSource,
  paletteFor,
  reveal,
  actions,
}: {
  items: HighlightListItem[];
  showSource: boolean;
  paletteFor(kind: HighlightKind): ColorId;
  reveal(id: string): ReturnType<typeof revealAvailability>;
  actions: CardActions;
}) {
  return (
    <ul className="hl-list">
      {items.map((item) => (
        <li key={item.highlight.id}>
          <HighlightCard
            item={item}
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
