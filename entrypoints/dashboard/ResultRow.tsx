import { DEFAULT_PALETTE, type ColorId } from '@shared';
import type { Segment, SearchField } from '@search';
import { Badge, KindChip, ResolveBadge } from '@ui';
import { formatDate } from './format';
import type { ResultRow } from './results';

/** Matched words are real <mark> elements built from text segments: stored text is never markup. */
export function Segments({ segments }: { segments: readonly Segment[] }) {
  return (
    <>
      {segments.map((s, i) =>
        s.match ? (
          <mark key={i} className="dash-mark">
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

const FIELD_LABELS: Record<SearchField, string> = {
  quote: 'quote',
  comment: 'your note',
  tags: 'tag',
  title: 'page title',
  headingContext: 'heading',
  banks: 'bank',
  folderPath: 'folder',
  host: 'site',
};

/** One row of the centre list. Presentational only: an option may not contain controls. */
export function ResultRowView({ row }: { row: ResultRow }) {
  const color: ColorId | null = row.kind ? (row.color ?? DEFAULT_PALETTE[row.kind]) : null;
  const attention = row.resolveStatus === 'ambiguous' || row.resolveStatus === 'orphaned';
  const quoteIsEmpty = row.segments.every((s) => s.text === '');
  const lead = quoteIsEmpty && row.matchNote ? row.matchNote.segments : row.segments;

  return (
    <div className="rrow" data-testid="result-row" data-highlight-id={row.highlightId ?? undefined}>
      <span className="rrow__check" aria-hidden="true" data-check="">
        ✓
      </span>
      <div className="rrow__main">
        <div className="rrow__top">
          {row.kind && color ? <KindChip kind={row.kind} color={color} /> : <Badge>Note</Badge>}
          {row.priority ? <span className="sv-small">P{row.priority}</span> : null}
          {attention && row.resolveStatus ? <ResolveBadge status={row.resolveStatus} /> : null}
          {row.docType === 'note' && row.kind ? <Badge glyph="✎">Matched a note</Badge> : null}
          {row.hasNote && row.docType !== 'note' ? (
            <span className="sv-small sv-muted">Has note</span>
          ) : null}
          {row.pageNumber ? <span className="sv-small sv-muted">p. {row.pageNumber}</span> : null}
        </div>
        <p className="rrow__quote" dir="auto">
          <Segments segments={lead} />
        </p>
        {row.matchNote && !quoteIsEmpty ? (
          <p className="rrow__match sv-small" dir="auto">
            <span className="sv-muted">In {FIELD_LABELS[row.matchNote.field]}: </span>
            <Segments segments={row.matchNote.segments} />
          </p>
        ) : null}
        <p className="rrow__meta sv-small sv-muted" dir="auto">
          {[row.title || row.host, row.banks.join(', '), formatDate(row.updatedAt)]
            .filter((x) => x !== '')
            .join(' · ')}
        </p>
      </div>
    </div>
  );
}
