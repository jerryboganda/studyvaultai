import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { browser } from 'wxt/browser';
import { FolderTree, SlidersHorizontal, X } from 'lucide-react';
import { DEFAULT_PALETTE, type ColorId, type HighlightKind } from '@shared';
import {
  Button,
  ErrorBoundary,
  IconButton,
  InlineNotice,
  LOCAL_PREF_KEYS,
  ToastProvider,
  errorMessage,
  useApplyTheme,
  useFocusRescue,
  useSearchFocusRequest,
  useSettings,
  useToast,
} from '@ui';
import { BackupReminder } from '@ui/backup/BackupReminder';
import type { RelationRef } from '@storage';
import {
  CommandPalette,
  Modal,
  type Command,
  type LinkSearchPort,
  type RelatedPort,
  type TopicLibraryTarget,
} from '@ui/vault';
import { ApiProvider, realApi, useApi, type DashboardApi } from './api';
import { BankPane, type BankPaneHandle } from './BankPane';
import { DuplicatesView } from './DuplicatesView';
import { ChatEntry } from './ChatEntry';
import { initialView, parseDeepLink, parseSyllabusLink } from './deepLink';
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
  useLocalPref,
  useVaultQuery,
} from './hooks';
import { HomeView } from './HomeView';
import { LibraryView } from './LibraryView';
import { rowId, useLibrary } from './library';
import { extensionUrl } from './links';
import { BackToMore, MORE_VIEW_LABELS, MoreGridTiles, moreTiles, type MoreView } from './MoreTiles';
import { NewBankWizard } from './NewBankWizard';
import { Rail, type RailItem } from './Rail';
import { reviewPageUrl, useDueCount } from '@ui/review';
import { Preview } from './Preview';
import { SavedSearches, useSavedSearches } from './SavedSearches';
import { SearchBar, ShortcutLegend } from './SearchBar';
import { SearchHost, type SearchHostPorts } from '@ui/vault/searchHost';
import { StoragePanel } from './StoragePanel';
import { EMPTY_TREE_DATA, TreeDataContext, loadTreeData, type TreeData } from './treeData';
import { TrashView } from './TrashView';

type View = 'home' | 'library' | 'more' | MoreView;

const VIEW_LABELS: Record<View, string> = {
  home: 'Home',
  library: 'All highlights',
  more: 'More',
  ...MORE_VIEW_LABELS,
};

// The graph and its layout are not carried until the view is opened (ADR-018).
const GraphView = lazy(() => import('./GraphView'));
// The syllabus editor and its outline reader load with the view (ADR-020).
const SyllabusView = lazy(() =>
  import('./SyllabusView').then((m) => ({ default: m.SyllabusView })),
);

// The filing-rules manager is carried when the view is opened (ADR-017).
const RulesView = lazy(() => import('./RulesView').then((m) => ({ default: m.RulesView })));

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
  const [view, setView] = useState<View>(() => initialView(window.location.search));
  // Banks and Search are the same list; the rail marks the one the user went to.
  const [searchNav, setSearchNav] = useState(() => link.q !== null);
  const [newBank, setNewBank] = useState(false);
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
  // The item the graph is drawn around: undefined follows the preview, null is the overview.
  const [graphCentre, setGraphCentre] = useState<RelationRef | null | undefined>(undefined);
  const searchText = useDebounced(text, 180);

  // --- vault data ---------------------------------------------------------------------------
  const tree = useVaultQuery<TreeData>(() => loadTreeData(api), []);
  // One due count for the rail badge and the Home hero.
  const due = useDueCount();
  const treeData = tree.data ?? EMPTY_TREE_DATA;

  // --- search host --------------------------------------------------------------------------
  const host = useMemo(() => new SearchHost(portsFor(api)), [api]);
  useEffect(() => {
    void host.start();
    return () => host.dispose();
  }, [host]);
  const subscribe = useMemo(() => (cb: () => void) => host.subscribe(cb), [host]);
  const hostState = useSyncExternalStore(subscribe, () => host.state);
  // The Related section of the preview asks this index; `hostState` is a new object on every build
  // and catch-up, which is also when `host.revision` moves.
  const related = useMemo<RelatedPort>(
    () => ({
      state: hostState,
      revision: host.revision,
      find: (id, options) => host.related(id, options),
    }),
    [host, hostState],
  );
  // The picker of the Links section finds items in the same index.
  const linkSearch = useMemo<LinkSearchPort>(
    () => ({
      state: hostState,
      revision: host.revision,
      search: (query, options) => host.search(query, options),
    }),
    [host, hostState],
  );
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
  const graphFocus: RelationRef | null =
    graphCentre === undefined
      ? shown === null
        ? null
        : { kind: 'highlight', id: shown }
      : graphCentre;
  const linksPort = api.links;
  const links = useMemo(
    () =>
      linksPort
        ? {
            port: linksPort,
            search: linkSearch,
            onShowGraph: (item: RelationRef) => {
              setGraphCentre(item);
              setView('graph');
            },
          }
        : undefined,
    [linksPort, linkSearch],
  );

  // --- focus management ---------------------------------------------------------------------
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLElement>(null);
  const topRef = useRef<HTMLElement>(null);
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

  const focusPane = useCallback((pane: 'tree' | 'search' | 'list' | 'preview' | 'nav' | 'main') => {
    if (pane === 'nav') {
      document
        .querySelector<HTMLElement>('.dash-nav__item[aria-current="page"], .dash-nav__item')
        ?.focus();
    } else if (pane === 'main') {
      mainPane()?.focus();
    } else if (pane === 'tree') {
      // The tree and the search box live in the list view.
      setView('library');
      setTreeOpen(true);
      setTimeout(() => bankRef.current?.focusTree(), 0);
    } else if (pane === 'search') {
      setView('library');
      setSearchNav(true);
      // Already on screen in the list view; otherwise once that view has rendered.
      if (searchRef.current) searchRef.current.focus();
      else setTimeout(() => searchRef.current?.focus(), 0);
    } else if (pane === 'list') listRef.current?.focus();
    else previewRef.current?.focus();
  }, []);

  // The manifest command "focus-search", run while this page is the one in front.
  useSearchFocusRequest('dashboard', () => focusPane('search'));

  const cyclePane = useCallback(
    (direction: 1 | -1) => {
      const where = {
        tree: '.dash-left',
        search: '.dash-top',
        list: '.dash-center',
        preview: '.dash-right',
        nav: '.dash-rail',
        main: '.dash-center',
      } as const;
      const order =
        view === 'library'
          ? (['tree', 'search', 'list', 'preview', 'nav'] as const)
          : (['main', 'nav'] as const);
      const active = document.activeElement;
      const current = order.findIndex((p) => !!active?.closest(where[p]));
      const next = order[(current + direction + order.length) % order.length]!;
      focusPane(next);
    },
    [focusPane, view],
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
        focusPane('search');
      } else if (e.key === '?') {
        e.preventDefault();
        setLegend(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cyclePane, focusPane, singleKeys]);

  // --- saved searches -----------------------------------------------------------------------
  const saved = useSavedSearches(api.meta);

  // --- actions ------------------------------------------------------------------------------
  const goLibrary = useCallback((next?: Scope) => {
    setView('library');
    setSearchNav(false);
    if (next) setScope(next);
    setTreeOpen(false);
  }, []);

  const openSettings = useCallback(() => {
    void browser.runtime
      .openOptionsPage()
      .catch((err: unknown) =>
        toast.push({ tone: 'error', message: errorMessage(err, 'Could not open the settings.') }),
      );
  }, [toast]);

  const goRail = useCallback(
    (item: RailItem) => {
      if (item === 'home') setView('home');
      else if (item === 'more') setView('more');
      else if (item === 'banks') goLibrary();
      else focusPane('search');
      setTreeOpen(false);
    },
    [goLibrary, focusPane],
  );

  const showMoreView = useCallback((v: MoreView) => {
    if (v === 'graph') setGraphCentre(undefined);
    setView(v);
    setTreeOpen(false); // the panel would otherwise stay over the view just chosen
  }, []);

  // A syllabus topic leads to the list of what it is made of: one bank, or a search that matches
  // any of its banks and tags (shown in the search box, so it can be read and changed).
  const syllabusLink = useMemo(() => parseSyllabusLink(window.location.search), []);
  const showTopic = useCallback(
    (target: Exclude<TopicLibraryTarget, { kind: 'none' }>) => {
      setFilters(EMPTY_FILTERS);
      if (target.kind === 'bank') {
        setText('');
        goLibrary({ bankId: target.bankId, folderId: null });
      } else {
        setScope(ALL_SCOPE);
        setText(target.q);
        setView('library');
        setTreeOpen(false);
      }
    },
    [goLibrary],
  );

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
      { id: 'view-home', label: 'Go home', group: 'Go to', run: () => setView('home') },
      {
        id: 'view-more',
        label: 'Show more tools',
        group: 'Go to',
        keywords: 'exam cards stats backup imports reader sync',
        run: () => setView('more'),
      },
      {
        id: 'open-review',
        label: 'Open the review page',
        group: 'App',
        keywords: 'study cards due flashcards',
        run: () => window.open(reviewPageUrl(), '_blank', 'noopener'),
      },
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
        id: 'view-graph',
        label: 'Show the knowledge graph',
        group: 'Go to',
        keywords: 'links connections relations map',
        run: () => {
          setGraphCentre(undefined);
          setView('graph');
        },
      },
      {
        id: 'view-syllabus',
        label: 'Show the syllabus editor',
        group: 'Go to',
        keywords: 'exam coverage outline topics',
        run: () => setView('syllabus'),
      },
      {
        id: 'view-rules',
        label: 'Show the filing rules',
        group: 'Go to',
        keywords: 'auto file automatic smart rules suggestions',
        run: () => setView('rules'),
      },
      {
        id: 'view-chat',
        label: 'Chat with your notes (AI)',
        group: 'Go to',
        keywords: 'ask question ai assistant',
        run: () => setView('chat'),
      },
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
        disabledReason: needLibrary,
        run: () => focusPane('preview'),
      },
      { id: 'bank-new', label: 'New bank…', group: 'Banks', run: () => setNewBank(true) },
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
          setSearchNav(true);
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
      { id: 'open-settings', label: 'Open StudyVault settings', group: 'App', run: openSettings },
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
    openSettings,
  ]);

  const searching = lib.mode === 'search';
  const inLibrary = view === 'library';
  const kind = view === 'home' ? 'home' : inLibrary ? 'library' : 'page';
  const railCurrent: RailItem =
    view === 'home' ? 'home' : inLibrary ? (searchNav || searching ? 'search' : 'banks') : 'more';
  const tiles = moreTiles(settings?.features ?? null);

  const viewOptions = (
    <details className="dash-appearance">
      <summary className="dash-nav__item">
        <SlidersHorizontal aria-hidden="true" strokeWidth={2.4} />
        <span className="dash-nav__label">
          View<span className="sv-vh"> options</span>
        </span>
      </summary>
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
            <option value="on">Shortcuts on</option>
            <option value="off">Shortcuts off</option>
          </select>
        </div>
      </div>
    </details>
  );

  const suspense = (what: string, node: ReactNode) => (
    <Suspense
      fallback={
        <p className="sv-muted dash-loading" role="status">
          Opening the {what}…
        </p>
      }
    >
      {node}
    </Suspense>
  );

  const center = (): ReactNode => {
    switch (view) {
      case 'home':
        return (
          <HomeView
            due={due}
            onOpenBank={(bankId) => goLibrary({ bankId, folderId: null })}
            onAllBanks={() => goLibrary(ALL_SCOPE)}
            onNewBank={() => setNewBank(true)}
            treeError={tree.error}
            onRetryTree={tree.refresh}
            more={<MoreGridTiles tiles={tiles} label="More tools" onView={showMoreView} />}
          />
        );
      case 'more':
        return (
          <section className="dash-more" aria-labelledby="dash-more-h" data-testid="more-view">
            <h1 id="dash-more-h" className="dash-h1">
              More
            </h1>
            <MoreGridTiles tiles={tiles} label="More tools" onView={showMoreView} />
          </section>
        );
      case 'duplicates':
        return <DuplicatesView focusHighlightId={duplicateFocus} onShow={showHighlight} />;
      case 'trash':
        return <TrashView />;
      case 'storage':
        return <StoragePanel hostState={hostState} onRebuildIndex={() => void host.rebuild()} />;
      case 'graph':
        return suspense(
          'graph',
          <GraphView
            centre={graphFocus}
            onCentre={setGraphCentre}
            onShow={showHighlight}
            onBack={() => goLibrary()}
          />,
        );
      case 'syllabus':
        return suspense(
          'syllabus',
          <SyllabusView initialId={syllabusLink} onShowTopic={showTopic} />,
        );
      case 'rules':
        return suspense('filing rules', <RulesView />);
      case 'chat':
        return (
          <ChatEntry
            index={host.index}
            scope={scope}
            names={{ bank: names.bank, folder: names.folder }}
            tags={treeData.tags.map((t) => ({ id: t.tag.id, name: t.tag.name }))}
          />
        );
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
        data-view={kind}
        data-density={density}
        data-tree-open={treeOpen ? 'true' : 'false'}
        data-preview-open={shown !== null || standaloneNote ? 'true' : 'false'}
        data-testid="dashboard"
      >
        <a className="dash-skip" href="#dash-center">
          Skip to the main content
        </a>

        <Rail
          current={railCurrent}
          dueCount={due.count}
          onGo={goRail}
          onPalette={() => setPalette(true)}
          onSettings={openSettings}
          viewOptions={viewOptions}
        />

        {view !== 'home' ? (
          <header ref={topRef} className="dash-top">
            {inLibrary ? (
              <Button
                className="dash-tree-toggle"
                aria-expanded={treeOpen}
                aria-controls="dash-left"
                id="dash-tree-toggle"
                // Opening takes focus into the tree: at narrow widths the panel covers this button.
                onClick={() => (treeOpen ? setTreeOpen(false) : focusPane('tree'))}
                data-testid="toggle-tree"
              >
                <FolderTree aria-hidden="true" className="dash-btn-icon" />
                Banks
              </Button>
            ) : null}
            <h1 className="sv-vh">StudyVault</h1>
            <div className="dash-top__search">
              <SearchBar
                value={text}
                onChange={(next) => {
                  setText(next);
                  setSearchNav(true);
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
          </header>
        ) : null}

        {inLibrary ? (
          <nav
            id="dash-left"
            className="dash-left"
            aria-label="Banks and saved searches"
            onKeyDown={(e) => {
              // Narrow widths: the tree is a panel over the page. Escape closes it, back to its button.
              if (e.key !== 'Escape' || e.defaultPrevented || !treeOpen) return;
              if ((e.target as Element).closest('dialog')) return;
              if (!(window.matchMedia?.('(max-width: 899px)').matches ?? false)) return;
              setTreeOpen(false);
              document.getElementById('dash-tree-toggle')?.focus();
            }}
          >
            {/* Narrow widths: the panel covers its own button, so it carries a way out. */}
            <div className="dash-left__bar">
              <IconButton
                icon={X}
                label="Close banks"
                tipSide="left"
                onClick={() => {
                  setTreeOpen(false);
                  document.getElementById('dash-tree-toggle')?.focus();
                }}
                data-testid="close-tree"
              />
            </div>
            <button
              type="button"
              className="dash-all"
              aria-current={scope.bankId === null ? 'page' : undefined}
              onClick={() => goLibrary(ALL_SCOPE)}
              data-testid="view-library"
            >
              <span>All highlights</span>
              {treeData.counts ? (
                <span className="dash-count">{treeData.counts.total.toLocaleString()}</span>
              ) : null}
            </button>
            {tree.error ? (
              <InlineNotice
                tone="error"
                title="Could not read your banks"
                action={<Button onClick={tree.refresh}>Try again</Button>}
              >
                {tree.error}
              </InlineNotice>
            ) : (
              <BankPane
                ref={bankRef}
                api={api}
                scope={scope}
                onScope={(next) => goLibrary(next)}
                onNewBank={() => setNewBank(true)}
              />
            )}
            <SavedSearches
              controller={saved}
              currentText={text}
              currentSort={lib.sort}
              onRun={(s) => {
                setView('library');
                setSearchNav(true);
                setText(s.query);
                if (s.sort === 'updated') setSort('updated-desc');
                else if (s.sort === 'priority') setSort('priority-desc');
                else setSort('relevance');
              }}
            />
          </nav>
        ) : null}

        <main id="dash-center" className="dash-center" tabIndex={-1} aria-label={VIEW_LABELS[view]}>
          <BackupReminder />
          {kind === 'page' && view !== 'more' ? (
            <BackToMore onClick={() => setView('more')} />
          ) : null}
          {center()}
        </main>

        {inLibrary ? (
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
              <IconButton
                icon={X}
                label="Close preview"
                tipSide="left"
                onClick={() => {
                  setShown(null);
                  lib.setActiveKey(null);
                }}
                data-testid="close-preview"
              />
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
                related={related}
                links={links}
              />
            )}
          </aside>
        ) : null}

        {newBank ? (
          <NewBankWizard
            onClose={() => setNewBank(false)}
            onOpenBank={(bankId) => {
              setNewBank(false);
              goLibrary({ bankId, folderId: null });
              setTimeout(() => bankRef.current?.focusTree(), 0);
            }}
          />
        ) : null}
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
