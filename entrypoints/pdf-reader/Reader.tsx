import { useCallback, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  PdfOpenError,
  fetchPdf,
  requestOrigins,
  withdrawOrigins,
  type FetchFailure,
  type PdfStore,
  type ReaderParams,
} from '@pdf';
import { getSettings } from '@runtime';
import { defaultSettings } from '@shared';
import {
  Button,
  InlineNotice,
  ToastProvider,
  errorMessage,
  useApplyTheme,
  useFocusRescue,
  useSettings,
} from '@ui';
import { DocumentView } from './DocumentView';
import { openSession, readLocalFile, type Session } from './loader';
import type { OcrService } from './ocr';
import { OpenPanel, type WebState } from './OpenPanel';
import { PasswordDialog } from './PasswordDialog';
import { writePolicy, type WindowPrivacy } from './privacy';
import { StoredCopies } from './StoredCopies';

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

function describeOpenError(err: unknown): string {
  if (err instanceof PdfOpenError) {
    return err.kind === 'invalid'
      ? `${err.message} Try downloading the file again, or open a different copy.`
      : err.message;
  }
  return errorMessage(err, 'The PDF could not be opened.');
}

interface ReaderProps {
  store: PdfStore;
  /** The local OCR engine; undefined disables recognition with an explanation. */
  ocr: OcrService | undefined;
  params: ReaderParams;
  /** Which window this is (privacy.ts); one memoised answer per page load. */
  privacy: () => Promise<WindowPrivacy>;
}

/** Where focus goes when a toast that held it closes: the pages, never <body>. */
const pages = () => document.querySelector<HTMLElement>('.sv-viewer');

export function Reader(props: ReaderProps) {
  return (
    <ToastProvider returnFocus={pages}>
      <ReaderBody {...props} />
    </ToastProvider>
  );
}

function ReaderBody({ store, ocr, params, privacy: askWindow }: ReaderProps) {
  const { settings } = useSettings();
  useApplyTheme(settings?.theme);
  // A control that goes away with its own action (Cancel, a saved line) must not drop focus on <body>.
  const rescueRef = useFocusRescue();
  // Same rule as web capture: the database is shared with normal windows, so a private window
  // stores nothing unless the person said it may (SECURITY_PRIVACY, ADR-003). The window is asked,
  // not assumed (privacy.ts); the storage write path enforces the same rule, so this state is what
  // the page says and does, not the only guard.
  const [privacy, setPrivacy] = useState<WindowPrivacy | null>(null);
  useEffect(() => {
    let live = true;
    void askWindow().then((p) => live && setPrivacy(p));
    return () => {
      live = false;
    };
  }, [askWindow]);
  // Until the setting has been read nothing is written and nothing is announced.
  const policy =
    settings === null
      ? { persist: false, reason: null }
      : writePolicy(privacy, settings.allowIncognitoCapture);
  const persistAllowed = policy.persist;
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
        // Decided when the document opens, from the window and the setting as they are now (a
        // render's copy can be older than the first-load effect that calls this).
        const { persist } = writePolicy(
          await askWindow(),
          await getSettings().then(
            (s) => s.allowIncognitoCapture,
            () => false,
          ),
        );
        const session = await openSession({
          bytes,
          nameHint,
          originalUrl,
          store,
          onPassword: askPassword,
          onStage: (stage) => setPhase({ t: 'loading', stage }),
          persist,
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
    [askPassword, askWindow, params.highlight, params.page, store],
  );

  /** Open a kept copy by document id (the `?doc=` address and the stored-copies list). */
  const openStored = useCallback(
    async (id: string): Promise<void> => {
      try {
        const blob = await store.getDocumentBytes?.(id);
        const rec = await store.getDocument(id);
        if (blob) {
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
      setNotice(
        'StudyVault does not keep a copy of that PDF, so it cannot open it by itself. Choose the file again: your highlights are matched to it by its content and will reappear.',
      );
    },
    [open, store],
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

  /** Origins this page was given access to for one fetch (never ones the person already had). */
  const lent = useRef<Set<string>>(new Set());

  const handBack = useCallback(async () => {
    const patterns = [...lent.current];
    lent.current.clear();
    if (patterns.length === 0) return;
    try {
      // If what the person keeps on purpose cannot be read, the grant is left rather than guessed at.
      const stored = await getSettings();
      await withdrawOrigins(browser.permissions, patterns, [
        ...stored.persistentOrigins,
        ...(browser.runtime.getManifest().host_permissions ?? []),
      ]);
    } catch {
      /* best effort: a grant that stays is still listed under the extension's site access */
    }
  }, []);

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
      // A redirect may end only on the origin that was asked for or on one the person allowed.
      isOriginGranted: (pattern) => browser.permissions.contains({ origins: [pattern] }),
    });
    // The transfer is over, whether it worked or not: hand back what it was given access for.
    await handBack();
    if (!res.ok) {
      if (res.failure.kind !== 'aborted') setWeb({ t: 'failed', failure: res.failure });
      return;
    }
    await open(res.bytes, src.host, src.url);
  }, [handBack, open, params.src]);

  /**
   * Click handler. `requestOrigins` issues its permission calls before any await, so the click's
   * user gesture still counts. `extra` is a redirect's destination the person was asked about.
   */
  const allowAndOpen = useCallback(
    (extra: string[] = []) => {
      const src = params.src;
      if (!src?.ok) return;
      void requestOrigins(browser.permissions, [src.pattern, ...extra]).then(
        ({ granted, fresh }) => {
          if (!granted) {
            setWeb({ t: 'denied' });
            return undefined;
          }
          // Only what this click made accessible is handed back afterwards.
          for (const pattern of fresh) lent.current.add(pattern);
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
    },
    [fetchWeb, params.src],
  );

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
        await openStored(params.doc);
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
    <div ref={rescueRef} className="sv-app" data-testid="pdf-reader">
      {phase.t === 'ready' ? (
        <DocumentView
          key={phase.session.id}
          session={phase.session}
          store={store}
          ocr={ocr}
          settings={settings ?? defaultSettings()}
          persistAllowed={persistAllowed}
          blockedReason={policy.reason ?? undefined}
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
          notice={
            <>
              {policy.reason ? (
                <InlineNotice tone="warning" live title="Nothing is being saved">
                  {policy.reason} You can still open and read a PDF: its record, highlights and
                  recognised text are not stored.
                </InlineNotice>
              ) : null}
              {notice ? <InlineNotice tone="info">{notice}</InlineNotice> : null}
            </>
          }
          onFile={(f) => void openFile(f)}
          onAllowAndOpen={allowAndOpen}
          fileInputRef={inputRef}
          copies={<StoredCopies store={store} onOpen={(id) => void openStored(id)} />}
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
