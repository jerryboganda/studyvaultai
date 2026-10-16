import { FolderInput, Tag } from 'lucide-react';
import type { FilingSuggestion } from '@shared';
import { Button, InlineNotice, useAction } from '@ui';

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
  const tags = suggestion.addTagIds.length;
  return (
    <div className="hl-suggest" data-testid="card-suggestion">
      <p className="hl-suggest__what" dir="auto">
        <FolderInput aria-hidden="true" strokeWidth={2.4} />
        <span>
          File in <strong>{place}</strong>?
        </span>
        {tags > 0 ? (
          <span className="hl-chip">
            <Tag aria-hidden="true" strokeWidth={2.4} />+{tags}
            <span className="sv-sr"> {tags === 1 ? 'tag' : 'tags'}</span>
          </span>
        ) : null}
      </p>
      <p className="hl-suggest__rule" dir="auto">
        Rule: {suggestion.ruleName}
      </p>
      <div className="sv-row">
        <Button
          variant="primary"
          busy={file.busy}
          disabledReason={dismiss.busy ? 'Dismissing the suggestion.' : undefined}
          onClick={() => void file.run()}
          data-testid="suggestion-file"
          aria-label={`File in ${suggestion.bankName}`}
        >
          File
        </Button>
        <Button
          variant="ghost"
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
