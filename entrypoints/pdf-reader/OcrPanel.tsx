import { useEffect, useId, useRef, useState } from 'react';
import { Button, InlineNotice, errorMessage, plural } from '@ui';
import {
  BAND_TEXT,
  HIGH_CONFIDENCE,
  MEDIUM_CONFIDENCE,
  ORIENTATION_TEXT,
  confidenceBand,
  correctedLines,
  type PageOcr,
} from './ocrModel';

/** What the reader knows about the text of the page that is in view. */
export type PageTextState = 'embedded' | 'none' | 'ocr' | 'unknown';

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

  const report = async (work: () => Promise<void>): Promise<void> => {
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(errorMessage(err, 'The correction could not be saved.'));
    }
  };

  return (
    <section
      className="sv-ocrpanel"
      aria-label={`Text of page ${pageNumber}`}
      data-testid="pdf-ocr-panel"
    >
      <h2>Text of page {pageNumber}</h2>

      {state === 'embedded' ? (
        <p className="sv-muted">
          This page has its own selectable text, so there is nothing to recognise on it.
        </p>
      ) : null}

      {state === 'unknown' ? <p className="sv-muted">The page is still being read.</p> : null}

      {state === 'none' ? (
        <>
          <p>
            This page has no selectable text: it is a picture of text. Recognising it reads the
            picture on this device (nothing is uploaded) and makes the words selectable, searchable
            and highlightable.
          </p>
          <Button
            variant="primary"
            onClick={props.onRecognizePage}
            busy={props.busy}
            disabledReason={props.unavailableReason}
            data-testid="pdf-ocr-page"
          >
            OCR this page
          </Button>
          {props.unavailableReason ? <p className="sv-small">{props.unavailableReason}</p> : null}
        </>
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
  onSetLine(line: number, text: string): Promise<void>;
  onRevertLine(line: number): Promise<void>;
  onRevertPage(): Promise<void>;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
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
      <InlineNotice tone="warning" title="Machine-recognised text">
        <p>
          {MACHINE_NOTICE} Correcting a line changes search, selection and highlights you make
          afterwards. A highlight you saved earlier keeps the exact words it captured; if it sat on
          a line you corrected, it is listed as &ldquo;Source changed&rdquo;.
        </p>
      </InlineNotice>

      <dl className="sv-ocr-legend" aria-label="Confidence legend" data-testid="pdf-ocr-legend">
        <div>
          <dt>
            <span className="sv-ocr-word" data-band="high">
              word
            </span>
          </dt>
          <dd>High confidence ({HIGH_CONFIDENCE}% and above): no mark.</dd>
        </div>
        <div>
          <dt>
            <span className="sv-ocr-word" data-band="medium">
              word
            </span>
          </dt>
          <dd>
            Medium confidence ({MEDIUM_CONFIDENCE}% to {HIGH_CONFIDENCE - 1}%): shaded.
          </dd>
        </div>
        <div>
          <dt>
            <span className="sv-ocr-word" data-band="low">
              word
            </span>
          </dt>
          <dd>Low confidence (under {MEDIUM_CONFIDENCE}%): shaded and underlined. Check these.</dd>
        </div>
      </dl>

      <p className="sv-small" data-testid="pdf-ocr-summary">
        {plural(ocr.page.lines.length, 'line')}, {plural(ocr.page.words.length, 'word')} ·{' '}
        {lowWords === 0 ? 'no low-confidence words' : `${plural(lowWords, 'low-confidence word')}`}
        {' · '}
        {changed === 0 ? 'no corrections' : plural(changed, 'corrected line')}
      </p>

      {ocr.page.orientation ? (
        <p className="sv-small" data-testid="pdf-ocr-orientation">
          This scan is stored {ORIENTATION_TEXT[ocr.page.orientation as 90 | 180 | 270]}. It was
          turned to be read; the words sit where they are on the page as it is shown.
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
            return (
              <li key={index} className="sv-ocr-line" data-edited={isEdited || undefined}>
                <div className="sv-row">
                  <span className="sv-badge">Line {index + 1}</span>
                  <span className="sv-small sv-muted">
                    {Math.round(line.confidence)}% ({BAND_TEXT[confidenceBand(line.confidence)]})
                  </span>
                  {isEdited ? <span className="sv-badge sv-badge--info">Edited</span> : null}
                </div>

                {isEditing ? (
                  <form
                    className="sv-ocr-edit"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void onSetLine(index, draft).then(() => setEditing(null));
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
                            const band = confidenceBand(w.confidence);
                            return (
                              <span key={line.first + i}>
                                {i > 0 ? ' ' : ''}
                                <span className="sv-ocr-word" data-band={band}>
                                  {w.text}
                                  {band === 'high' ? null : (
                                    <span className="sv-sr"> ({BAND_TEXT[band]})</span>
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
                        onClick={() => {
                          setDraft(current);
                          editedFrom.current = index;
                          setEditing(index);
                        }}
                        data-testid="pdf-ocr-edit"
                      >
                        Edit line {index + 1}
                      </Button>
                      {isEdited ? (
                        <Button
                          onClick={() => void onRevertLine(index)}
                          data-testid="pdf-ocr-revert-line"
                        >
                          Revert line {index + 1}
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
        onClick={() => void onRevertPage()}
        disabledReason={changed === 0 ? 'No corrections on this page to revert.' : undefined}
        data-testid="pdf-ocr-revert-page"
      >
        Revert all corrections on this page
      </Button>
    </>
  );
}
