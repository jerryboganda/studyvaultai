import { useState } from 'react';
import { createRelation, type AiSourceRef } from '@storage';
import { Button } from '../Button';
import { useAction } from '../hooks';
import { InlineNotice } from '../Notice';
import { truncate } from '../text';

/** Written on the link, so the origin is never mistaken for the person's own finding. */
export const CONTRADICTION_LINK_NOTE = 'Reported by an AI contradiction check; not verified.';

/**
 * One reported contradiction as a link the person can keep (ADR-018). It stores a plain
 * "contradicts" link between the two saved passages and nothing the model wrote except that the
 * check reported the pair; the explanation stays in the AI result. Offered only when both passages
 * still exist, are different, and the model's quotes were matched to them.
 */
export function LinkContradiction({
  a,
  b,
  grounded,
}: {
  a: AiSourceRef | undefined;
  b: AiSourceRef | undefined;
  /** Both quotes were found in the passages they cite. */
  grounded: boolean;
}) {
  const [done, setDone] = useState<'created' | 'existing' | null>(null);
  const link = useAction(async () => {
    if (!a || !b) return;
    const made = await createRelation({
      fromKind: a.kind,
      fromId: a.id,
      toKind: b.kind,
      toId: b.id,
      type: 'contradicts',
      note: CONTRADICTION_LINK_NOTE,
    });
    setDone(made.status === 'existing' ? 'existing' : 'created');
  });

  if (!grounded || !a || !b || a.deleted || b.deleted) return null;
  if (a.kind === b.kind && a.id === b.id) return null;

  return (
    <div className="sv-stack sv-stack--tight" data-testid="ai-link-contradiction">
      {done ? (
        <p className="sv-small" role="status">
          {done === 'existing'
            ? 'These two passages were already linked as Contradicts.'
            : 'Linked as Contradicts. Find it under Links on either highlight, where you can also remove it.'}
        </p>
      ) : (
        <>
          <div>
            <Button
              busy={link.busy}
              aria-label={`Link these two passages as Contradicts: ${truncate(a.text, 40)} and ${truncate(b.text, 40)}`}
              data-testid="ai-link-contradiction-button"
              onClick={() => void link.run()}
            >
              Link as Contradicts
            </Button>
          </div>
          <p className="sv-small sv-muted">
            Adds a link of your own between the two saved passages. The model&apos;s explanation is
            not stored with it.
          </p>
        </>
      )}
      {link.error ? (
        <InlineNotice tone="error" title="The link was not added">
          {link.error}
        </InlineNotice>
      ) : null}
    </div>
  );
}
