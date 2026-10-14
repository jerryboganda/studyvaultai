import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { browser } from 'wxt/browser';
import {
  buildPdfAnchor,
  findInDocument,
  headingFor,
  rectsForRange,
  resolvePdfAnchor,
  summarizeTextStatus,
  type OutlineEntry,
  type OverlayItem,
  type PdfResolution,
  type PdfStore,
  type TextStatus,
} from '@pdf';
import {
  INCOGNITO_CAPTURE_REFUSAL,
  MAX_HEADING_CHARS,
  type BankLite,
  type ColorId,
  type HighlightKind,
  type HighlightPatch,
  type HighlightView,
  type PdfRect,
  type Settings,
} from '@shared';
import {
  BookOpen,
  Check,
  CircleCheck,
  CircleX,
  Files,
  FolderOpen,
  Globe,
  HardDrive,
  Highlighter,
  Info,
  Link,
  ScanText,
  Settings as SettingsIcon,
  TableOfContents,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  BarMeter,
  Button,
  IconButton,
  IconTabBar,
  InfoTip,
  InlineNotice,
  VaultBuddy,
  errorMessage,
  plural,
  useAsync,
  useDataEpoch,
  useSettings,
  useToast,
  type IconTab,
} from '@ui';
import { Companion } from './Companion';
import { DocInfo, type StoredCopyState } from './DocInfo';
import { filingToasts, type Filed } from './filing';
import type { Session } from './loader';
import {
  isPainted,
  nextRotation,
  pdfRows,
  stepZoom,
  type PdfSelection,
  type ZoomMode,
} from './model';
import type { OcrService } from './ocr';
import { useOcr } from './ocrController';
import { describeProgress } from './ocrModel';
import { OcrPanel, type PageTextState, type RerunInfo } from './OcrPanel';
import { SaveBar, type SaveDraft } from './SaveBar';
import { useLinks } from './links';
import { SidePane, usePageLinks, type NavTab } from './SidePane';
import { Toolbar, type SearchState } from './Toolbar';
import { Viewer, type ViewerHandle, type ViewerShortcut } from './Viewer';

/** Opens the settings page; a failure leaves the reader as it was (nothing to roll back). */
export const openSettings = (): void => {
  void browser.runtime.openOptionsPage().catch(() => undefined);
};

/** The side pane's tabs: the companion (highlights, page text) and the navigation ones. */
type PaneTab = 'highlights' | NavTab | 'text';
const isNav = (t: PaneTab | null): t is NavTab => t === 'outline' || t === 'pages' || t === 'links';

const OUTCOME_ICON: Record<'success' | 'warning' | 'error' | 'info', LucideIcon> = {
  success: CircleCheck,
  warning: TriangleAlert,
  error: CircleX,
  info: Info,
};

/** Said when S or Enter is pressed with nothing selected: how to select without a mouse. */
const NO_SELECTION_HELP =
  'Nothing is selected. Press F7 for caret browsing, select text with Shift and the arrow keys, then press S.';

const NO_HIGHLIGHTS: readonly HighlightView[] = [];
const NO_BANKS: readonly BankLite[] = [];

const ORPHANED: PdfResolution = {
  status: 'orphaned',
  method: 'none',
  confidence: 0,
  start: null,
  end: null,
  rects: [],
};

/** The open document: toolbar, navigation pane, pages, companion pane. */
export function DocumentView({
  session,
  store,
  ocr: ocrService,
  settings,
  persistAllowed,
  blockedReason = INCOGNITO_CAPTURE_REFUSAL,
  initialPage,
  initialHighlight,
  onOpenAnother,
}: {
  session: Session;
  store: PdfStore;
  ocr: OcrService | undefined;
  settings: Settings;
  /** False in a private window without consent: reading works, nothing is written. */
  persistAllowed: boolean;
  /** Why nothing is written while `persistAllowed` is false (private window, or window unknown). */
  blockedReason?: string;
  initialPage: number | null;
  initialHighlight: string | null;
  onOpenAnother(): void;
}) {
  const { doc } = session;
  const toast = useToast();
  const { update: updateSettings } = useSettings();
  const epoch = useDataEpoch();

  const viewer = useRef<ViewerHandle>(null);
  const pageInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const engaged = useRef(false);
  // The document row exists in the store; written lazily when saving becomes allowed.
  const persisted = useRef(session.persisted);

  const [zoom, setZoom] = useState<ZoomMode>({ kind: 'fit-width' });
  const [rotation, setRotation] = useState(0);
  const [page, setPage] = useState(1);
  const [resolutions, setResolutions] = useState<ReadonlyMap<string, PdfResolution>>(new Map());
  const [selection, setSelection] = useState<PdfSelection | null>(null);
  const [flashId, setFlashId] = useState<string | null>(initialHighlight);
  // One side pane with icon tabs; open on the highlights in a wide window, closed in a narrow one.
  const [pane, setPane] = useState<PaneTab | null>(() =>
    window.innerWidth >= 900 ? 'highlights' : null,
  );
  const [outline, setOutline] = useState<OutlineEntry[] | null>(null);
  const [pageNotes, setPageNotes] = useState<ReadonlyMap<number, string>>(new Map());
  const [ocrPages, setOcrPages] = useState<ReadonlySet<number>>(new Set());
  const [textStatus, setTextStatus] = useState<TextStatus>(session.textStatus);
  const [kept, setKept] = useState<StoredCopyState>('unknown');
  const [copyBusy, setCopyBusy] = useState(false);
  const [search, setSearch] = useState<SearchState>({
    query: '',
    status: 'idle',
    total: 0,
    current: -1,
    pagesDone: 0,
    pageCount: doc.pageCount,
    truncated: false,
  });
  const [matches, setMatches] = useState<{
    list: Array<{ page: number; start: number; end: number }>;
  }>({
    list: [],
  });
  const searchAbort = useRef<AbortController | null>(null);
  const lastQuery = useRef('');

  const palette = settings.palette;
  const paletteFor = useCallback((k: HighlightKind): ColorId => palette[k], [palette]);

  // ---- data ---------------------------------------------------------------------------------
  const loadedHighlights = useAsync(
    () => store.listPdfHighlights(session.id),
    [session.id],
    [epoch],
  );
  const loadedBanks = useAsync(() => store.listBanks(), [], [epoch]);
  const highlights: readonly HighlightView[] = loadedHighlights.data ?? NO_HIGHLIGHTS;
  const banks: readonly BankLite[] = loadedBanks.data ?? NO_BANKS;
  const refreshHighlights = loadedHighlights.refresh;
  const refreshBanks = loadedBanks.refresh;
  const refresh = useCallback(async () => {
    refreshHighlights();
    refreshBanks();
  }, [refreshBanks, refreshHighlights]);

  // ---- recognised (OCR) text ----------------------------------------------------------------
  const ocr = useOcr({
    doc,
    documentId: session.id,
    store,
    service: ocrService,
    persist: persistAllowed,
    initial: session.ocr,
    onTextChanged: (n) => viewer.current?.redraw(n),
  });

  const canKeepCopy = Boolean(
    store.cacheDocumentBytes && store.getDocumentBytes && store.removeDocumentBytes,
  );
  useEffect(() => {
    if (!canKeepCopy) return;
    store
      .getDocumentBytes?.(session.id)
      .then((b) => setKept(b ? { bytes: b.size } : 'none'))
      .catch(() => setKept('unknown'));
  }, [canKeepCopy, session.id, store]);

  useEffect(() => {
    let live = true;
    doc
      .getOutline()
      .then((o) => live && setOutline(o))
      .catch(() => live && setOutline([]));
    return () => {
      live = false;
    };
  }, [doc]);

  // Where does each highlight sit now? Resolved against the page text of the file as opened.
  useEffect(() => {
    let live = true;
    void (async () => {
      const next = new Map<string, PdfResolution>();
      const byPage = new Map<number, HighlightView[]>();
      for (const h of highlights) {
        if (h.anchorSet.type !== 'pdf') continue;
        const list = byPage.get(h.anchorSet.pageNumber) ?? [];
        list.push(h);
        byPage.set(h.anchorSet.pageNumber, list);
      }
      for (const [n, list] of byPage) {
        const pt = n <= doc.pageCount ? await doc.pageText(n).catch(() => null) : null;
        for (const h of list) {
          next.set(
            h.id,
            pt && h.anchorSet.type === 'pdf' ? resolvePdfAnchor(h.anchorSet, pt) : ORPHANED,
          );
        }
      }
      if (live) setResolutions(next);
    })();
    return () => {
      live = false;
    };
    // `ocr.revision` changes when recognised text or a correction changed the page streams.
  }, [highlights, doc, ocrPages, ocr.revision]);

  const rows = useMemo(() => pdfRows(highlights), [highlights]);

  const overlays = useMemo(() => {
    const out = new Map<number, OverlayItem[]>();
    for (const r of rows) {
      const res = resolutions.get(r.view.id);
      if (!isPainted(res)) continue;
      const list = out.get(r.pageNumber) ?? [];
      list.push({
        id: r.view.id,
        rects: res.rects,
        color: r.view.color,
        kind: r.view.kind,
        selected: false,
        label: `Highlight on page ${r.pageNumber}: ${r.view.exactQuote.slice(0, 80)}. Open in the highlights list.`,
      });
      out.set(r.pageNumber, list);
    }
    return out;
  }, [rows, resolutions]);

  // Open on the requested page / highlight once the highlights are known.
  const jumped = useRef(false);
  const goToHighlight = useCallback(
    (id: string) => {
      const row = rows.find((r) => r.view.id === id);
      if (!row) return;
      const res = resolutions.get(id);
      const rect: PdfRect | null = isPainted(res) ? (res.rects[0] ?? null) : null;
      viewer.current?.reveal(row.pageNumber, rect);
      setFlashId(id);
      setPane('highlights');
    },
    [resolutions, rows],
  );
  useEffect(() => {
    if (jumped.current) return;
    if (initialHighlight) {
      const row = rows.find((r) => r.view.id === initialHighlight);
      if (row && resolutions.size > 0) {
        jumped.current = true;
        const res = resolutions.get(row.view.id);
        viewer.current?.reveal(row.pageNumber, isPainted(res) ? (res.rects[0] ?? null) : null);
      }
    } else if (initialPage) {
      jumped.current = true;
      viewer.current?.jumpToPage(initialPage);
    } else {
      jumped.current = true;
    }
  }, [initialHighlight, initialPage, resolutions, rows]);

  // ---- text status (sampled at open, refined while reading) ---------------------------------
  const onPageText = useCallback(
    (n: number, info: { hasText: boolean; source: 'embedded' | 'ocr' }) => {
      setPageNotes((prev) => {
        const note =
          info.source === 'ocr'
            ? 'Text recognised by OCR (machine output, may contain errors)'
            : info.hasText
              ? undefined
              : 'No selectable text on this page (scanned image)';
        if (prev.get(n) === note) return prev;
        const next = new Map(prev);
        if (note) next.set(n, note);
        else next.delete(n);
        return next;
      });
      setOcrPages((prev) => {
        if (info.source === 'ocr' ? prev.has(n) : !prev.has(n)) return prev;
        const next = new Set(prev);
        if (info.source === 'ocr') next.add(n);
        else next.delete(n);
        return next;
      });
      const embedded = info.source === 'embedded' ? info.hasText : false;
      session.known.set(n, embedded);
      const verdict = summarizeTextStatus(session.known);
      setTextStatus((old) => {
        if (old === verdict) return old;
        if (persisted.current) {
          void store
            .upsertDocument({
              id: session.id,
              title: session.title,
              pageCount: doc.pageCount,
              byteLength: session.byteLength,
              originalUrl: session.originalUrl,
              textStatus: verdict,
            })
            .catch(() => undefined);
        }
        return verdict;
      });
    },
    [doc.pageCount, session, store],
  );

  // ---- navigation and zoom -------------------------------------------------------------------
  const goToPage = useCallback((n: number) => {
    viewer.current?.jumpToPage(n);
    setPage(n);
  }, []);

  const [effectiveZoom, setEffectiveZoom] = useState(1);

  // Links of the pages: internal ones move the view (and Back returns), addresses are confirmed first.
  const links = useLinks({ doc, viewer, onPage: setPage, announce: toast.announce });

  const onShortcut = useCallback(
    (a: ViewerShortcut) => {
      switch (a) {
        case 'next-page':
          return goToPage(Math.min(doc.pageCount, page + 1));
        case 'previous-page':
          return goToPage(Math.max(1, page - 1));
        case 'first-page':
          return goToPage(1);
        case 'last-page':
          return goToPage(doc.pageCount);
        case 'zoom-in':
          return setZoom({ kind: 'custom', zoom: stepZoom(effectiveZoom, 1) });
        case 'zoom-out':
          return setZoom({ kind: 'custom', zoom: stepZoom(effectiveZoom, -1) });
        case 'fit-width':
          return setZoom({ kind: 'fit-width' });
        case 'rotate':
          return setRotation((r) => nextRotation(r));
        case 'search':
          return searchInput.current?.focus();
        case 'go-to-page':
          return pageInput.current?.focus();
        case 'save-selection': {
          // The chosen kind dot first (the bar's first decision), else its first field.
          const focusBar = () =>
            (
              bar.current?.querySelector<HTMLElement>('input:checked') ??
              bar.current?.querySelector<HTMLElement>('select, textarea, button')
            )?.focus();
          if (bar.current) return focusBar();
          // The bar waits for the gate's pause after a selection: ask for it now, and let React
          // show it before focus moves (the key press is the user's act; nothing is guessed).
          flushSync(() => {
            viewer.current?.flushSelection();
          });
          if (bar.current) return focusBar();
          toast.push({ message: NO_SELECTION_HELP });
          return undefined;
        }
      }
    },
    [doc.pageCount, effectiveZoom, goToPage, page, toast],
  );

  // ---- search --------------------------------------------------------------------------------
  const revealMatch = useCallback(
    async (index: number, list: Array<{ page: number; start: number; end: number }>) => {
      const m = list[index];
      if (!m) return;
      const pt = await doc.pageText(m.page).catch(() => null);
      const rect = pt ? (rectsForRange(pt, m.start, m.end)[0] ?? null) : null;
      viewer.current?.reveal(m.page, rect);
    },
    [doc],
  );

  const runSearch = useCallback(
    async (query: string) => {
      searchAbort.current?.abort();
      const ac = new AbortController();
      searchAbort.current = ac;
      lastQuery.current = query;
      setMatches({ list: [] });
      setSearch((s) => ({
        ...s,
        status: 'searching',
        total: 0,
        current: -1,
        pagesDone: 0,
        truncated: false,
      }));
      const collected: Array<{ page: number; start: number; end: number }> = [];
      let started = false;
      const res = await findInDocument({
        query,
        pageCount: doc.pageCount,
        signal: ac.signal,
        getText: async (n) => (await doc.pageText(n)).text,
        onProgress: (done) => setSearch((s) => (ac.signal.aborted ? s : { ...s, pagesDone: done })),
        onMatches: (batch) => {
          collected.push(...batch);
          setMatches({ list: collected.slice() });
          setSearch((s) => ({
            ...s,
            total: collected.length,
            current: s.current < 0 ? 0 : s.current,
          }));
          if (!started) {
            started = true;
            void revealMatch(0, collected);
          }
        },
      });
      if (ac.signal.aborted) return;
      setSearch((s) => ({
        ...s,
        status: 'done',
        total: res.matches.length,
        truncated: res.truncated,
      }));
    },
    [doc, revealMatch],
  );

  const onFind = (direction: 1 | -1): void => {
    const q = search.query.trim();
    if (q === '') return;
    if (q !== lastQuery.current || search.status === 'idle') {
      void runSearch(q);
      return;
    }
    if (matches.list.length === 0) return;
    const next = (search.current + direction + matches.list.length) % matches.list.length;
    setSearch((s) => ({ ...s, current: next }));
    void revealMatch(next, matches.list);
  };

  useEffect(() => () => searchAbort.current?.abort(), []);

  // Search as you type (debounced); Enter / the arrows then step through the matches.
  useEffect(() => {
    const q = search.query.trim();
    if (q === '' || q === lastQuery.current) return undefined;
    const t = setTimeout(() => void runSearch(q), 350);
    return () => clearTimeout(t);
  }, [runSearch, search.query]);

  // Corrected or newly recognised text changes what a search finds: search again.
  const seenRevision = useRef(ocr.revision);
  useEffect(() => {
    if (seenRevision.current === ocr.revision) return;
    seenRevision.current = ocr.revision;
    const q = lastQuery.current;
    if (q !== '') void runSearch(q);
  }, [ocr.revision, runSearch]);

  const onQuery = useCallback((query: string) => {
    if (query.trim() === '') {
      searchAbort.current?.abort();
      lastQuery.current = '';
      setMatches({ list: [] });
      setSearch((s) => ({ ...s, query, status: 'idle', total: 0, current: -1, truncated: false }));
    } else {
      setSearch((s) => ({ ...s, query }));
    }
  }, []);

  // ---- selection and saving ------------------------------------------------------------------
  const onSelection = useCallback((sel: PdfSelection | null) => {
    // Focus moved into the save bar (typing a note clears the browser's own selection): keep it.
    if (sel === null && engaged.current) return;
    setSelection(sel);
  }, []);

  const dismissBar = useCallback(() => {
    engaged.current = false;
    document.getSelection()?.removeAllRanges();
    setSelection(null);
    viewer.current?.focus();
  }, []);

  // Escape dismisses the save bar from anywhere (the bar handles it itself while it has focus).
  const barOpen = selection !== null;
  useEffect(() => {
    if (!barOpen) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) dismissBar();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [barOpen, dismissBar]);

  /** Nearest outline heading above the passage; never blocks a save if the page cannot be read. */
  const headingOf = useCallback(
    async (pageNumber: number, rects: readonly PdfRect[]): Promise<string | null> => {
      if (!outline || outline.length === 0) return null;
      try {
        const view = (await doc.getPage(pageNumber)).view;
        const top = rects.length > 0 ? Math.min(...rects.map((r) => r.y)) : null;
        const heading = headingFor(outline, pageNumber, top, view);
        return heading ? heading.slice(0, MAX_HEADING_CHARS) : null;
      } catch {
        return null;
      }
    },
    [doc, outline],
  );

  const save = useCallback(
    async (draft: SaveDraft): Promise<{ summary: string }> => {
      const sel = selection;
      if (!sel) throw new Error('The selection is gone. Select the text again.');
      if (!persistAllowed) throw new Error(blockedReason);
      if (!persisted.current) {
        // Opened while saving was not allowed (private window), allowed since: the row is written now.
        await store.upsertDocument({
          id: session.id,
          title: session.title,
          pageCount: doc.pageCount,
          byteLength: session.byteLength,
          originalUrl: session.originalUrl,
          textStatus,
        });
        persisted.current = true;
      }
      const created: string[] = [];
      const filings: Filed[] = [];
      let duplicates = 0;
      let bankName = '';
      let xp = 0;
      for (const part of sel.parts) {
        const built = buildPdfAnchor({
          documentFingerprint: session.id,
          pageNumber: part.pageNumber,
          rotation: part.part.page.rotation,
          pageText: part.part.page.text,
          start: part.start,
          end: part.end,
          rects: part.rects,
        });
        if (!built.ok) {
          throw new Error(
            built.reason === 'too-long'
              ? 'That passage is too long to save as one highlight. Select less text.'
              : 'There is no text in that selection.',
          );
        }
        const res = await store.savePdfHighlight({
          documentId: session.id,
          anchorSet: built.anchorSet,
          exactQuote: built.exactQuote,
          kind: draft.kind,
          color: paletteFor(draft.kind),
          bankId: draft.bankId,
          userComment: draft.comment,
          priority: 3,
          headingContext: await headingOf(part.pageNumber, built.anchorSet.rects),
          captureMethod: 'toolbar',
        });
        bankName = res.bank.name;
        xp += res.xp ?? 0; // present only while Game mode is on (ADR-022)
        if (res.status === 'duplicate' && !res.addedToBank) duplicates++;
        else created.push(res.highlight.id);
        // A filing rule that names PDF document as a source answered for this new highlight.
        if (res.filing && res.status === 'created') {
          filings.push({ id: res.highlight.id, filing: res.filing });
        }
      }
      await refresh();
      void updateSettings((s) => ({ ...s, lastBankId: draft.bankId ?? s.lastBankId })).catch(
        () => undefined,
      );
      const summary =
        created.length === 0
          ? 'Already saved.'
          : `Saved ${plural(created.length, 'highlight')} to ${bankName}.${duplicates > 0 ? ` ${plural(duplicates, 'passage')} already saved.` : ''}${xp > 0 ? ` +${xp} XP` : ''}`;
      toast.push({
        message: summary,
        action:
          created.length > 0
            ? {
                label: 'Undo',
                onClick: () => {
                  void Promise.all(created.map((id) => store.deleteHighlight(id))).then(
                    refresh,
                    (err: unknown) =>
                      toast.push({ tone: 'error', message: errorMessage(err, 'Undo failed.') }),
                  );
                },
              }
            : undefined,
      });
      if (store.filing && filings.length > 0) {
        for (const t of filingToasts(filings, store.filing, (next) => toast.push(next), refresh)) {
          toast.push(t);
        }
      }
      // The new card is where the person can see it: the open pane turns to the highlights.
      if (created[0]) {
        setFlashId(created[0]);
        setPane((p) => (p === null ? null : 'highlights'));
      }
      engaged.current = false;
      document.getSelection()?.removeAllRanges();
      setSelection(null);
      viewer.current?.focus();
      return { summary };
    },
    [
      blockedReason,
      doc.pageCount,
      headingOf,
      paletteFor,
      persistAllowed,
      refresh,
      selection,
      session,
      store,
      textStatus,
      toast,
      updateSettings,
    ],
  );

  const actions = useMemo(
    () => ({
      goTo: goToHighlight,
      update: async (id: string, patch: HighlightPatch) => {
        await store.updateHighlight(id, patch);
        await refresh();
      },
      remove: async (id: string) => {
        await store.deleteHighlight(id);
        await refresh();
        toast.push({
          message: 'Highlight deleted.',
          action: store.restoreHighlight
            ? {
                label: 'Undo',
                onClick: () => {
                  void store
                    .restoreHighlight?.(id)
                    .then(refresh, (err: unknown) =>
                      toast.push({ tone: 'error', message: errorMessage(err, 'Undo failed.') }),
                    );
                },
              }
            : undefined,
          focusAction: true,
        });
      },
    }),
    [goToHighlight, refresh, store, toast],
  );

  // ---- keep a copy ----------------------------------------------------------------------------
  const copyUnavailable = !persistAllowed
    ? blockedReason
    : canKeepCopy
      ? undefined
      : 'Keeping copies is not available in this build.';
  const keepCopy = useCallback(async () => {
    setCopyBusy(true);
    try {
      const bytes = await doc.getBytes();
      const info = await store.cacheDocumentBytes?.(
        session.id,
        new Blob([bytes as BlobPart], { type: 'application/pdf' }),
      );
      setKept({ bytes: info?.byteLength ?? bytes.byteLength });
      toast.push({ message: 'A copy of this PDF is kept in StudyVault on this device.' });
    } catch (err) {
      toast.push({ tone: 'error', message: errorMessage(err, 'The copy could not be kept.') });
    } finally {
      setCopyBusy(false);
    }
  }, [doc, session.id, store, toast]);
  const removeCopy = useCallback(async () => {
    setCopyBusy(true);
    try {
      await store.removeDocumentBytes?.(session.id);
      setKept('none');
      toast.push({ message: 'The stored copy was removed. Your highlights are unchanged.' });
    } catch (err) {
      toast.push({ tone: 'error', message: errorMessage(err, 'The copy could not be removed.') });
    } finally {
      setCopyBusy(false);
    }
  }, [session.id, store, toast]);

  // ---- derived view state ---------------------------------------------------------------------
  const pending = selection;
  const uncovered = [...session.known].filter(([n, has]) => !has && !ocrPages.has(n)).length;
  const scannedLine =
    uncovered === 0 && textStatus !== 'text'
      ? null
      : textStatus === 'scanned'
        ? 'This PDF has no selectable text.'
        : textStatus === 'partial'
          ? 'Some pages of this PDF have no selectable text.'
          : null;
  // What the header badge says about the text: recognised pages count once nothing is left to read.
  const textBadge: { tone: 'success' | 'info' | 'warning'; icon: LucideIcon; label: string } =
    textStatus === 'text'
      ? { tone: 'success', icon: Check, label: 'Selectable text' }
      : uncovered === 0 && ocr.pages.size > 0
        ? { tone: 'info', icon: ScanText, label: 'Text recognised' }
        : textStatus === 'partial'
          ? { tone: 'warning', icon: ScanText, label: 'Partly scanned' }
          : { tone: 'warning', icon: ScanText, label: 'No text' };
  const TextIcon = textBadge.icon;

  const known = session.known.get(page);
  const pageState: PageTextState = ocrPages.has(page)
    ? 'ocr'
    : known === false
      ? 'none'
      : known === true
        ? 'embedded'
        : 'unknown';
  const ocrUnavailable = ocrService
    ? undefined
    : 'Text recognition is not available in this build.';
  const running = ocr.run !== null;
  const rerunInfo = useMemo((): RerunInfo => {
    let lines = 0;
    let withCorrections = 0;
    let withEarlier = 0;
    for (const po of ocr.pages.values()) {
      const n = Object.keys(po.corrections.lines).length + Object.keys(po.corrections.words).length;
      if (n > 0) {
        lines += n;
        withCorrections += 1;
      }
      if (po.previous) withEarlier += 1;
    }
    return {
      recognisedPages: ocr.pages.size,
      corrected: { pages: withCorrections, lines },
      withEarlier,
      msPerPage: ocr.msPerPage,
      sessionOnly: !persistAllowed,
      onRerecognisePage: () => ocr.rerun('page', page),
      onRerecogniseAll: () => ocr.rerun('document'),
      onRestore: () => ocr.restore(page),
    };
  }, [ocr, page, persistAllowed]);

  // Read while the pane is open, so the Links tab shows its count whichever tab is in front.
  const pageLinks = usePageLinks(doc, page, pane !== null);
  const paneTabs: IconTab<PaneTab>[] = [
    { id: 'highlights', label: 'Highlights', icon: Highlighter, count: rows.length },
    { id: 'outline', label: 'Outline', icon: TableOfContents },
    { id: 'pages', label: 'Pages', icon: Files },
    { id: 'links', label: 'Links', icon: Link, count: pageLinks?.links.length },
    { id: 'text', label: 'Page text', icon: ScanText },
  ];
  const host = session.originalUrl ? new URL(session.originalUrl).host : null;
  const runProgress = ocr.run?.finding
    ? { value: ocr.run.finding.checked, max: ocr.run.finding.total }
    : ocr.run?.progress
      ? { value: Math.round(ocr.run.progress.progress * 100), max: 100 }
      : null;
  const outcomeTile = ocr.outcome
    ? ocr.outcome.tone === 'error'
      ? 'danger'
      : ocr.outcome.tone === 'info'
        ? 'primary'
        : ocr.outcome.tone
    : 'primary';
  const OutcomeIcon = ocr.outcome ? OUTCOME_ICON[ocr.outcome.tone] : Info;

  return (
    <div className="sv-doc">
      <div className="sv-doc__bar">
        <span className="sv-tile sv-art--primary sv-doc__logo" aria-hidden="true">
          <BookOpen strokeWidth={2.4} />
        </span>
        <div className="sv-doc__head">
          <h1 className="sv-doc__title" title={session.title}>
            {session.title}
          </h1>
          <p className="sv-doc__meta">
            {/* Pages and source are in Details too: a narrow window keeps only the text status. */}
            <span className="sv-pill sv-doc__wide">
              <Files aria-hidden="true" strokeWidth={2.4} />
              {plural(doc.pageCount, 'page')}
            </span>
            <span className="sv-pill sv-doc__wide">
              {host ? (
                <Globe aria-hidden="true" strokeWidth={2.4} />
              ) : (
                <HardDrive aria-hidden="true" strokeWidth={2.4} />
              )}
              {host ? `from ${host}` : 'from this device'}
            </span>
            <span className={`sv-pill sv-pill--${textBadge.tone}`}>
              <TextIcon aria-hidden="true" strokeWidth={2.4} />
              <span data-testid="pdf-text-status">{textBadge.label}</span>
            </span>
          </p>
        </div>
        <DocInfo
          title={session.title}
          pageCount={doc.pageCount}
          byteLength={session.byteLength}
          fingerprint={session.id}
          fingerprintNote={session.fingerprintNote}
          textStatus={textStatus}
          scannedPages={uncovered}
          ocrPages={ocr.pages.size}
          host={host}
          copy={canKeepCopy ? kept : 'none'}
          copyUnavailable={copyUnavailable}
          busy={copyBusy}
          onKeep={() => void keepCopy()}
          onRemove={() => void removeCopy()}
        />
        <IconButton icon={FolderOpen} label="Open another PDF" onClick={onOpenAnother} />
        <IconButton icon={SettingsIcon} label="Settings" tipSide="left" onClick={openSettings} />
      </div>

      <Toolbar
        page={page}
        pageCount={doc.pageCount}
        zoom={zoom}
        effectiveZoom={effectiveZoom}
        search={search}
        companionOpen={pane === 'highlights' || pane === 'text'}
        sidePaneOpen={isNav(pane)}
        highlightCount={rows.length}
        pageInput={pageInput}
        searchInput={searchInput}
        onGoToPage={goToPage}
        onZoom={setZoom}
        onRotate={() => setRotation((r) => nextRotation(r))}
        onQuery={onQuery}
        onFind={onFind}
        onToggleCompanion={() =>
          setPane((p) => (p === 'highlights' || p === 'text' ? null : 'highlights'))
        }
        onToggleSidePane={() => setPane((p) => (isNav(p) ? null : 'outline'))}
        backTo={links.backTo}
        onBack={links.back}
      />

      {!persistAllowed ? (
        <InlineNotice tone="warning" live title="Nothing is being saved">
          {blockedReason}
        </InlineNotice>
      ) : null}

      {scannedLine && !ocr.run ? (
        <section className="sv-ocrcard" aria-label="Scanned pages">
          <span className="sv-tile sv-art--warning" aria-hidden="true">
            <ScanText strokeWidth={2.4} />
          </span>
          <div className="sv-ocrcard__text">
            <p className="sv-ocrcard__title">
              Scanned pages{' '}
              <InfoTip label="About recognising text" align="start">
                Recognition runs on this device with a bundled engine: nothing is uploaded, and it
                works offline. The result is machine-recognised text that may contain errors.
                {persistAllowed
                  ? ''
                  : ' Nothing is being saved in this window, so it lasts this session only.'}
              </InfoTip>
            </p>
            <p className="sv-ocrcard__line">{scannedLine}</p>
            {ocrUnavailable ? <p className="sv-small">{ocrUnavailable}</p> : null}
          </div>
          <div className="sv-ocrcard__actions">
            <Button
              variant="primary"
              onClick={() => ocr.start('document')}
              busy={running}
              disabledReason={ocrUnavailable}
              data-testid="pdf-ocr"
            >
              <ScanText aria-hidden="true" />
              Recognise text
            </Button>
            <Button
              onClick={() => ocr.start('page', page)}
              busy={running}
              disabledReason={
                ocrUnavailable ??
                (pageState === 'none'
                  ? undefined
                  : pageState === 'ocr'
                    ? `Page ${page} has already been recognised.`
                    : pageState === 'unknown'
                      ? `Page ${page} is still being read.`
                      : `Page ${page} has selectable text.`)
              }
              data-testid="pdf-ocr-this-page"
            >
              Only page {page}
            </Button>
          </div>
        </section>
      ) : null}

      {ocr.run ? (
        <section className="sv-ocrcard" aria-label="Text recognition">
          <VaultBuddy pose="think" size={48} />
          <div className="sv-ocrcard__text">
            <p className="sv-ocrcard__title">
              {ocr.run.again
                ? ocr.run.scope === 'document'
                  ? 'Reading the recognised pages again'
                  : 'Reading a page again'
                : ocr.run.scope === 'document'
                  ? 'Recognising this document'
                  : 'Recognising a page'}
            </p>
            <p className="sv-ocrcard__line" data-testid="pdf-ocr-status">
              {/* The eye gets every step; a screen reader gets one sentence per finished page. */}
              <span aria-hidden="true">
                {ocr.run.finding
                  ? `Finding pages without text… ${ocr.run.finding.checked} of ${ocr.run.finding.total} checked.`
                  : ocr.run.progress
                    ? describeProgress(ocr.run.progress)
                    : 'Starting…'}
              </span>
              <span className="sv-sr" role="status">
                {ocr.run.finding
                  ? 'Finding pages without text…'
                  : ocr.run.progress
                    ? `Recognising text: ${ocr.run.progress.completed} of ${ocr.run.progress.total} pages done.`
                    : 'Starting…'}
              </span>
            </p>
            {runProgress ? (
              <BarMeter
                value={runProgress.value}
                max={runProgress.max}
                label="Text recognition progress"
                size="sm"
              />
            ) : null}
          </div>
          <div className="sv-ocrcard__actions">
            <Button onClick={ocr.cancel} data-testid="pdf-ocr-cancel">
              <X aria-hidden="true" />
              Cancel
            </Button>
          </div>
        </section>
      ) : null}
      {ocr.outcome ? (
        <section
          className="sv-ocrcard"
          role={ocr.outcome.tone === 'error' ? 'alert' : 'status'}
          aria-label="Text recognition result"
        >
          <span className={`sv-tile sv-art--${outcomeTile}`} aria-hidden="true">
            <OutcomeIcon strokeWidth={2.4} />
          </span>
          <div className="sv-ocrcard__text">
            <p className="sv-ocrcard__title">{ocr.outcome.title}</p>
            <p className="sv-ocrcard__line" data-testid="pdf-ocr-outcome">
              {ocr.outcome.detail}
            </p>
            {ocr.outcome.lines && ocr.outcome.lines.length > 0 ? (
              <ul className="sv-small sv-ocrcard__list" data-testid="pdf-ocr-outcome-list">
                {ocr.outcome.lines.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            ) : null}
          </div>
          <div className="sv-ocrcard__actions">
            <IconButton icon={X} label="Dismiss" tipSide="left" onClick={ocr.dismissOutcome} />
          </div>
        </section>
      ) : null}

      <div className={`sv-doc__main${pane ? ' sv-doc__main--split' : ''}`}>
        {/* Over the pages, not above them: a notice that pushes the pages down moves the link the person
            meant to click next, and shortens the viewer (which draws every page again). */}
        {links.notice ? <div className="sv-linknotice">{links.notice}</div> : null}
        <Viewer
          ref={viewer}
          doc={doc}
          zoom={zoom}
          rotation={rotation}
          overlays={overlays}
          flashId={flashId}
          find={{ matches: matches.list, current: search.current }}
          pending={pending}
          pageNotes={pageNotes}
          onPage={setPage}
          onSelection={onSelection}
          onPageText={onPageText}
          onSelectHighlight={(id) => {
            setFlashId(id);
            setPane('highlights');
          }}
          onFollowLink={links.follow}
          onShortcut={onShortcut}
          onError={() => undefined}
          onEffectiveZoom={setEffectiveZoom}
        />
        {pane ? (
          <aside className="sv-rightpane" aria-label="Side pane">
            <IconTabBar label="Side pane" tabs={paneTabs} active={pane} onChange={setPane}>
              {pane === 'highlights' ? (
                <Companion
                  rows={rows}
                  resolutions={resolutions}
                  banks={banks}
                  ocrPages={ocrPages}
                  originalUrl={session.originalUrl}
                  selectedId={flashId}
                  paletteFor={paletteFor}
                  actions={actions}
                  loading={loadedHighlights.loading}
                  error={loadedHighlights.error}
                  onRetry={loadedHighlights.retryable ? refreshHighlights : undefined}
                />
              ) : pane === 'text' ? (
                <OcrPanel
                  pageNumber={page}
                  state={pageState}
                  ocr={ocr.pages.get(page)}
                  unavailableReason={ocrUnavailable}
                  busy={running}
                  onRecognizePage={() => ocr.start('page', page)}
                  onSetLine={(line, text) => ocr.setLine(page, line, text)}
                  onRevertLine={(line) => ocr.revertLine(page, line)}
                  onRevertPage={() => ocr.revertPage(page)}
                  rerun={rerunInfo}
                />
              ) : (
                <SidePane
                  tab={pane}
                  doc={doc}
                  outline={outline}
                  page={page}
                  links={pageLinks}
                  onGoToPage={goToPage}
                  onFollowLink={links.follow}
                />
              )}
            </IconTabBar>
          </aside>
        ) : null}
      </div>

      {selection ? (
        <SaveBar
          blockedReason={persistAllowed ? undefined : blockedReason}
          selection={selection}
          banks={banks}
          banksError={loadedBanks.error}
          defaultKind={settings.defaultKind}
          defaultBankId={settings.lastBankId}
          paletteFor={paletteFor}
          barRef={bar}
          onSave={save}
          onCreateBank={async (name) => {
            const bank = await store.createBank(name);
            refreshBanks();
            return bank;
          }}
          onDismiss={dismissBar}
          onEngaged={(v) => {
            engaged.current = v;
            // Focus left the bar after the browser had already cleared its selection: nothing to save.
            if (!v && (document.getSelection()?.isCollapsed ?? true)) setSelection(null);
          }}
        />
      ) : null}
      {links.dialog}
    </div>
  );
}
