import { useId, useState } from 'react';
import { History, RefreshCcw } from 'lucide-react';
import { Button, ConfirmDialog, InfoTip, InlineNotice, errorMessage, plural } from '@ui';
import { estimateRerun, type PageOcr } from './ocrModel';
import type { RerunInfo } from './OcrPanel';

/**
 * Reading recognised pages again. Both actions ask first (what it costs, what stays until the new
 * reading succeeds, what happens to corrections and highlights); the one step back is a button of its
 * own with a status line, because it changes the page's text without a dialog.
 *
 * Its own module so the reader's first chunk does not carry its sentences: `OcrPanel` loads it when
 * the "Page text" tab shows a document that has recognised text.
 */
export function RerunSection({
  pageNumber,
  ocr,
  info,
  busy,
  unavailableReason,
}: {
  pageNumber: number;
  ocr: PageOcr | undefined;
  info: RerunInfo;
  busy: boolean;
  unavailableReason: string | undefined;
}) {
  const [asking, setAsking] = useState<'page' | 'all' | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();
  const corrected = ocr ? Object.keys(ocr.corrections.lines).length : 0;
  const nothing = info.recognisedPages === 0 && !ocr;
  if (nothing) return null;

  const restore = async (): Promise<void> => {
    setError(null);
    setStatus(null);
    try {
      await info.onRestore();
      setStatus(`Restored the earlier reading of page ${pageNumber}.`);
    } catch (err) {
      setError(errorMessage(err, 'The earlier reading could not be restored.'));
    }
  };
  const when = ocr?.previous ? new Date(ocr.previous.replacedAt).toLocaleString() : null;

  return (
    <section
      className="sv-ocr-rerun sv-stack sv-stack--tight"
      aria-labelledby={headingId}
      data-testid="pdf-ocr-rerun"
    >
      <h3 id={headingId} className="sv-ocr-rerun__title">
        <RefreshCcw aria-hidden="true" strokeWidth={2.4} />
        Read again
        <InfoTip label="About reading again" align="end">
          Reads pages again on this device. A page&rsquo;s text is replaced only when the new
          reading has succeeded, and the reading it replaces is kept for one step back.
        </InfoTip>
      </h3>

      {ocr ? (
        <>
          <div className="sv-row">
            <Button
              onClick={() => setAsking('page')}
              busy={busy}
              disabledReason={unavailableReason}
              data-testid="pdf-ocr-rerun-page"
            >
              <RefreshCcw aria-hidden="true" />
              Re-recognise this page
            </Button>
          </div>
          {ocr.previous ? (
            <div className="sv-stack sv-stack--tight">
              <p className="sv-small" data-testid="pdf-ocr-previous">
                An earlier reading of this page is kept (replaced {when}).{' '}
                <InfoTip label="About the earlier reading" align="end">
                  Restoring it brings back its text and the corrections it had; the reading you have
                  now is kept in its place.
                </InfoTip>
              </p>
              <div className="sv-row">
                <Button onClick={() => void restore()} busy={busy} data-testid="pdf-ocr-restore">
                  <History aria-hidden="true" />
                  Restore previous
                </Button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {info.recognisedPages > 0 ? (
        <div className="sv-stack sv-stack--tight">
          <p>
            <span className="sv-pill">{plural(info.recognisedPages, 'page')} recognised</span>
          </p>
          <div className="sv-row">
            <Button
              onClick={() => setAsking('all')}
              busy={busy}
              disabledReason={unavailableReason}
              data-testid="pdf-ocr-rerun-all"
            >
              <RefreshCcw aria-hidden="true" />
              Re-recognise all pages
            </Button>
          </div>
        </div>
      ) : null}

      {unavailableReason ? <p className="sv-small">{unavailableReason}</p> : null}
      {error ? (
        <InlineNotice tone="error" title="Not restored">
          {error}
        </InlineNotice>
      ) : null}
      <p className="sv-small" role="status" data-testid="pdf-ocr-restore-status">
        {status}
      </p>

      {asking === 'page' ? (
        <ConfirmDialog
          title={`Read page ${pageNumber} again?`}
          confirmLabel={`Re-recognise page ${pageNumber}`}
          onCancel={() => setAsking(null)}
          onConfirm={() => {
            setAsking(null);
            info.onRerecognisePage();
          }}
        >
          <p data-testid="pdf-ocr-rerun-estimate">
            The page is read again on this device: nothing is uploaded and it works offline.{' '}
            {estimateRerun(1, info.msPerPage).text}
          </p>
          <p>
            Its current text stays until the new reading has succeeded and is then replaced in one
            step. If the page cannot be read, nothing changes.
          </p>
          {corrected > 0 ? (
            <p data-testid="pdf-ocr-rerun-corrections">
              You corrected {plural(corrected, 'line')} on this page. A correction is kept when the
              new reading has a line in the same place. One that finds no matching line is dropped
              and listed afterwards; the reading it replaces still has it.
            </p>
          ) : null}
          {ocr?.previous ? (
            <p data-testid="pdf-ocr-rerun-earlier">
              This page already keeps an earlier reading. Reading it again replaces that one with
              the reading you have now: only one step back is kept.
            </p>
          ) : null}
          <p>
            Highlights on this page are looked for again in the new text. One that cannot be placed
            stays in your list and is not painted; its quote and notes do not change.
          </p>
          {info.sessionOnly ? (
            <p>
              Nothing is saved in this window: the new reading lasts this session only and the saved
              text does not change.
            </p>
          ) : null}
        </ConfirmDialog>
      ) : null}

      {asking === 'all' ? (
        <ConfirmDialog
          title={`Read all ${plural(info.recognisedPages, 'recognised page')} again?`}
          confirmLabel="Re-recognise all pages"
          onCancel={() => setAsking(null)}
          onConfirm={() => {
            setAsking(null);
            info.onRerecogniseAll();
          }}
        >
          <p data-testid="pdf-ocr-rerun-estimate">
            Every page that has recognised text is read again on this device, one after another:
            nothing is uploaded and it works offline.{' '}
            {estimateRerun(info.recognisedPages, info.msPerPage).text}
          </p>
          <p>
            Each page keeps its current text until its new reading has succeeded, and is then
            replaced. You can cancel at any time: pages not reached keep their text, and so do pages
            that cannot be read.
          </p>
          {info.corrected.lines > 0 ? (
            <p data-testid="pdf-ocr-rerun-corrections">
              You corrected {plural(info.corrected.lines, 'line')} on{' '}
              {plural(info.corrected.pages, 'page')}. A correction is kept when the new reading has
              a line in the same place. One that finds no matching line is dropped and listed
              afterwards; the reading it replaces still has it.
            </p>
          ) : null}
          {info.withEarlier > 0 ? (
            <p data-testid="pdf-ocr-rerun-earlier">
              {plural(info.withEarlier, 'page')} already {info.withEarlier === 1 ? 'keeps' : 'keep'}{' '}
              an earlier reading. Reading again replaces it with the reading you have now: only one
              step back is kept.
            </p>
          ) : null}
          <p>
            Highlights are looked for again in the new text. One that cannot be placed stays in your
            list and is not painted; its quote and notes do not change.
          </p>
          {info.sessionOnly ? (
            <p>
              Nothing is saved in this window: the new readings last this session only and the saved
              text does not change.
            </p>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
