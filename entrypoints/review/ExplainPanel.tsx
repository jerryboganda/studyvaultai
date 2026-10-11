import type { VerificationStatus } from '@study';
import type { CardSourceContext } from '@storage';
import { Badge, InlineNotice, type Tone } from '@ui';
import { TID } from '@ui/review';

export const VERIFICATION_LABEL: Record<VerificationStatus, { label: string; tone: Tone }> = {
  not_checked: { label: 'Not checked', tone: 'neutral' },
  source_supported: { label: 'Supported by a source you linked', tone: 'info' },
  conflicting: { label: 'Conflicting evidence', tone: 'warning' },
  externally_verified: { label: 'Verified by you against an outside source', tone: 'success' },
};

/**
 * Why the answer is the answer: the card's own explanation, the saved source quote (immutable,
 * shown verbatim) and the learner's own note, kept visibly separate. Nothing here is generated.
 */
export function ExplainPanel({
  context,
  explanation,
}: {
  context: CardSourceContext;
  explanation?: string | undefined;
}) {
  const kp = context.knowledgePoint;
  const hasNote = context.userComment.trim() !== '' || context.notes.length > 0;
  return (
    <section
      className="rv-explain sv-stack"
      aria-label="Explanation"
      data-testid={TID.explainPanel}
    >
      {explanation ? (
        <div>
          <h3>Explanation</h3>
          <p className="rv-prewrap">{explanation}</p>
        </div>
      ) : null}

      <div>
        <h3>Source quote</h3>
        {context.quote ? (
          <>
            <blockquote className="sv-quote" data-testid={TID.explainQuote}>
              {context.quote}
            </blockquote>
            <p className="sv-small sv-muted">
              {context.source
                ? `From ${context.source.title || context.source.host}${
                    context.source.pageNumber ? `, page ${context.source.pageNumber}` : ''
                  }${context.headingContext ? `, under "${context.headingContext}"` : ''}.`
                : null}{' '}
              {context.quoteIsSnapshot
                ? 'The original highlight was deleted; this is the copy kept on the card.'
                : 'Exactly as you saved it.'}
            </p>
          </>
        ) : (
          <p className="sv-muted">
            This card is not linked to a highlight, so there is no source quote to show.
          </p>
        )}
      </div>

      {hasNote ? (
        <div data-testid={TID.explainNote}>
          <h3>Your note</h3>
          {context.userComment.trim() !== '' ? (
            <p className="rv-prewrap">{context.userComment}</p>
          ) : null}
          {context.notes.map((n) => (
            <div key={n.id} className="rv-note">
              {n.title ? <p className="sv-label">{n.title}</p> : null}
              <p className="rv-prewrap">{n.body}</p>
            </div>
          ))}
        </div>
      ) : null}

      {kp ? (
        <div>
          <h3>Knowledge point</h3>
          <p>{kp.shortOneLiner}</p>
          {kp.examPearl ? (
            <p>
              <span className="sv-label">Exam pearl: </span>
              {kp.examPearl}
            </p>
          ) : null}
          {kp.misconception ? (
            <p>
              <span className="sv-label">Common misconception: </span>
              {kp.misconception}
            </p>
          ) : null}
          <p className="sv-row">
            <Badge tone={VERIFICATION_LABEL[kp.verificationStatus].tone}>
              {VERIFICATION_LABEL[kp.verificationStatus].label}
            </Badge>
            {kp.createdBy === 'ai' ? <Badge tone="warning">AI-made, unverified</Badge> : null}
          </p>
        </div>
      ) : null}

      {!context.quote && !explanation && !hasNote && !kp ? (
        <InlineNotice tone="info">
          Nothing more is saved for this card. Add an explanation by editing it (E).
        </InlineNotice>
      ) : null}
    </section>
  );
}
