import { useId, useRef, useState, type ReactNode } from 'react';
import { Check, FileUp, Globe, Laptop, Link2, RotateCcw, X } from 'lucide-react';
import { parseSrc, type FetchFailure, type SrcCheck } from '@pdf';
import {
  BarMeter,
  Button,
  ChoiceCards,
  ChunkyButton,
  IconButton,
  InfoTip,
  InlineNotice,
  Stepper,
  VaultBuddy,
} from '@ui';

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

/**
 * `fetch` follows a redirect on its own and shows no hop, so the other site may have been sent the
 * request before StudyVault could look at where it ended (THREAT_MODEL R19, PRIVACY_CLAIMS P1d).
 */
const REDIRECTED =
  'The address redirected to another site, and your browser may already have sent that site the request: the steps in between cannot be seen. That request carries your IP address but no cookies and no referrer, and StudyVault did not use anything the site returned.';

/** What the person can do about each way a web PDF can fail (never "try to get around it"). */
function advice(f: FetchFailure): string {
  switch (f.kind) {
    case 'sign-in':
    case 'redirected-non-pdf':
      return 'StudyVault does not use your browser sign-ins to fetch files. Open the link in your browser, sign in, download the PDF, then choose the downloaded file below.';
    case 'redirect-blocked':
      return `${REDIRECTED} Open the link in your browser, sign in if it asks, download the PDF, then choose the downloaded file below.`;
    case 'redirect-needs-access':
      return `${REDIRECTED} You can allow that site for this download only, or download the PDF in your browser and choose it below.`;
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

const LINK_STEPS = ['Paste the link', 'Allow access', 'Download'];

type Via = 'computer' | 'link';

/**
 * The open screen: the mascot, one choice (from this computer or from a web address), the stored
 * copies. A chosen or dropped file is read on this device; an address is fetched only after the
 * person allows that one site (the same steps as `?src=`).
 */
export function OpenPanel({
  src,
  web,
  fileError,
  notice,
  onFile,
  onOpenLink,
  onClearLink,
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
  /** A typed address that passed the same checks as `?src=`. Absent: no address field. */
  onOpenLink?(check: SrcCheck): void;
  /** Back to the address field from an address in progress. */
  onClearLink?(): void;
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
  const [via, setVia] = useState<Via>(src ? 'link' : 'computer');
  const headingId = useId();

  return (
    <main className="sv-open" data-testid="pdf-open">
      <section className="sv-open__hero" aria-labelledby={headingId}>
        <VaultBuddy pose="think" size={120} />
        <div className="sv-open__intro">
          <h1 id={headingId}>Open a PDF</h1>
          <p className="sv-open__line">
            Highlight, note and search it here.{' '}
            <InfoTip label="About opening PDFs" align="start">
              A file you choose is read on this device and StudyVault does not upload it. A web
              address is fetched from that site only after you allow it. With sync on, a PDF&rsquo;s
              details and recognised text sync as Settings describes.
            </InfoTip>
          </p>
        </div>
      </section>

      {notice}

      <ChoiceCards<Via>
        label="Where is the PDF?"
        columns={2}
        value={via}
        onChange={setVia}
        className="sv-open__choice"
        options={[
          { value: 'computer', label: 'From computer', hint: 'Choose or drop', icon: Laptop },
          { value: 'link', label: 'From a link', hint: 'Web address', icon: Link2, tone: 'violet' },
        ]}
      />

      {/* Always mounted: the e2e and the drop target use it whichever card is chosen. */}
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

      {via === 'computer' ? (
        <section className="sv-dropzone" aria-label="From your computer">
          <span className="sv-tile sv-tile--lg sv-art--primary" aria-hidden="true">
            <FileUp strokeWidth={2.4} />
          </span>
          <p className="sv-dropzone__title">Drop a PDF here</p>
          <ChunkyButton
            variant="primary"
            size="lg"
            icon={FileUp}
            onClick={() => input.current?.click()}
            data-testid="pdf-choose-file"
          >
            Choose a PDF
          </ChunkyButton>
        </section>
      ) : (
        <LinkPanel
          src={src}
          web={web}
          onOpenLink={onOpenLink}
          onClearLink={onClearLink}
          onAllowAndOpen={onAllowAndOpen}
          onChooseFile={() => input.current?.click()}
        />
      )}

      {fileError ? (
        <InlineNotice tone="error" title="That file could not be opened">
          {fileError}
        </InlineNotice>
      ) : null}

      {copies}

      <p className="sv-open__foot" data-testid="pdf-builtin-note">
        Chrome&rsquo;s built-in viewer{' '}
        <InfoTip label="About Chrome's built-in PDF viewer" side="top" align="start">
          When Chrome opens a PDF in its built-in PDF viewer, extensions cannot read or mark that
          page, so StudyVault does not try. Right-click the link (or the page) and choose{' '}
          <strong>Open in StudyVault reader</strong>, or choose the downloaded file here.
        </InfoTip>
      </p>
    </main>
  );
}

function LinkPanel({
  src,
  web,
  onOpenLink,
  onClearLink,
  onAllowAndOpen,
  onChooseFile,
}: {
  src: SrcCheck | null;
  web: WebState;
  onOpenLink?(check: SrcCheck): void;
  onClearLink?(): void;
  onAllowAndOpen(extra?: string[]): void;
  onChooseFile(): void;
}) {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const uid = useId();
  /** A redirect that ended on a site the person has not allowed: ask for exactly that one. */
  const redirectTo = web.t === 'failed' ? web.failure.redirectTo : undefined;
  const step = !src?.ok ? 0 : web.t === 'need-permission' || web.t === 'denied' ? 1 : 2;

  const submit = (): void => {
    const check = parseSrc(typed.trim());
    if (!check) {
      setError('Type the address of a PDF.');
      field.current?.focus();
      return;
    }
    if (!check.ok) {
      setError(check.message);
      field.current?.focus();
      return;
    }
    setError(null);
    onOpenLink?.(check);
  };

  return (
    <section className="sv-linkcard" aria-labelledby={`${uid}-title`} data-testid="pdf-web">
      {/* The step's name is the card's title: what to do now, in one glance. */}
      <h2 id={`${uid}-title`} className="sv-linkcard__title">
        {LINK_STEPS[step]}
      </h2>
      <Stepper steps={LINK_STEPS} current={step} label="Open from a link" />

      {src && !src.ok ? (
        <InlineNotice tone="error" title="This address cannot be opened">
          {src.message}
        </InlineNotice>
      ) : null}

      {!src?.ok ? (
        onOpenLink ? (
          <form
            className="sv-linkform"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <label className="sv-label" htmlFor={`${uid}-url`}>
              Web address
            </label>
            <div className="sv-linkform__row">
              <input
                ref={field}
                id={`${uid}-url`}
                className="sv-control sv-grow"
                type="url"
                inputMode="url"
                autoComplete="url"
                spellCheck={false}
                dir="ltr"
                placeholder="https://"
                value={typed}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? `${uid}-err` : undefined}
                data-testid="pdf-link-input"
                onChange={(e) => setTyped(e.target.value)}
              />
              <ChunkyButton variant="primary" type="submit" data-testid="pdf-link-open">
                Next
              </ChunkyButton>
            </div>
            {error ? (
              <p id={`${uid}-err`} className="sv-fielderror" role="alert">
                {error}
              </p>
            ) : null}
          </form>
        ) : null
      ) : (
        <>
          <div className="sv-linkcard__address">
            <span className="sv-tile sv-art--violet" aria-hidden="true">
              <Globe strokeWidth={2.4} />
            </span>
            <span className="sv-linkcard__where">
              <strong>{src.host}</strong>
              <span className="sv-wrap sv-small sv-muted" dir="ltr">
                <span className="sv-sr">Address: </span>
                {src.url}
              </span>
            </span>
            {onClearLink ? (
              <IconButton
                icon={X}
                label={web.t === 'fetching' ? 'Stop download' : 'Change address'}
                tipSide="left"
                onClick={onClearLink}
              />
            ) : null}
          </div>

          {web.t === 'need-permission' || web.t === 'denied' ? (
            <>
              <p className="sv-linkcard__ask">
                Allow StudyVault to contact <strong>{src.host}</strong> for this file.{' '}
                <InfoTip label="About site access" align="start">
                  To download this file, StudyVault needs your permission to contact {src.host}. It
                  is used only to fetch this PDF: StudyVault does not read other pages on that site,
                  does not send your cookies or sign-ins, and sends nothing anywhere else.
                </InfoTip>
              </p>
              {web.t === 'denied' ? (
                <InlineNotice tone="warning" title="Access was not granted">
                  You can choose a downloaded copy instead.
                </InlineNotice>
              ) : null}
              <div className="sv-row">
                <ChunkyButton
                  variant="primary"
                  icon={Check}
                  onClick={() => onAllowAndOpen()}
                  data-testid="pdf-allow-open"
                >
                  Allow and open
                </ChunkyButton>
              </div>
            </>
          ) : null}

          {web.t === 'fetching' ? (
            <div className="sv-linkcard__progress">
              <p role="status" data-testid="pdf-fetching">
                Downloading from {src.host}…{' '}
                {web.total ? `${mb(web.loaded)} of ${mb(web.total)}` : mb(web.loaded)}
              </p>
              {web.total ? (
                <BarMeter
                  value={web.loaded}
                  max={web.total}
                  label="Download progress"
                  valueText={`${mb(web.loaded)} of ${mb(web.total)}`}
                />
              ) : null}
            </div>
          ) : null}

          {web.t === 'failed' ? (
            <InlineNotice
              tone="error"
              title="The PDF could not be downloaded"
              action={
                redirectTo ? (
                  <ChunkyButton
                    variant="primary"
                    onClick={() => onAllowAndOpen([redirectTo.pattern])}
                    data-testid="pdf-allow-redirect"
                  >
                    Allow {redirectTo.host}
                  </ChunkyButton>
                ) : !NO_RETRY.has(web.failure.kind) ? (
                  <Button onClick={() => onAllowAndOpen()}>
                    <RotateCcw aria-hidden="true" />
                    Try again
                  </Button>
                ) : undefined
              }
            >
              <p>{web.failure.message}</p>
              <p className="sv-small">{advice(web.failure)}</p>
            </InlineNotice>
          ) : null}
        </>
      )}

      {/* The way round every web failure: the file downloaded in the browser. */}
      <p className="sv-linkcard__fallback">
        <span className="sv-muted">Have the file?</span>
        <Button variant="ghost" onClick={onChooseFile} data-testid="pdf-choose-file">
          <FileUp aria-hidden="true" />
          Choose a PDF
        </Button>
      </p>
    </section>
  );
}
