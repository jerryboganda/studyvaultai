import type { FilingSuggestion } from '@shared';
import { Badge, Button, InlineNotice, useAction } from '@ui';

/**
 * A filing rule's pending suggestion on the highlight's card (docs/adr/017-filing-rules.md): the
 * same offer the page toast made, kept here until it is filed or dismissed. Nothing happens until
 * the person presses File; the rule, bank and folder it names are written out, never implied.
 */
export function FilingChip({
  suggestion,
  onFile,
  onDismiss,
}: {
  suggestion: FilingSuggestion;
  onFile(): Promise<void>;
  onDismiss(): Promise<void>;
}) {
  const file = useAction(onFile);
  const dismiss = useAction(onDismiss);
  const busy = file.busy || dismiss.busy;
  const place =
    suggestion.folderName === null
      ? suggestion.bankName
      : `${suggestion.bankName} / ${suggestion.folderName}`;
  return (
    <div className="sv-stack sv-stack--tight hl-suggest" data-testid="card-suggestion">
      <div className="sv-row">
        <Badge tone="info">Suggestion</Badge>
        <span className="sv-small sv-wrap" dir="auto">
          Rule “{suggestion.ruleName}” suggests filing this in <strong>{place}</strong>
          {suggestion.addTagIds.length > 0
            ? ` and adding ${suggestion.addTagIds.length} ${suggestion.addTagIds.length === 1 ? 'tag' : 'tags'}`
            : ''}
          .
        </span>
      </div>
      <div className="sv-row">
        <Button
          variant="primary"
          busy={file.busy}
          disabledReason={dismiss.busy ? 'Dismissing the suggestion.' : undefined}
          onClick={() => void file.run()}
          data-testid="suggestion-file"
        >
          File in {suggestion.bankName}
        </Button>
        <Button
          busy={dismiss.busy}
          disabledReason={file.busy ? 'Filing the highlight.' : undefined}
          onClick={() => void dismiss.run()}
          data-testid="suggestion-dismiss"
        >
          Not now
        </Button>
      </div>
      {file.error || dismiss.error ? (
        <InlineNotice
          tone="error"
          title="That did not work"
          action={
            !busy && (file.retryable || dismiss.retryable) ? (
              <Button onClick={file.error ? file.retry : dismiss.retry}>Retry</Button>
            ) : undefined
          }
        >
          {file.error ?? dismiss.error}
        </InlineNotice>
      ) : null}
    </div>
  );
}
