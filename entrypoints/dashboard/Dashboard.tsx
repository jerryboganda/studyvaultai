import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { browser } from 'wxt/browser';
import { DEFAULT_PALETTE, type ColorId, type HighlightKind } from '@shared';
import {
  Button,
  ErrorBoundary,
  InlineNotice,
  LOCAL_PREF_KEYS,
  ToastProvider,
  errorMessage,
  useApplyTheme,
  useFocusRescue,
  useSettings,
  useToast,
} from '@ui';
import { CommandPalette, Modal, type Command } from '@ui/vault';
import { ApiProvider, realApi, useApi, type DashboardApi } from './api';
import { BankPane, type BankPaneHandle } from './BankPane';
import { DuplicatesView } from './DuplicatesView';
import { parseDeepLink } from './deepLink';
import {
  ALL_SCOPE,
  EMPTY_FILTERS,
  filterCount,
  type Filters,
  type Scope,
  type SortKey,
} from './filters';
import {
  VersionProvider,
  useBump,
  useDataVersion,
  useDebounced,
  useDismissibleDetails,
  useLocalPref,
  useVaultQuery,
} from './hooks';
import { LibraryView } from './LibraryView';
import { rowId, useLibrary } from './library';
import { extensionUrl } from './links';
import { Preview } from './Preview';
import { SavedSearches, useSavedSearches } from './SavedSearches';
import { SearchBar, ShortcutLegend } from './SearchBar';
import { SearchHost, type SearchHostPorts } from '@ui/vault/searchHost';
import { StoragePanel } from './StoragePanel';
import { EMPTY_TREE_DATA, TreeDataContext, loadTreeData, type TreeData } from './treeData';
import { TrashView } from './TrashView';

type View = 'library' | 'duplicates' | 'trash' | 'storage';

const VIEW_LABELS: Record<View, string> = {
  library: 'All highlights',
  duplicates: 'Duplicate quotes',
  trash: 'Trash',
  storage: 'Storage',
};

/** Where focus goes when a toast that held it closes: the main pane, never <body>. */
const mainPane = () => document.getElementById('dash-center');

export function portsFor(api: DashboardApi): SearchHostPorts {
  return {
    listAll: (o) => api.listSearchDocuments(o),
    listChangedSince: (o) => api.listSearchDocumentsChangedSince(o),
    getLastPurgeAt: () => api.getLastPurgeAt(),
    countDocuments: async () => {
      const usage = await api.getStorageUsage();
      return (usage.rows.highlights ?? 0) + (usage.rows.notes ?? 0);
    },
    meta: api.meta,
  };
}

/** The full-page knowledge workspace. `api` is the vault (the real one unless a test injects one). */
export function Dashboard({ api = realApi }: { api?: DashboardApi }) {
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((n) => n + 1), []);
  const versioning = useMemo(() => ({ local: version, bump }), [version, bump]);
  return (
    <ApiProvider value={api}>
      <ToastProvider returnFocus={mainPane}>
        <VersionProvider value={versioning}>
          <ErrorBoundary surface="dashboard">
            <Workspace />
          </ErrorBoundary>
        </VersionProvider>
      </ToastProvider>
    </ApiProvider>
  );
}

function Workspace() {
  const api = useApi();
  const toast = useToast();
  const bump = useBump();
  const dataVersion = useDataVersion();
  const { settings, update } = useSettings();
  useApplyTheme(settings?.theme);
  const density = settings?.density ?? 'comfortable';
  const [contrast, setContrast] = useLocalPref<'auto' | 'high'>(
    LOCAL_PREF_KEYS.dashboardContrast,
    'auto',
    ['auto', 'high'],
  );
  // WCAG 2.1.4: the "/" and "?" keys act without a modifier, so they can be turned off.
  const [singleKeys, setSingleKeys] = useLocalPref<'on' | 'off'>(
    LOCAL_PREF_KEYS.dashboardSingleKeys,
    'on',
    ['on', 'off'],
  );
  const link = useMemo(() => parseDeepLink(window.location.search), []);

  useEffect(() => {
    document.title = 'StudyVault AI dashboard';
    const root = document.documentElement;
    if (contrast === 'high') root.dataset.contrast = 'high';
    else delete root.dataset.contrast;
  }, [contrast]);

  // --- navigation state ---------------------------------------------------------------------
  const [view, setView] = useState<View>('library');
  const [scope, setScope] = useState<Scope>(
    link.bank ? { bankId: link.bank, folderId: null } : ALL_SCOPE,
  );
  const [text, setText] = useState(link.q ?? '');
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [sort, setSort] = useState<SortKey>('captured-desc');
  const [shown, setShown] = useState<string | null>(link.highlight);
  const [treeOpen, setTreeOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [legend, setLegend] = useState(false);
  const [duplicateFocus, setDuplicateFocus] = useState<string | null>(null);
  const searchText = useDebounced(text, 180);

  // --- vault data ---------------------------------------------------------------------------
  const tree = useVaultQuery<TreeData>(() => loadTreeData(api), []);
  const treeData = tree.data ?? EMPTY_TREE_DATA;

  // --- search host --------------------------------------------------------------------------
  const host = useMemo(() => new SearchHost(portsFor(api)), [api]);
  useEffect(() => {
    void host.start();
    return () => host.dispose();
  }, [host]);
  const subscribe = useMemo(() => (cb: () => void) => host.subscribe(cb), [host]);
  const hostState = useSyncExternalStore(subscribe, () => host.state);
  useEffect(() => {
    host.reconcileSoon();
  }, [host, dataVersion]);
  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === 'hidden') void host.flush();
    };
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', flush);
      window.removeEventListener('pagehide', flush);
    };
  }, [host]);

  // --- the list -----------------------------------------------------------------------------
  const names = useMemo(() => {
    const bank = treeData.banks.find((b) => b.id === scope.bankId)?.name ?? null;
    let folder: string | null = null;
    if (scope.folderId && scope.bankId) {
      const walk = (nodes: TreeData['folders'][string]): void => {
        for (const n of nodes) {
          if (n.folder.id === scope.folderId) folder = n.folder.name;
          walk(n.children);
        }
      };
      walk(treeData.folders[scope.bankId] ?? []);
    }
    return {
      bank,
      folder,
      tags: filters.tagIds.map((id) => treeData.tags.find((t) => t.tag.id === id)?.tag.name ?? ''),
    };
  }, [treeData, scope, filters.tagIds]);

  const lib = useLibrary({
    api,
    scope,
    filters,
    sort,
    text: searchText,
    names,
    index: host.index,
    indexVersion: host.revision,
    dataVersion,
  });

  // The preview follows the active row (or an explicit "show" from another view).
  const [seenActive, setSeenActive] = useState<string | null>(null);
  if (lib.activeKey !== seenActive) {
    setSeenActive(lib.activeKey);
    if (lib.activeKey !== null) {
      const row = lib.rows.find((r) => rowId(r) === lib.activeKey);
      setShown(row && row.highlightId === null ? null : lib.activeKey);
    }
  }
  const standaloneNote =
    lib.activeKey !== null &&
    lib.rows.find((r) => rowId(r) === lib.activeKey)?.highlightId === null;
  const previewId = useDebounced(shown, 90);

  // --- focus management ---------------------------------------------------------------------
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLElement>(null);
  const topRef = useRef<HTMLElement>(null);
  useDismissibleDetails(topRef);
  const bankRef = useRef<BankPaneHandle>(null);
  // A closed bulk bar or dialog takes its focused button with it: the list is where work continues.
  const rescueRef = useFocusRescue((lost) =>
    lost.closest('.dash-bulk, dialog') ? listRef.current : null,
  );

  // The view is replaced under a nav button that keeps focus: say which one is showing now.
  const shownView = useRef(view);
  useEffect(() => {
    if (shownView.current === view) return;
    shownView.current = view;
    toast.announce(VIEW_LABELS[view]);
  }, [view, toast]);

  const focusPane = useCallback((pane: 'tree' | 'search' | 'list' | 'preview') => {
    if (pane === 'tree') {
      setTreeOpen(true);
      setTimeout(() => bankRef.current?.focusTree(), 0);
    } else if (pane === 'search') searchRef.current?.focus();
    else if (pane === 'list') listRef.current?.focus();
    else previewRef.current?.focus();
  }, []);

  const cyclePane = useCallback(
    (direction: 1 | -1) => {
      const order = ['tree', 'search', 'list', 'preview'] as const;
      const active = document.activeElement;
      const current = order.findIndex((p) =>
        p === 'tree'
          ? !!active?.closest('.dash-left')
          : p === 'search'
            ? !!active?.closest('.dash-top')
            : p === 'list'
              ? !!active?.closest('.dash-center')
              : !!active?.closest('.dash-right'),
      );
      const next = order[(current + direction + order.length) % order.length]!;
      focusPane(next);
    },
    [focusPane],
  );

  // Global keys. Ctrl/Cmd+K works everywhere; the single-key shortcuts only outside text fields.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(true);
        return;
      }
      if (e.key === 'F6') {
        e.preventDefault();
        cyclePane(e.shiftKey ? -1 : 1);
        return;
      }
      const t = e.target as HTMLElement | null;
      const typing = !!t?.closest('input, textarea, select, [contenteditable="true"]');
      if (typing || e.ctrlKey || e.metaKey || e.altKey || singleKeys === 'off') return;
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === '?') {
        e.preventDefault();
        setLegend(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cyclePane, singleKeys]);

  // --- saved searches -----------------------------------------------------------------------
  const saved = useSavedSearches(api.meta);

  // --- actions ------------------------------------------------------------------------------
  const goLibrary = useCallback((next?: Scope) => {
    setView('library');
    if (next) setScope(next);
    setTreeOpen(false);
  }, []);

  const showHighlight = useCallback(
    (id: string) => {
      setView('library');
      setShown(id);
      setSeenActive(id);
      lib.setActiveKey(id);
    },
    [lib],
  );

  const paletteFor = useCallback(
    (kind: HighlightKind): ColorId => settings?.palette[kind] ?? DEFAULT_PALETTE[kind],
    [settings],
  );

  const commands: Command[] = useMemo(() => {
    const inLibrary = view === 'library';
    const needLibrary = inLibrary ? undefined : 'Open the highlight list first.';
    const needSelection =
      needLibrary ?? (lib.selectedCount === 0 ? 'Select highlights in the list first.' : undefined);
    const list: Command[] = [
      {
        id: 'view-library',
        label: 'Show all highlights',
        group: 'Go to',
        run: () => goLibrary(ALL_SCOPE),
      },
      {
        id: 'view-duplicates',
        label: 'Show duplicate quotes',
        group: 'Go to',
        run: () => setView('duplicates'),
      },
      { id: 'view-trash', label: 'Show the trash', group: 'Go to', run: () => setView('trash') },
      {
        id: 'view-storage',
        label: 'Show storage usage',
        group: 'Go to',
        keywords: 'cache pdf',
        run: () => setView('storage'),
      },
      ...treeData.banks.map((b) => ({
        id: `bank-${b.id}`,
        label: `Open bank: ${b.name}`,
        group: 'Banks',
        run: () => goLibrary({ bankId: b.id, folderId: null }),
      })),
      {
        id: 'focus-search',
        label: 'Focus the search box',
        group: 'Focus',
        hint: '/',
        run: () => focusPane('search'),
      },
      {
        id: 'focus-tree',
        label: 'Focus the bank tree',
        group: 'Focus',
        run: () => focusPane('tree'),
      },
      {
        id: 'focus-list',
        label: 'Focus the highlight list',
        group: 'Focus',
        disabledReason: needLibrary,
        run: () => focusPane('list'),
      },
      {
        id: 'focus-preview',
        label: 'Focus the preview',
        group: 'Focus',
        hint: 'F6',
        run: () => focusPane('preview'),
      },
      { id: 'bank-new', label: 'New bank…', group: 'Banks', run: () => bankRef.current?.newBank() },
      {
        id: 'folder-new',
        label: 'New folder in the current bank or folder…',
        group: 'Banks',
        disabledReason: scope.bankId ? undefined : 'Open a bank or folder in the tree first.',
        run: () => {
          bankRef.current?.newFolder();
        },
      },
      {
        id: 'node-rename',
        label: 'Rename the current bank or folder…',
        group: 'Banks',
        hint: 'F2',
        disabledReason: scope.bankId ? undefined : 'Open a bank or folder in the tree first.',
        run: () => {
          if (!bankRef.current?.renameCurrent())
            toast.push({ message: 'The Inbox cannot be renamed.' });
        },
      },
      {
        id: 'node-delete',
        label: 'Delete the current bank or folder…',
        group: 'Banks',
        disabledReason: scope.bankId ? undefined : 'Open a bank or folder in the tree first.',
        run: () => {
          if (!bankRef.current?.deleteCurrent())
            toast.push({ message: 'The Inbox cannot be deleted.' });
        },
      },
      {
        id: 'select-loaded',
        label: 'Select all loaded highlights',
        group: 'Selection',
        hint: 'Ctrl+A',
        disabledReason:
          needLibrary ??
          (lib.rows.length === 0 ? 'There are no highlights in the list.' : undefined),
        run: lib.selectAllLoaded,
      },
      {
        id: 'select-filtered',
        label: 'Select everything that matches the current filters',
        group: 'Selection',
        disabledReason:
          needLibrary ??
          (lib.total === null || lib.total === 0 ? 'There is nothing to select.' : undefined),
        run: lib.selectAllFiltered,
      },
      {
        id: 'select-clear',
        label: 'Clear the selection',
        group: 'Selection',
        disabledReason: needSelection,
        run: lib.clearSelection,
      },
      {
        id: 'sel-move',
        label: 'Move the selection to a bank or folder…',
        group: 'Selection',
        disabledReason: needSelection,
        run: () => lib.openDialog({ type: 'move', ids: 'selection' }),
      },
      {
        id: 'sel-tags',
        label: 'Change tags of the selection…',
        group: 'Selection',
        disabledReason: needSelection,
        run: () => lib.openDialog({ type: 'tags' }),
      },
      {
        id: 'sel-trash',
        label: 'Move the selection to the trash',
        group: 'Selection',
        hint: 'Delete',
        disabledReason: needSelection,
        run: () => {
          if (lib.selection.allFiltered || lib.selectedCount > 25) {
            lib.openDialog({ type: 'confirm-delete', count: lib.selectedCount });
          } else void lib.bulk.remove();
        },
      },
      {
        id: 'filters-clear',
        label: 'Clear all filters',
        group: 'Filters',
        disabledReason: filterCount(filters) === 0 ? 'No filters are active.' : undefined,
        run: () => setFilters(EMPTY_FILTERS),
      },
      {
        id: 'search-clear',
        label: 'Clear the search box',
        group: 'Search',
        disabledReason: text === '' ? 'The search box is empty.' : undefined,
        run: () => setText(''),
      },
      {
        id: 'index-rebuild',
        label: 'Rebuild the search index',
        group: 'Search',
        disabledReason: hostState.phase === 'building' ? 'It is rebuilding already.' : undefined,
        run: () => void host.rebuild(),
      },
      ...(saved.state?.items ?? []).map((s) => ({
        id: `saved-${s.id}`,
        label: `Run saved search: ${s.name}`,
        group: 'Search',
        keywords: s.query,
        run: () => {
          setView('library');
          setText(s.query);
        },
      })),
      ...(['system', 'light', 'dark'] as const).map((theme) => ({
        id: `theme-${theme}`,
        label: `Theme: ${theme === 'system' ? 'follow the system' : theme}`,
        group: 'Appearance',
        disabledReason: settings === null ? 'Settings are still loading.' : undefined,
        run: () => void update((s) => ({ ...s, theme })),
      })),
      ...(['comfortable', 'compact'] as const).map((d) => ({
        id: `density-${d}`,
        label: `Density: ${d}`,
        group: 'Appearance',
        disabledReason: settings === null ? 'Settings are still loading.' : undefined,
        run: () => void update((s) => ({ ...s, density: d })),
      })),
      {
        id: 'contrast-toggle',
        label: contrast === 'high' ? 'Turn high contrast off' : 'Turn high contrast on',
        group: 'Appearance',
        run: () => setContrast(contrast === 'high' ? 'auto' : 'high'),
      },
      {
        id: 'single-keys-toggle',
        label:
          singleKeys === 'on'
            ? 'Turn the / and ? shortcut keys off'
            : 'Turn the / and ? shortcut keys on',
        group: 'Appearance',
        keywords: 'single key shortcuts',
        run: () => setSingleKeys(singleKeys === 'on' ? 'off' : 'on'),
      },
      {
        id: 'shortcuts',
        label: 'Show keyboard shortcuts',
        group: 'Help',
        hint: '?',
        run: () => setLegend(true),
      },
      {
        id: 'open-settings',
        label: 'Open StudyVault settings',
        group: 'App',
        run: () => {
          void browser.runtime.openOptionsPage().catch((err: unknown) =>
            toast.push({
              tone: 'error',
              message: errorMessage(err, 'Could not open the settings.'),
            }),
          );
        },
      },
      {
        id: 'open-reader',
        label: 'Open the PDF reader',
        group: 'App',
        run: () => window.open(extensionUrl('pdf-reader.html'), '_blank', 'noopener'),
      },
    ];
    return list;
  }, [
    view,
    lib,
    treeData.banks,
    scope.bankId,
    filters,
    text,
    hostState.phase,
    host,
    saved.state,
    settings,
    update,
    contrast,
    setContrast,
    singleKeys,
    setSingleKeys,
    goLibrary,
    focusPane,
    toast,
  ]);

  const searching = lib.mode === 'search';
  const appearance = (
    <details className="dash-appearance">
      <summary>View options</summary>
      <div className="dash-appearance__body sv-stack sv-stack--tight">
        <div className="sv-field">
          <label className="sv-label" htmlFor="opt-theme">
            Theme
          </label>
          <select
            id="opt-theme"
            className="sv-control"
            value={settings?.theme ?? 'system'}
            disabled={settings === null}
            data-testid="opt-theme"
            onChange={(e) => {
              const theme = e.target.value as 'system' | 'light' | 'dark';
              void update((s) => ({ ...s, theme }));
            }}
          >
            <option value="system">Follow the system</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
        <div className="sv-field">
          <label className="sv-label" htmlFor="opt-density">
            Density
          </label>
          <select
            id="opt-density"
            className="sv-control"
            value={density}
            disabled={settings === null}
            data-testid="opt-density"
            onChange={(e) => {
              const next = e.target.value as 'comfortable' | 'compact';
              void update((s) => ({ ...s, density: next }));
            }}
          >
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact</option>
          </select>
        </div>
        <div className="sv-field">
          <label className="sv-label" htmlFor="opt-contrast">
            Contrast
          </label>
          <select
            id="opt-contrast"
            className="sv-control"
            value={contrast}
            data-testid="opt-contrast"
            onChange={(e) => setContrast(e.target.value as 'auto' | 'high')}
          >
            <option value="auto">Follow the system</option>
            <option value="high">High contrast</option>
          </select>
        </div>
        <div className="sv-field">
          <label className="sv-label" htmlFor="opt-singlekeys">
            The / and ? keys
          </label>
          <select
            id="opt-singlekeys"
            className="sv-control"
            value={singleKeys}
            data-testid="opt-singlekeys"
            onChange={(e) => setSingleKeys(e.target.value as 'on' | 'off')}
          >
            <option value="on">Search and help shortcuts on</option>
            <option value="off">Shortcuts off</option>
          </select>
        </div>
      </div>
    </details>
  );

  const center = (): ReactNode => {
    switch (view) {
      case 'duplicates':
        return <DuplicatesView focusHighlightId={duplicateFocus} onShow={showHighlight} />;
      case 'trash':
        return <TrashView />;
      case 'storage':
        return <StoragePanel hostState={hostState} onRebuildIndex={() => void host.rebuild()} />;
      default:
        return (
          <LibraryView
            lib={lib}
            filters={filters}
            onFilters={setFilters}
            sort={lib.sort}
            onSort={setSort}
            scope={scope}
            density={density}
            listRef={listRef}
            onOpenPreview={() => focusPane('preview')}
            onDismissPreview={() => {
              // Narrow widths: the preview is a panel over the list; Escape in the list closes it.
              if (
                shown === null ||
                !(window.matchMedia?.('(max-width: 1199px)').matches ?? false)
              ) {
                return false;
              }
              setShown(null);
              return true;
            }}
            queryText={text}
            onClearQuery={() => setText('')}
          />
        );
    }
  };

  return (
    <TreeDataContext.Provider value={treeData}>
      <div
        ref={rescueRef}
        className="dash"
        data-density={density}
        data-tree-open={treeOpen ? 'true' : 'false'}
        data-preview-open={shown !== null || standaloneNote ? 'true' : 'false'}
        data-testid="dashboard"
      >
        <a className="dash-skip" href="#dash-center">
          Skip to the main content
        </a>

        <header ref={topRef} className="dash-top">
          <div className="sv-row dash-top__row">
            <Button
              className="dash-tree-toggle"
              aria-expanded={treeOpen}
              aria-controls="dash-left"
              id="dash-tree-toggle"
              // Opening takes focus into the tree: at narrow widths the panel covers this button.
              onClick={() => (treeOpen ? setTreeOpen(false) : focusPane('tree'))}
              data-testid="toggle-tree"
            >
              Banks
            </Button>
            <h1 className="dash-title">StudyVault</h1>
            <div className="dash-top__search sv-grow">
              <SearchBar
                value={text}
                onChange={(next) => {
                  setText(next);
                  if (view !== 'library') setView('library');
                }}
                inputRef={searchRef}
                hostState={hostState}
                searching={searching}
                total={lib.total}
                extras={lib.extras}
                onRebuild={() => void host.rebuild()}
              />
            </div>
            <Button onClick={() => setPalette(true)} data-testid="open-palette">
              Commands <span className="sv-kbd">Ctrl+K</span>
            </Button>
            {appearance}
          </div>
        </header>

        <nav
          id="dash-left"
          className="dash-left"
          aria-label="Banks, views and saved searches"
          onKeyDown={(e) => {
            // Narrow widths: the tree is a panel over the page. Escape closes it, back to its button.
            if (e.key !== 'Escape' || e.defaultPrevented || !treeOpen) return;
            if ((e.target as Element).closest('dialog')) return;
            if (!(window.matchMedia?.('(max-width: 899px)').matches ?? false)) return;
            setTreeOpen(false);
            document.getElementById('dash-tree-toggle')?.focus();
          }}
        >
          <ul className="dash-views">
            {(Object.keys(VIEW_LABELS) as View[]).map((v) => (
              <li key={v}>
                <button
                  type="button"
                  className="dash-viewbtn"
                  aria-current={
                    view === v && (v !== 'library' || scope.bankId === null) ? 'page' : undefined
                  }
                  onClick={() => {
                    if (v === 'library') goLibrary(ALL_SCOPE);
                    else {
                      setView(v);
                      setTreeOpen(false); // the panel would otherwise stay over the view just chosen
                    }
                  }}
                  data-testid={`view-${v}`}
                >
                  {VIEW_LABELS[v]}
                  {v === 'library' && treeData.counts ? (
                    <span className="sv-muted sv-small">
                      {' '}
                      {treeData.counts.total.toLocaleString()}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
          {tree.error ? (
            <InlineNotice
              tone="error"
              title="Could not read your banks"
              action={<Button onClick={tree.refresh}>Try again</Button>}
            >
              {tree.error}
            </InlineNotice>
          ) : (
            <BankPane ref={bankRef} api={api} scope={scope} onScope={(next) => goLibrary(next)} />
          )}
          <SavedSearches
            controller={saved}
            currentText={text}
            currentSort={lib.sort}
            onRun={(s) => {
              setView('library');
              setText(s.query);
              if (s.sort === 'updated') setSort('updated-desc');
              else if (s.sort === 'priority') setSort('priority-desc');
              else setSort('relevance');
            }}
          />
          <div className="dash-links sv-stack sv-stack--tight">
            <Button
              variant="ghost"
              onClick={() =>
                void browser.runtime.openOptionsPage().catch((err: unknown) =>
                  toast.push({
                    tone: 'error',
                    message: errorMessage(err, 'Could not open settings.'),
                  }),
                )
              }
            >
              StudyVault settings
            </Button>
          </div>
        </nav>

        <main id="dash-center" className="dash-center" tabIndex={-1} aria-label={VIEW_LABELS[view]}>
          {center()}
        </main>

        <aside
          ref={previewRef}
          className="dash-right"
          aria-label="Preview"
          tabIndex={-1}
          data-testid="preview-pane"
          onKeyDown={(e) => {
            // Escape leaves the preview (it is an overlay on narrow screens) and returns to the list.
            const inField = (e.target as HTMLElement).closest('input, textarea, select');
            if (e.key === 'Escape' && !inField && !e.defaultPrevented) {
              setShown(null);
              focusPane('list');
            }
          }}
        >
          <div className="dash-right__bar">
            <Button
              onClick={() => {
                setShown(null);
                lib.setActiveKey(null);
              }}
              data-testid="close-preview"
            >
              Close preview
            </Button>
          </div>
          {standaloneNote ? (
            <div className="dash-preview" data-testid="preview-note-only">
              <InlineNotice tone="info" title="A note without a highlight">
                This note is not attached to a highlight, so there is no quote or source to show.
              </InlineNotice>
            </div>
          ) : (
            <Preview
              id={previewId}
              paletteFor={paletteFor}
              onFilterSource={(source) => {
                setFilters((f) => ({ ...f, source }));
                setView('library');
              }}
              onShow={showHighlight}
              onReviewDuplicates={(id) => {
                setDuplicateFocus(id);
                setView('duplicates');
              }}
              onGone={() => {
                setShown(null);
                lib.setActiveKey(null);
                bump();
              }}
            />
          )}
        </aside>

        {palette ? <CommandPalette commands={commands} onClose={() => setPalette(false)} /> : null}
        {legend ? (
          <Modal title="Keyboard shortcuts" onClose={() => setLegend(false)}>
            <ShortcutLegend />
            <p className="sv-small sv-muted">
              The / and ? keys work without Ctrl or Alt; turn them off under View options.
            </p>
            <div className="sv-row">
              <Button variant="primary" onClick={() => setLegend(false)} data-autofocus="">
                Close
              </Button>
            </div>
          </Modal>
        ) : null}
      </div>
    </TreeDataContext.Provider>
  );
}
