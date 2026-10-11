import { useId } from 'react';
import {
  DEFAULT_PALETTE,
  HIGHLIGHT_KINDS,
  KIND_LABELS,
  MAX_COMMENT_CHARS,
  StudyVaultError,
  type HighlightKind,
} from '@shared';
import type { HighlightDetail } from '@storage';
import {
  Button,
  InlineNotice,
  KindChip,
  ResolveBadge,
  describeResolveState,
  errorMessage,
  safeHref,
  useAction,
  useToast,
} from '@ui';
import { useApi } from './api';
import { describeCaptureMethod, formatDateTime, timeZoneName } from './format';
import { useAutosave, useBump, useVaultQuery } from './hooks';
import { sourceTarget } from './links';
import { PreviewNotes } from './PreviewNotes';
import { PreviewDuplicates, PreviewFields, PreviewLocations, PreviewTags } from './PreviewMeta';

export interface PreviewProps {
  /** Highlight to show; null shows the empty state. */
  id: string | null;
  paletteFor?(kind: HighlightKind): string;
  /** Narrow the list to this source. */
  onFilterSource(source: { id: string; label: string }): void;
  onShow(highlightId: string): void;
  onReviewDuplicates(highlightId: string): void;
  /** The highlight went to the trash (or was purged): the owner clears its selection. */
  onGone?(): void;
}

/** Right pane: provenance first, then everything the user can change. */
export function Preview(props: PreviewProps) {
  const { id } = props;
  const api = useApi();
  const detail = useVaultQuery(
    async () => (id === null ? null : await api.getHighlightDetail(id)),
    [id],
  );

  if (id === null) {
    return (
      <div className="dash-preview dash-preview--empty" data-testid="preview-empty">
        <h2>Preview</h2>
        <p className="sv-muted">
          Choose a highlight to see its exact quote, where it came from, its notes and tags.
        </p>
      </div>
    );
  }
  if (detail.loading) {
    return (
      <div className="dash-preview" role="status" data-testid="preview-loading">
        <p className="sv-muted">Loading…</p>
      </div>
    );
  }
  if (detail.error || !detail.data) {
    const gone = detail.error?.toLowerCase().includes('not found') ?? false;
    return (
      <div className="dash-preview" data-testid="preview-error">
        <InlineNotice
          tone={gone ? 'warning' : 'error'}
          title={gone ? 'This highlight is no longer here' : 'Could not open this highlight'}
          action={gone ? undefined : <Button onClick={detail.refresh}>Try again</Button>}
        >
          {gone
            ? 'It may have been moved to the trash or deleted from another window. Restore it from the Trash view if you need it.'
            : detail.error}
        </InlineNotice>
      </div>
    );
  }
  return <PreviewBody key={id} detail={detail.data} {...props} />;
}

function PreviewBody({
  detail,
  paletteFor,
  onFilterSource,
  onShow,
  onReviewDuplicates,
  onGone,
}: PreviewProps & { detail: HighlightDetail }) {
  const api = useApi();
  const bump = useBump();
  const toast = useToast();
  const uid = useId();
  const { highlight, source } = detail;
  const state = describeResolveState(highlight.resolveStatus);
  const pageNumber = highlight.anchorSet.type === 'pdf' ? highlight.anchorSet.pageNumber : null;
  const target = sourceTarget({
    highlightId: highlight.id,
    quote: highlight.exactQuote,
    source,
    pageNumber,
  });
  const address = safeHref(detail.capturedUrl ?? source.originalUrl);

  const comment = useAutosave(highlight.userComment, async (text) => {
    await api.updateHighlight(highlight.id, { userComment: text });
    bump();
  });

  const update = useAction(async (patch: { kind?: HighlightKind; priority?: number }) => {
    const next: Parameters<typeof api.updateHighlight>[1] = {};
    if (patch.kind) {
      next.kind = patch.kind;
      // The colour follows the kind, as in the side panel, so painting keeps its meaning.
      next.color = (paletteFor?.(patch.kind) ?? DEFAULT_PALETTE[patch.kind]) as never;
    }
    if (patch.priority) next.priority = patch.priority as 1 | 2 | 3 | 4 | 5;
    await api.updateHighlight(highlight.id, next);
    bump();
  });

  const trash = async () => {
    try {
      await api.softDeleteHighlight(highlight.id);
      bump();
      onGone?.();
      toast.push({
        message: 'Moved the highlight to the trash.',
        action: {
          label: 'Undo',
          onClick: () => {
            void api.restoreHighlight(highlight.id).then(
              () => bump(),
              (err: unknown) =>
                toast.push({ tone: 'error', message: errorMessage(err, 'Could not restore.') }),
            );
          },
        },
      });
    } catch (err) {
      const gone = err instanceof StudyVaultError && err.code === 'not_found';
      toast.push({
        tone: 'error',
        message: gone
          ? 'It was already removed.'
          : errorMessage(err, 'Could not move it to the trash.'),
      });
    }
  };

  return (
    <div className="dash-preview" data-testid="preview" data-highlight-id={highlight.id}>
      <header className="sv-stack sv-stack--tight">
        <div className="sv-row">
          <KindChip kind={highlight.kind} color={highlight.color} />
          <ResolveBadge status={highlight.resolveStatus} />
          <span className="sv-small">Priority {highlight.priority}</span>
        </div>
        <h2 className="sv-wrap" dir="auto">
          {source.title || source.host || 'Untitled source'}
        </h2>
      </header>

      <section className="dash-section" aria-labelledby={`${uid}-quote`}>
        <h3 id={`${uid}-quote`}>
          Original quote{' '}
          <span className="sv-muted sv-small">(saved as captured; cannot be edited)</span>
        </h3>
        <blockquote className="sv-quote" dir="auto" data-testid="preview-quote">
          {highlight.exactQuote}
        </blockquote>
        {state.attention && state.explanation ? (
          <p className="sv-small sv-muted">{state.explanation}</p>
        ) : null}
        <div className="sv-row">
          {target.kind === 'none' ? (
            <p className="sv-small sv-muted" data-testid="source-unavailable">
              {target.reason}
            </p>
          ) : (
            <a
              className="sv-btn sv-btn--primary"
              href={target.href}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="open-source"
            >
              {target.label}
            </a>
          )}
          <Button
            onClick={() => onFilterSource({ id: source.id, label: source.title || source.host })}
            data-testid="filter-source"
          >
            Only this source
          </Button>
        </div>
        {target.kind === 'web' ? (
          <p className="sv-small sv-muted">
            Chrome scrolls to the passage using the page’s own text. If the page changed or needs
            sign-in, it opens at the top.
          </p>
        ) : null}
      </section>

      <section
        className="dash-section"
        aria-labelledby={`${uid}-prov`}
        data-testid="preview-provenance"
      >
        <h3 id={`${uid}-prov`}>Provenance</h3>
        <dl className="dash-dl">
          <dt>Source</dt>
          <dd className="sv-wrap" dir="auto">
            {source.title || '—'} <span className="sv-muted">({source.host || 'no host'})</span>
          </dd>
          <dt>Address</dt>
          <dd className="sv-wrap">
            {address ? (
              <a href={address} target="_blank" rel="noopener noreferrer">
                {detail.capturedUrl ?? source.originalUrl}
              </a>
            ) : (
              <span className="sv-muted">No reachable address</span>
            )}
          </dd>
          <dt>Captured</dt>
          <dd>
            {formatDateTime(highlight.capturedAt)}{' '}
            <span className="sv-muted sv-small">({timeZoneName()})</span>
          </dd>
          <dt>Captured with</dt>
          <dd>{describeCaptureMethod(detail.captureMethod)}</dd>
          {highlight.headingContext ? (
            <>
              <dt>Under</dt>
              <dd className="sv-wrap" dir="auto">
                {highlight.headingContext}
              </dd>
            </>
          ) : null}
          {pageNumber ? (
            <>
              <dt>PDF page</dt>
              <dd>{pageNumber}</dd>
            </>
          ) : null}
          <dt>Page status</dt>
          <dd>
            {state.label}
            {highlight.resolveConfidence !== null
              ? ` · confidence ${Math.round(highlight.resolveConfidence * 100)}%`
              : ''}
          </dd>
        </dl>
      </section>

      <PreviewLocations detail={detail} />

      <section className="dash-section" aria-labelledby={`${uid}-edit`}>
        <h3 id={`${uid}-edit`}>Classification</h3>
        <div className="sv-row">
          <div className="sv-field dash-grow">
            <label className="sv-label" htmlFor={`${uid}-kind`}>
              Kind
            </label>
            <select
              id={`${uid}-kind`}
              className="sv-control"
              value={highlight.kind}
              data-testid="preview-kind"
              onChange={(e) => void update.run({ kind: e.target.value as HighlightKind })}
            >
              {HIGHLIGHT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {`${KIND_LABELS[k].glyph} ${KIND_LABELS[k].label}`}
                </option>
              ))}
            </select>
          </div>
          <div className="sv-field">
            <label className="sv-label" htmlFor={`${uid}-priority`}>
              Priority
            </label>
            <select
              id={`${uid}-priority`}
              className="sv-control"
              value={highlight.priority}
              data-testid="preview-priority"
              onChange={(e) => void update.run({ priority: Number(e.target.value) })}
            >
              <option value={1}>1 (lowest)</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
              <option value={4}>4</option>
              <option value={5}>5 (highest)</option>
            </select>
          </div>
        </div>
        {update.error ? (
          <InlineNotice tone="error" title="Not saved">
            {update.error}
          </InlineNotice>
        ) : null}
        <div className="sv-field">
          <label className="sv-label" htmlFor={`${uid}-comment`}>
            Your comment (short, saved with the highlight)
          </label>
          <textarea
            id={`${uid}-comment`}
            className="sv-control"
            rows={3}
            maxLength={MAX_COMMENT_CHARS}
            dir="auto"
            value={comment.draft}
            onChange={(e) => comment.onChange(e.target.value)}
            onBlur={comment.flush}
            data-testid="preview-comment"
          />
          <p className="sv-small sv-muted" role="status">
            {comment.status.kind === 'saving'
              ? 'Saving…'
              : comment.status.kind === 'saved'
                ? 'Saved'
                : comment.status.kind === 'dirty'
                  ? 'Unsaved changes (saved automatically)'
                  : comment.status.kind === 'error'
                    ? `Not saved: ${comment.status.message}`
                    : ''}
          </p>
        </div>
      </section>

      <PreviewTags detail={detail} />
      <PreviewFields detail={detail} />
      <PreviewNotes highlightId={highlight.id} notes={detail.notes} />
      <PreviewDuplicates
        detail={detail}
        onOpen={onShow}
        onReview={() => onReviewDuplicates(highlight.id)}
      />

      <section className="dash-section">
        <Button variant="danger" onClick={() => void trash()} data-testid="preview-trash">
          Move to trash
        </Button>
      </section>
    </div>
  );
}
