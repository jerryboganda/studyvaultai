import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  PdfOpenError,
  buildPdfAnchor,
  findInDocument,
  fetchPdf,
  pageHasText,
  rectsForRange,
  resolvePdfAnchor,
  runOcr,
  summarizeTextStatus,
  type FetchFailure,
  type OcrPort,
  type OcrWordInput,
  type OverlayItem,
  type PdfResolution,
  type PdfStore,
  type ReaderParams,
  type TextStatus,
} from '@pdf';
import { getSettings } from '@runtime';
import {
  INCOGNITO_CAPTURE_REFUSAL,
  defaultSettings,
  type BankLite,
  type ColorId,
  type HighlightKind,
  type HighlightPatch,
  type HighlightView,
  type PdfRect,
  type Settings,
} from '@shared';
import {
  Button,
  InlineNotice,
  ToastProvider,
  errorMessage,
  plural,
  useApplyTheme,
  useAsync,
  useDataEpoch,
  useSettings,
  useToast,
} from '@ui';
import { Companion } from './Companion';
import { openSession, readLocalFile, type Session } from './loader';
import {
  isPainted,
  nextRotation,
  pdfRows,
  stepZoom,
  type PdfSelection,
  type ZoomMode,
} from './model';
import { OpenPanel, type WebState } from './OpenPanel';
import { PasswordDialog } from './PasswordDialog';
import { SaveBar, type SaveDraft } from './SaveBar';
import { Toolbar, type SearchState } from './Toolbar';
import { Viewer, type ViewerHandle, type ViewerShortcut } from './Viewer';

type Phase =
  | { t: 'idle' }
  | { t: 'loading'; stage: string }
  | { t: 'ready'; session: Session; page: number | null; highlight: string | null };

interface PasswordRequest {
  reason: 'needed' | 'incorrect';
  resolve(password: string | null): void;
  /** Changes with every request so a retry mounts a fresh, empty dialog. */
  seq: number;
}

/** True in a private (incognito) window; false when the API is unavailable (unit tests). */
function inPrivateWindow(): boolean {
  try {
    return browser.extension?.inIncognitoContext === true;
  } catch {
    return false;
  }
}

function describeOpenError(err: unknown): string {
  if (err instanceof PdfOpenError) {
    return err.kind === 'invalid'
      ? `${err.message} Try downloading the file again, or open a different copy.`
      : err.message;
  }
  return errorMessage(err, 'The PDF could not be opened.');
}

export function Reader({
  store,
  ocr,
  params,
}: {
  store: PdfStore;
  ocr: OcrPort | undefined;
  params: ReaderParams;
}) {
  return (
    <ToastProvider>
      <ReaderBody store={store} ocr={ocr} params={params} />
    </ToastProvider>
  );
}

function ReaderBody({
  store,
  ocr,
  params,
}: {
  store: PdfStore;
  ocr: OcrPort | undefined;
  params: ReaderParams;
}) {
  const { settings } = useSettings();
  useApplyTheme(settings?.theme);
  // Same rule as web capture: the database is shared with normal windows, so a private window
  // stores nothing unless the person said it may (SECURITY_PRIVACY, ADR-003).
  const persistAllowed = !inPrivateWindow() || settings?.allowIncognitoCapture === true;
  const [flagOff, setFlagOff] = useState(false);
  const [phase, setPhase] = useState<Phase>({ t: 'idle' });
  const [fileError, setFileError] = useState<string | null>(null);
  const [web, setWeb] = useState<WebState>({ t: 'none' });
  const [notice, setNotice] = useState<string | null>(null);
  const [password, setPassword] = useState<PasswordRequest | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const current = useRef<Session | null>(null);
  const [label, setLabel] = useState('this PDF');
  const seq = useRef(0);

  const askPassword = useCallback(
    (reason: 'needed' | 'incorrect') =>
      new Promise<string | null>((resolve) => setPassword({ reason, resolve, seq: ++seq.current })),
    [],
  );

  const open = useCallback(
    async (bytes: Uint8Array, nameHint: string | null, originalUrl: string | null) => {
      setLabel(nameHint ?? 'this PDF');
      setFileError(null);
      setNotice(null);
      setPhase({ t: 'loading', stage: 'Opening' });
      try {
        const session = await openSession({
          bytes,
          nameHint,
          originalUrl,
          store,
          onPassword: askPassword,
          onStage: (stage) => setPhase({ t: 'loading', stage }),
          persist: persistAllowed,
        });
        await current.current?.doc.destroy().catch(() => undefined);
        current.current = session;
        setPhase({ t: 'ready', session, page: params.page, highlight: params.highlight });
        setWeb({ t: 'none' });
      } catch (err) {
        setPhase({ t: 'idle' });
        setFileError(describeOpenError(err));
      } finally {
        setPassword(null);
      }
    },
    [askPassword, params.highlight, params.page, persistAllowed, store],
  );

  const openFile = useCallback(
    async (file: File) => {
      setFileError(null);
      setPhase({ t: 'loading', stage: 'Reading the file' });
      const read = await readLocalFile(file);
      if (!read.ok) {
        setPhase({ t: 'idle' });
        setFileError(
          read.failure.kind === 'file' ? read.failure.message : 'The file could not be read.',
        );
        return;
      }
      await open(read.bytes, file.name, null);
    },
    [open],
  );

  const fetchWeb = useCallback(async () => {
    const src = params.src;
    if (!src?.ok) return;
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setWeb({ t: 'fetching', loaded: 0, total: null });
    const res = await fetchPdf(src.url, {
      signal: ac.signal,
      onProgress: (loaded, total) => setWeb({ t: 'fetching', loaded, total }),
    });
    if (!res.ok) {
      if (res.failure.kind !== 'aborted') setWeb({ t: 'failed', failure: res.failure });
      return;
    }
    await open(res.bytes, src.host, src.url);
  }, [open, params.src]);

  /** Click handler: permissions.request must be the first await so the user gesture still counts. */
  const allowAndOpen = useCallback(() => {
    const src = params.src;
    if (!src?.ok) return;
    void browser.permissions.request({ origins: [src.pattern] }).then(
      (granted) => {
        if (!granted) {
          setWeb({ t: 'denied' });
          return undefined;
        }
        return fetchWeb();
      },
      (err: unknown) => {
        const failure: FetchFailure = {
          kind: 'permission',
          message: errorMessage(err, 'Chrome did not allow the request for site access.'),
        };
        setWeb({ t: 'failed', failure });
      },
    );
  }, [fetchWeb, params.src]);

  // First load: what the address asked for.
  useEffect(() => {
    let live = true;
    void (async () => {
      // The feature flag is read here, before anything is fetched or opened.
      const flags = await getSettings().catch(() => null);
      if (!live) return;
      if (flags && !flags.features.pdfReader) {
        setFlagOff(true);
        return;
      }
      if (params.doc) {
        try {
          const blob = await store.getDocumentBytes?.(params.doc);
          const rec = await store.getDocument(params.doc);
          if (blob && live) {
            await open(
              new Uint8Array(await blob.arrayBuffer()),
              rec?.title ?? null,
              rec?.originalUrl ?? null,
            );
            return;
          }
        } catch {
          /* fall through to the explanation below */
        }
        if (live) {
          setNotice(
            'StudyVault does not keep a copy of that PDF, so it cannot open it by itself. Choose the file again: your highlights are matched to it by its content and will reappear.',
          );
        }
        return;
      }
      const src = params.src;
      if (src?.ok) {
        const has = await browser.permissions
          .contains({ origins: [src.pattern] })
          .catch(() => false);
        if (!live) return;
        if (has) void fetchWeb();
        else setWeb({ t: 'need-permission' });
      }
    })();
    return () => {
      live = false;
    };
    // The address is read once; later changes come from user actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drag and drop anywhere on the page.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent): boolean =>
      Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const over = (e: DragEvent): void => {
      if (hasFiles(e)) e.preventDefault();
    };
    const leave = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (flagOff) return;
      depth = 0;
      setDragging(false);
      const file = e.dataTransfer?.files[0];
      if (file) void openFile(file);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [flagOff, openFile]);

  useEffect(() => {
    document.title =
      phase.t === 'ready' ? `${phase.session.title} - StudyVault` : 'Open a PDF - StudyVault';
  }, [phase]);

  useEffect(
    () => () => {
      abort.current?.abort();
      void current.current?.doc.destroy();
    },
    [],
  );

  const closeDocument = (): void => {
    const s = current.current;
    current.current = null;
    void s?.doc.destroy();
    setPhase({ t: 'idle' });
  };

  return (
    <div className="sv-app" data-testid="pdf-reader">
      {phase.t === 'ready' ? (
        <DocumentView
          key={phase.session.id}
          session={phase.session}
          store={store}
          ocr={ocr}
          settings={settings ?? defaultSettings()}
          persistAllowed={persistAllowed}
          initialPage={phase.page}
          initialHighlight={phase.highlight}
          onOpenAnother={closeDocument}
        />
      ) : phase.t === 'loading' ? (
        <main className="sv-open" aria-busy="true" data-testid="pdf-loading">
          <h1>Opening…</h1>
          <p role="status">{phase.stage}…</p>
          <Button
            onClick={() => {
              abort.current?.abort();
              setPhase({ t: 'idle' });
            }}
          >
            Cancel
          </Button>
        </main>
      ) : flagOff ? (
        <main className="sv-open" data-testid="pdf-disabled">
          <h1>The PDF reader is turned off</h1>
          <p className="sv-muted">
            The PDF reader feature is switched off in StudyVault's settings, so nothing was opened
            or downloaded.
          </p>
        </main>
      ) : (
        <OpenPanel
          src={params.src}
          web={web}
          fileError={fileError}
          notice={notice ? <InlineNotice tone="info">{notice}</InlineNotice> : null}
          onFile={(f) => void openFile(f)}
          onAllowAndOpen={allowAndOpen}
          fileInputRef={inputRef}
        />
      )}
      {dragging ? (
        <div className="sv-drop" role="status" data-testid="pdf-drop">
          Drop a PDF to open it. It is read on this device and not uploaded.
        </div>
      ) : null}
      {password ? (
        <PasswordDialog
          key={password.seq}
          reason={password.reason}
          fileLabel={label}
          onSubmit={(pw) => {
            password.resolve(pw);
            setPassword(null);
          }}
          onCancel={() => {
            password.resolve(null);
            setPassword(null);
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The open document
// ---------------------------------------------------------------------------------------------

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

function DocumentView({
  session,
  store,
  ocr,
  settings,
  persistAllowed,
  initialPage,
  initialHighlight,
  onOpenAnother,
}: {
  session: Session;
  store: PdfStore;
  ocr: OcrPort | undefined;
  settings: Settings;
  /** False in a private window without consent: reading works, nothing is written. */
  persistAllowed: boolean;
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
  const [companionOpen, setCompanionOpen] = useState(() => window.innerWidth >= 900);
  const [pageNotes, setPageNotes] = useState<ReadonlyMap<number, string>>(new Map());
  const [ocrPages, setOcrPages] = useState<ReadonlySet<number>>(new Set());
  const [textStatus, setTextStatus] = useState<TextStatus>(session.textStatus);
  const [ocrRun, setOcrRun] = useState<{ done: number; total: number; stage: string } | null>(null);
  const [kept, setKept] = useState<number | null | 'unknown'>('unknown');
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

  useEffect(() => {
    if (store.cacheDocumentBytes && store.getDocumentBytes && store.removeDocumentBytes) {
      store
        .getDocumentBytes(session.id)
        .then((b) => setKept(b ? b.size : null))
        .catch(() => setKept('unknown'));
    }
  }, [session.id, store]);

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
  }, [highlights, doc, ocrPages]);

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
      setCompanionOpen(true);
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
        case 'save-selection':
          return bar.current?.querySelector<HTMLElement>('select, textarea, button')?.focus();
      }
    },
    [doc.pageCount, effectiveZoom, goToPage, page],
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

  const save = useCallback(
    async (draft: SaveDraft): Promise<{ summary: string }> => {
      const sel = selection;
      if (!sel) throw new Error('The selection is gone. Select the text again.');
      if (!persistAllowed) throw new Error(INCOGNITO_CAPTURE_REFUSAL);
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
      let duplicates = 0;
      let bankName = '';
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
          headingContext: null,
          captureMethod: 'toolbar',
        });
        bankName = res.bank.name;
        if (res.status === 'duplicate' && !res.addedToBank) duplicates++;
        else created.push(res.highlight.id);
      }
      await refresh();
      void updateSettings((s) => ({ ...s, lastBankId: draft.bankId ?? s.lastBankId })).catch(
        () => undefined,
      );
      const summary =
        created.length === 0
          ? 'Already saved.'
          : `Saved ${plural(created.length, 'highlight')} to ${bankName}.${duplicates > 0 ? ` ${plural(duplicates, 'passage')} already saved.` : ''}`;
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
      engaged.current = false;
      document.getSelection()?.removeAllRanges();
      setSelection(null);
      viewer.current?.focus();
      return { summary };
    },
    [
      doc.pageCount,
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

  // ---- OCR -----------------------------------------------------------------------------------
  const ocrReason = !persistAllowed
    ? INCOGNITO_CAPTURE_REFUSAL
    : !ocr
      ? 'OCR is not available in this build yet: the text-recognition module has not been connected. Scanned pages stay image-only until it is.'
      : !store.saveOcrPage
        ? 'OCR results cannot be stored in this build.'
        : undefined;

  const runDocumentOcr = useCallback(async () => {
    if (!ocr || !store.saveOcrPage) return;
    const ac = new AbortController();
    setOcrRun({ done: 0, total: 0, stage: 'Finding pages without text' });
    const missing: number[] = [];
    for (let n = 1; n <= doc.pageCount; n++) {
      if ((await doc.textSource(n)) === 'embedded' && !pageHasText(await doc.pageText(n)))
        missing.push(n);
    }
    if (missing.length === 0) {
      setOcrRun(null);
      toast.push({ message: 'Every page already has text.' });
      return;
    }
    const words = new Map<number, OcrWordInput[]>();
    const res = await runOcr({
      pages: missing,
      port: ocr,
      signal: ac.signal,
      onProgress: (done, total) => setOcrRun({ done, total, stage: 'Recognising text' }),
      render: async (n) => {
        const pdfPage = await doc.getPage(n);
        const vp = pdfPage.getViewport({ scale: 2, rotation: 0 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        await pdfPage.render({ canvas, viewport: vp }).promise;
        return canvas;
      },
      save: async (n, result, normalized) => {
        words.set(n, normalized);
        await store.saveOcrPage?.({
          documentId: session.id,
          pageNumber: n,
          text: result.text,
          words: normalized.map((w) => ({
            ...w,
            confidence: typeof result.confidence === 'number' ? result.confidence : 0,
          })),
          language: result.language ?? 'und',
          engine: result.engine ?? 'ocr',
          confidence: typeof result.confidence === 'number' ? result.confidence : null,
        });
      },
    });
    const stored = await store.getOcrPages?.(session.id).catch(() => []);
    const merged = new Map<number, OcrWordInput[]>(words);
    for (const p of stored ?? []) {
      if (!merged.has(p.pageNumber)) {
        merged.set(
          p.pageNumber,
          p.words.map((w) => ({ text: w.text, x: w.x, y: w.y, w: w.w, h: w.h })),
        );
      }
    }
    doc.setOcrPages(merged);
    setOcrRun(null);
    setOcrPages(new Set([...merged.keys()]));
    viewer.current?.redraw();
    toast.push({
      message:
        res.failed.length === 0
          ? `Recognised text on ${plural(res.done.length, 'page')}. It is machine output and may contain errors.`
          : `Recognised ${plural(res.done.length, 'page')}; ${res.failed.length} could not be read.`,
    });
  }, [doc, ocr, session.id, store, toast]);

  // ---- keep a copy ----------------------------------------------------------------------------
  const canKeep =
    persistAllowed &&
    Boolean(store.cacheDocumentBytes && store.getDocumentBytes && store.removeDocumentBytes);
  const toggleKeep = useCallback(async () => {
    try {
      if (typeof kept === 'number') {
        await store.removeDocumentBytes?.(session.id);
        setKept(null);
        toast.push({ message: 'The stored copy was removed. Your highlights are unchanged.' });
      } else {
        const bytes = await doc.getBytes();
        const info = await store.cacheDocumentBytes?.(
          session.id,
          new Blob([bytes as BlobPart], { type: 'application/pdf' }),
        );
        setKept(info?.byteLength ?? bytes.byteLength);
        toast.push({ message: 'A copy of this PDF is kept in StudyVault on this device.' });
      }
    } catch (err) {
      toast.push({
        tone: 'error',
        message: errorMessage(err, 'The stored copy could not be changed.'),
      });
    }
  }, [doc, kept, session.id, store, toast]);

  const pending = selection;
  const uncovered = [...session.known].filter(([n, has]) => !has && !ocrPages.has(n)).length;
  const scannedBanner =
    uncovered === 0 && textStatus !== 'text'
      ? null
      : textStatus === 'scanned'
        ? 'This PDF has no selectable text: it looks like scanned images. You can view the pages, but search and highlights need text to work with.'
        : textStatus === 'partial'
          ? 'Some pages of this PDF have no selectable text (scanned images). Those pages cannot be highlighted until their text is recognised.'
          : null;

  return (
    <div className="sv-doc">
      <div className="sv-doc__head">
        <h1 className="sv-doc__title" title={session.title}>
          {session.title}
        </h1>
        <p className="sv-small sv-muted">
          {plural(doc.pageCount, 'page')} ·{' '}
          {session.originalUrl
            ? `from ${new URL(session.originalUrl).host}`
            : 'opened from this device'}{' '}
          ·{' '}
          <span data-testid="pdf-text-status">
            {textStatus === 'text'
              ? 'selectable text'
              : textStatus === 'scanned'
                ? 'scanned (no text)'
                : 'partly scanned'}
          </span>
          {canKeep && kept !== 'unknown' ? (
            <>
              {' · '}
              <Button variant="ghost" onClick={() => void toggleKeep()}>
                {typeof kept === 'number'
                  ? `Remove stored copy (${(kept / 1048576).toFixed(1)} MB)`
                  : 'Keep a copy in StudyVault'}
              </Button>
            </>
          ) : null}
        </p>
      </div>

      <Toolbar
        page={page}
        pageCount={doc.pageCount}
        zoom={zoom}
        effectiveZoom={effectiveZoom}
        search={search}
        companionOpen={companionOpen}
        highlightCount={rows.length}
        pageInput={pageInput}
        searchInput={searchInput}
        onGoToPage={goToPage}
        onZoom={setZoom}
        onRotate={() => setRotation((r) => nextRotation(r))}
        onQuery={onQuery}
        onFind={onFind}
        onToggleCompanion={() => setCompanionOpen((v) => !v)}
        onOpenAnother={onOpenAnother}
      />

      {!persistAllowed ? (
        <InlineNotice tone="warning" title="Private window">
          {INCOGNITO_CAPTURE_REFUSAL} You can still read this PDF.
        </InlineNotice>
      ) : null}
      {session.fingerprintNote ? (
        <InlineNotice tone="info">{session.fingerprintNote}</InlineNotice>
      ) : null}
      {scannedBanner ? (
        <InlineNotice
          tone="warning"
          title="Scanned pages"
          action={
            <Button
              onClick={() => void runDocumentOcr()}
              busy={ocrRun !== null}
              disabledReason={ocrReason}
              data-testid="pdf-ocr"
            >
              OCR this document
            </Button>
          }
        >
          <p>{scannedBanner}</p>
          {ocrReason ? <p className="sv-small">{ocrReason}</p> : null}
          {ocrRun ? (
            <p role="status">
              {ocrRun.stage}
              {ocrRun.total > 0 ? ` ${ocrRun.done} of ${ocrRun.total}` : ''}…
            </p>
          ) : null}
        </InlineNotice>
      ) : null}

      <div className={`sv-doc__main${companionOpen ? ' sv-doc__main--split' : ''}`}>
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
            setCompanionOpen(true);
          }}
          onShortcut={onShortcut}
          onError={() => undefined}
          onEffectiveZoom={setEffectiveZoom}
        />
        {companionOpen ? (
          <Companion
            rows={rows}
            resolutions={resolutions}
            banks={banks}
            ocrPages={ocrPages}
            originalUrl={session.originalUrl}
            selectedId={flashId}
            paletteFor={paletteFor}
            actions={actions}
          />
        ) : null}
      </div>

      {selection ? (
        <SaveBar
          blockedReason={persistAllowed ? undefined : INCOGNITO_CAPTURE_REFUSAL}
          selection={selection}
          banks={banks}
          defaultKind={settings.defaultKind}
          defaultBankId={settings.lastBankId}
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
    </div>
  );
}
