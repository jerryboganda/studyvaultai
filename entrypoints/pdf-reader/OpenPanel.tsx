import { useRef, type ReactNode } from 'react';
import type { FetchFailure, SrcCheck } from '@pdf';
import { Button, InlineNotice } from '@ui';

export type WebState =
  | { t: 'none' }
  | { t: 'need-permission' }
  | { t: 'denied' }
  | { t: 'fetching'; loaded: number; total: number | null }
  | { t: 'failed'; failure: FetchFailure };

const mb = (n: number): string => `${(n / 1048576).toFixed(n > 10 * 1048576 ? 0 : 1)} MB`;

/** Failures that retrying cannot fix: the answer will be the same. */
const NO_RETRY = new Set<FetchFailure['kind']>([
  'sign-in',
  'redirected-non-pdf',
  'redirect-blocked',
  'redirect-needs-access',
  'not-found',
  'not-pdf',
  'too-large',
]);

/** What the person can do about each way a web PDF can fail (never "try to get around it"). */
function advice(f: FetchFailure): string {
  switch (f.kind) {
    case 'sign-in':
    case 'redirected-non-pdf':
    case 'redirect-blocked':
      return 'StudyVault does not use your browser sign-ins to fetch files. Open the link in your browser, sign in, download the PDF, then choose the downloaded file below.';
    case 'redirect-needs-access':
      return 'The address sent the download to a site you have not allowed. You can allow that site for this download only, or download the PDF in your browser and choose it below.';
    case 'not-pdf':
      return 'If the link opens a PDF in your browser, download it from there and choose the downloaded file below.';
    case 'not-found':
      return 'Check the address, or choose a copy of the file from your computer below.';
    case 'too-large':
      return 'Download the file in your browser and choose it below if it is within the size the reader opens, or split it into smaller files.';
    case 'offline':
      return 'Reconnect and try again, or choose a PDF that is already on this device below.';
    case 'network':
      return 'You can still read it: download the PDF in your browser, then choose the file below. Your highlights attach to the file itself, so they match either way.';
    case 'permission':
      return 'Choose the downloaded file below, or allow access to the site and try again.';
    default:
      return 'You can download the file in your browser and choose it below.';
  }
}

export function OpenPanel({
  src,
  web,
  fileError,
  notice,
  onFile,
  onAllowAndOpen,
  fileInputRef,
  copies,
}: {
  src: SrcCheck | null;
  web: WebState;
  fileError: string | null;
  /** Extra context from the reader, e.g. "no stored copy of this document". */
  notice: ReactNode;
  onFile(file: File): void;
  /**
   * Called synchronously from the click: permissions.request needs the user gesture. `extra` lists
   * further origin patterns to ask for in the same prompt (the site a redirect ended at).
   */
  onAllowAndOpen(extra?: string[]): void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  /** The stored-copy manager (rendered after the open options). */
  copies?: ReactNode;
}) {
  const local = useRef<HTMLInputElement>(null);
  const input = fileInputRef ?? local;
  /** A redirect that ended on a site the person has not allowed: ask for exactly that one. */
  const redirectTo = web.t === 'failed' ? web.failure.redirectTo : undefined;

  return (
    <main className="sv-open" data-testid="pdf-open">
      <h1>Open a PDF in StudyVault</h1>
      <p className="sv-muted">
        PDFs open in StudyVault's own reader, so highlights, notes and search work on them. A file
        you choose is read on this device and StudyVault does not upload it. A web address is
        fetched from that site only after you allow it. If you turned on sync, the details and
        recognised text of a PDF sync as described in Settings.
      </p>
      {notice}

      <details className="sv-open__about" data-testid="pdf-builtin-note">
        <summary>About Chrome's built-in PDF viewer</summary>
        <p className="sv-muted">
          When Chrome opens a PDF in its own viewer, extensions cannot read or mark that page, so
          StudyVault does not try. To highlight such a PDF, right-click its link (or the page) and
          choose <strong>Open in StudyVault reader</strong>, or choose the downloaded file here.
        </p>
      </details>

      <section className="sv-open__card" aria-labelledby="open-file">
        <h2 id="open-file">From your computer</h2>
        <p className="sv-muted">Choose a PDF, or drop one anywhere on this page.</p>
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          className="sv-sr"
          tabIndex={-1}
          aria-hidden="true"
          data-testid="pdf-file-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) onFile(file);
          }}
        />
        <Button
          variant="primary"
          onClick={() => input.current?.click()}
          data-testid="pdf-choose-file"
        >
          Choose a PDF file
        </Button>
        {fileError ? (
          <InlineNotice tone="error" title="That file could not be opened">
            {fileError}
          </InlineNotice>
        ) : null}
      </section>

      {src ? (
        <section className="sv-open__card" aria-labelledby="open-web" data-testid="pdf-web">
          <h2 id="open-web">From the web</h2>
          {!src.ok ? (
            <InlineNotice tone="error" title="This address cannot be opened">
              {src.message}
            </InlineNotice>
          ) : (
            <>
              <p className="sv-wrap" dir="ltr">
                <span className="sv-muted">Address: </span>
                {src.url}
              </p>
              {web.t === 'need-permission' || web.t === 'denied' ? (
                <>
                  <p>
                    To download this file, StudyVault needs your permission to contact{' '}
                    <strong>{src.host}</strong>. It is used only to fetch this PDF: StudyVault does
                    not read other pages on that site, does not send your cookies or sign-ins, and
                    sends nothing anywhere else.
                  </p>
                  {web.t === 'denied' ? (
                    <InlineNotice tone="warning" title="Access was not granted">
                      Without it the file cannot be downloaded from here. You can choose a
                      downloaded copy above instead.
                    </InlineNotice>
                  ) : null}
                  <Button
                    variant="primary"
                    onClick={() => onAllowAndOpen()}
                    data-testid="pdf-allow-open"
                  >
                    Allow access to {src.host} and open
                  </Button>
                </>
              ) : null}
              {web.t === 'fetching' ? (
                <p role="status" data-testid="pdf-fetching">
                  Downloading from {src.host}…{' '}
                  {web.total ? `${mb(web.loaded)} of ${mb(web.total)}` : mb(web.loaded)}
                </p>
              ) : null}
              {web.t === 'failed' ? (
                <InlineNotice tone="error" title="The PDF could not be downloaded">
                  <p>{web.failure.message}</p>
                  <p>{advice(web.failure)}</p>
                  {redirectTo ? (
                    <p>
                      <Button
                        variant="primary"
                        onClick={() => onAllowAndOpen([redirectTo.pattern])}
                        data-testid="pdf-allow-redirect"
                      >
                        Allow access to {redirectTo.host} and open
                      </Button>
                    </p>
                  ) : !NO_RETRY.has(web.failure.kind) ? (
                    <p>
                      <Button onClick={() => onAllowAndOpen()}>Try again</Button>
                    </p>
                  ) : null}
                </InlineNotice>
              ) : null}
            </>
          )}
        </section>
      ) : null}

      {copies}
    </main>
  );
}
