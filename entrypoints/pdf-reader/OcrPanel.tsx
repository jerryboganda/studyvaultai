import { Suspense, lazy, useEffect, useId, useRef, useState } from 'react';
import {
  CircleCheck,
  Hourglass,
  Pencil,
  RotateCw,
  ScanText,
  TriangleAlert,
  Undo2,
} from 'lucide-react';
import { Button, ConfirmDialog, InfoTip, InlineNotice, errorMessage, plural } from '@ui';
import {
  BAND_TEXT,
  HIGH_CONFIDENCE,
  MEDIUM_CONFIDENCE,
  ORIENTATION_TEXT,
  confidenceBand,
  correctedLines,
  type PageOcr,
} from './ocrModel';

// The "read again" actions are not needed until a document has recognised text: their own chunk.
const RerunSection = lazy(() =>
  import('./OcrRerunSection').then((m) => ({ default: m.RerunSection })),
);

/** What the reader knows about the text of the page that is in view. */
export type PageTextState = 'embedded' | 'none' | 'ocr' | 'unknown';

/** What the "read again" actions need to know about the whole document. */
export interface RerunInfo {
  /** Pages of the document that have recognised text. */
  recognisedPages: number;
  /** What the person corrected, over the whole document. */
  corrected: { pages: number; lines: number };
  /** Pages that already keep an earlier reading (reading again replaces it). */
  withEarlier: number;
  /** Time one page took in the last run on this device (ms), or null before one was timed. */
  msPerPage: number | null;
  /** Nothing is saved in this window: the new reading lasts this session only. */
  sessionOnly: boolean;
  onRerecognisePage(): void;
  onRerecogniseAll(): void;
  /** Put the page's kept earlier reading back. */
  onRestore(): Promise<void>;
}

export interface OcrPanelProps {
  pageNumber: number;
  state: PageTextState;
  /** The recognised page; present when `state` is 'ocr'. */
  ocr: PageOcr | undefined;
  /** Why recognition cannot run here (shown instead of an enabled button). */
  unavailableReason: string | undefined;
  /** A job is running (any page). */
  busy: boolean;
  onRecognizePage(): void;
  onSetLine(line: number, text: string): Promise<void>;
  onRevertLine(line: number): Promise<void>;
  onRevertPage(): Promise<void>;
  /** Absent: the panel offers no "read again" action. */
  rerun?: RerunInfo;
}

const MACHINE_NOTICE = 'This text is machine-recognised and may be wrong.';

/**
 * "Page text" tab: the recognised text of the page in view, line by line, with confidence shown as
 * words (shading is only a second cue), per-line correction and revert. A correction changes the
 * text used for selection, search and NEW highlights; a highlight saved earlier keeps the exact
 * quote it captured (it may then show as "Source changed").
 */
export function OcrPanel(props: OcrPanelProps) {
  const { pageNumber, state, ocr } = props;
  const [error, setError] = useState<string | null>(null);

  /** Runs a correction; false (and the error shown) when it was not saved. */
  const report = async (work: () => Promise<void>): Promise<boolean> => {
    setError(null);
    try {
      await work();
      return true;
    } catch (err) {
      setError(errorMessage(err, 'The correction could not be saved.'));
      return false;
    }
  };

  return (
    <section
      className="sv-ocrpanel"
      aria-label={`Text of page ${pageNumber}`}
      data-testid="pdf-ocr-panel"
    >
      <h2 className="sv-ocrpanel__title">
        <span className="sv-pill">p. {pageNumber}</span> Page text
        <span className="sv-sr"> of page {pageNumber}</span>
      </h2>

      {state === 'embedded' ? (
        <div className="sv-paneempty">
          <span className="sv-tile sv-tile--lg sv-art--success" aria-hidden="true">
            <CircleCheck strokeWidth={2.4} />
          </span>
          <p className="sv-paneempty__title">Text found</p>
          <p className="sv-muted sv-small">
            This page has its own selectable text: nothing to recognise.
          </p>
        </div>
      ) : null}

      {state === 'unknown' ? (
        <p className="sv-muted" role="status">
          <Hourglass aria-hidden="true" className="sv-inline-icon" /> The page is still being read.
        </p>
      ) : null}

      {state === 'none' ? (
        <div className="sv-paneempty">
          <span className="sv-tile sv-tile--lg sv-art--warning" aria-hidden="true">
            <ScanText strokeWidth={2.4} />
          </span>
          <p className="sv-paneempty__title">
            No text here{' '}
            <InfoTip label="About recognising text">
              This page is a picture of text. Recognising it reads the picture on this device
              (nothing is uploaded) and makes the words selectable, searchable and highlightable.
            </InfoTip>
          </p>
          <Button
            variant="primary"
            onClick={props.onRecognizePage}
            busy={props.busy}
            disabledReason={props.unavailableReason}
            data-testid="pdf-ocr-page"
          >
            <ScanText aria-hidden="true" />
            Recognise page
          </Button>
          {props.unavailableReason ? <p className="sv-small">{props.unavailableReason}</p> : null}
        </div>
      ) : null}

      {state === 'ocr' && ocr ? (
        <RecognisedLines
          ocr={ocr}
          error={error}
          onSetLine={(line, text) => report(() => props.onSetLine(line, text))}
          onRevertLine={(line) => report(() => props.onRevertLine(line))}
          onRevertPage={() => report(() => props.onRevertPage())}
        />
      ) : null}

      {props.rerun && (state === 'ocr' || props.rerun.recognisedPages > 0) ? (
        <Suspense fallback={null}>
          <RerunSection
            pageNumber={pageNumber}
            ocr={state === 'ocr' ? ocr : undefined}
            info={props.rerun}
            busy={props.busy}
            unavailableReason={props.unavailableReason}
          />
        </Suspense>
      ) : null}
    </section>
  );
}

function RecognisedLines({
  ocr,
  error,
  onSetLine,
  onRevertLine,
  onRevertPage,
}: {
  ocr: PageOcr;
  error: string | null;
  onSetLine(line: number, text: string): Promise<boolean>;
  onRevertLine(line: number): Promise<boolean>;
  onRevertPage(): Promise<boolean>;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [confirmRevert, setConfirmRevert] = useState(false);
  const uid = useId();
  // The line's Edit button is replaced by the field: when the field closes, focus goes back to it.
  const editedFrom = useRef<number | null>(null);
  useEffect(() => {
    if (editing !== null || editedFrom.current === null) return;
    document.getElementById(`${uid}-edit-${editedFrom.current}`)?.focus();
    editedFrom.current = null;
  }, [editing, uid]);
  const edited = correctedLines(ocr);
  const changed =
    Object.keys(ocr.corrections.lines).length + Object.keys(ocr.corrections.words).length;
  const lowWords = ocr.page.words.filter((w) => confidenceBand(w.confidence) === 'low').length;

  return (
    <>
      <p className="sv-machine" role="note">
        <TriangleAlert aria-hidden="true" strokeWidth={2.4} />
        <strong>Machine-recognised text</strong>
        <InfoTip label="About recognised text" align="end">
          {MACHINE_NOTICE} Correcting a line changes search, selection and new highlights. A
          highlight saved earlier keeps the words it captured; if it sat on a corrected line it
          shows as &ldquo;Source changed&rdquo;.
        </InfoTip>
      </p>

      {/* Three sample words, short for the eye; the full band wording is in each entry's text. */}
      <dl className="sv-ocr-legend" aria-label="Confidence legend" data-testid="pdf-ocr-legend">
        {(
          [
            [
              'high',
              'High',
              `${HIGH_CONFIDENCE}%+`,
              `High confidence (${HIGH_CONFIDENCE}% and above)`,
            ],
            [
              'medium',
              'Medium',
              `${MEDIUM_CONFIDENCE}-${HIGH_CONFIDENCE - 1}%`,
              `Medium confidence (${MEDIUM_CONFIDENCE}% to ${HIGH_CONFIDENCE - 1}%)`,
            ],
            [
              'low',
              'Low',
              `<${MEDIUM_CONFIDENCE}%`,
              `Low confidence (under ${MEDIUM_CONFIDENCE}%): check these`,
            ],
          ] as const
        ).map(([band, name, range, full]) => (
          <div key={band}>
            <dt>
              <span className="sv-ocr-word" data-band={band}>
                word
              </span>
            </dt>
            <dd>
              <span aria-hidden="true">
                <strong>{name}</strong> {range}
              </span>
              <span className="sv-sr">{full}</span>
            </dd>
          </div>
        ))}
      </dl>

      <p className="sv-ocr-summary" data-testid="pdf-ocr-summary">
        <span className="sv-pill">{plural(ocr.page.lines.length, 'line')}</span>
        <span className="sv-pill">{plural(ocr.page.words.length, 'word')}</span>
        {lowWords > 0 ? (
          <span className="sv-pill sv-pill--warning">
            {plural(lowWords, 'low-confidence word')}
          </span>
        ) : null}
        {changed > 0 ? (
          <span className="sv-pill sv-pill--info">{plural(changed, 'corrected line')}</span>
        ) : null}
      </p>

      {ocr.page.orientation ? (
        <p className="sv-ocr-summary" data-testid="pdf-ocr-orientation">
          <span className="sv-pill">
            <RotateCw aria-hidden="true" strokeWidth={2.4} />
            Turned to read
          </span>
          <InfoTip label="About the turned scan" align="end">
            This scan is stored {ORIENTATION_TEXT[ocr.page.orientation as 90 | 180 | 270]}. It was
            turned to be read; the words sit where they are on the page as it is shown.
          </InfoTip>
        </p>
      ) : null}

      {error ? (
        <InlineNotice tone="error" title="Not saved">
          {error}
        </InlineNotice>
      ) : null}

      {ocr.page.lines.length === 0 ? (
        <p className="sv-muted">No text was recognised on this page.</p>
      ) : (
        <ol className="sv-ocr-lines" data-testid="pdf-ocr-lines">
          {ocr.page.lines.map((line, index) => {
            const isEdited = Object.hasOwn(ocr.corrections.lines, index);
            const current = edited[index] ?? line.text;
            const isEditing = editing === index;
            const band = confidenceBand(line.confidence);
            return (
              <li key={index} className="sv-ocr-line" data-edited={isEdited || undefined}>
                <div className="sv-ocr-line__head">
                  <span className="sv-pill">Line {index + 1}</span>
                  <span className="sv-pill" data-band={band}>
                    {Math.round(line.confidence)}% ({BAND_TEXT[band]})
                  </span>
                  {isEdited ? <span className="sv-pill sv-pill--info">Edited</span> : null}
                </div>

                {isEditing ? (
                  <form
                    className="sv-ocr-edit"
                    onSubmit={(e) => {
                      e.preventDefault();
                      // A failed save keeps the field open with what was typed (the error says why).
                      void onSetLine(index, draft).then((ok) => ok && setEditing(null));
                    }}
                  >
                    <label className="sv-sr" htmlFor={`${uid}-${index}`}>
                      Corrected text of line {index + 1}
                    </label>
                    <input
                      id={`${uid}-${index}`}
                      autoFocus
                      className="sv-control"
                      dir="auto"
                      value={draft}
                      maxLength={2000}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.stopPropagation();
                          setEditing(null);
                        }
                      }}
                      data-testid="pdf-ocr-input"
                    />
                    <div className="sv-row">
                      <Button type="submit" variant="primary" data-testid="pdf-ocr-line-save">
                        Save line
                      </Button>
                      <Button onClick={() => setEditing(null)}>Cancel</Button>
                    </div>
                  </form>
                ) : (
                  <>
                    <p className="sv-ocr-text" dir="auto" data-testid="pdf-ocr-line-text">
                      {isEdited
                        ? current
                        : ocr.page.words.slice(line.first, line.end).map((w, i) => {
                            const wb = confidenceBand(w.confidence);
                            return (
                              <span key={line.first + i}>
                                {i > 0 ? ' ' : ''}
                                <span className="sv-ocr-word" data-band={wb}>
                                  {w.text}
                                  {wb === 'high' ? null : (
                                    <span className="sv-sr"> ({BAND_TEXT[wb]})</span>
                                  )}
                                </span>
                              </span>
                            );
                          })}
                    </p>
                    {isEdited ? (
                      <p className="sv-small sv-muted" data-testid="pdf-ocr-recognised">
                        Recognised: <span dir="auto">{line.text}</span>
                      </p>
                    ) : null}
                    <div className="sv-row">
                      <Button
                        id={`${uid}-edit-${index}`}
                        variant="ghost"
                        onClick={() => {
                          setDraft(current);
                          editedFrom.current = index;
                          setEditing(index);
                        }}
                        data-testid="pdf-ocr-edit"
                      >
                        <Pencil aria-hidden="true" />
                        Edit<span className="sv-sr"> line {index + 1}</span>
                      </Button>
                      {isEdited ? (
                        <Button
                          variant="ghost"
                          onClick={() => void onRevertLine(index)}
                          data-testid="pdf-ocr-revert-line"
                        >
                          <Undo2 aria-hidden="true" />
                          Revert<span className="sv-sr"> line {index + 1}</span>
                        </Button>
                      ) : null}
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ol>
      )}

      <Button
        variant="danger"
        onClick={() => setConfirmRevert(true)}
        disabledReason={changed === 0 ? 'No corrections on this page to revert.' : undefined}
        data-testid="pdf-ocr-revert-page"
      >
        <Undo2 aria-hidden="true" />
        Revert all edits
      </Button>
      {confirmRevert ? (
        <ConfirmDialog
          title="Revert all edits?"
          confirmLabel="Revert all"
          danger
          onCancel={() => setConfirmRevert(false)}
          onConfirm={() => {
            setConfirmRevert(false);
            void onRevertPage();
          }}
        >
          <p>
            Every correction on this page goes back to the recognised text (
            {plural(changed, 'corrected line')}).
          </p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
