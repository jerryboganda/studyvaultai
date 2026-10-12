import './ai.css';
import { useState } from 'react';
import type { AiTaskKind } from '@ai';
import type { StoredAiResult } from '@storage';
import { Button } from '../Button';
import { InlineNotice } from '../Notice';
import { AiResultsList } from './AiResultsList';
import { ConsentPreviewDialog, type AiHighlightInput } from './ConsentPreviewDialog';
import { useAiConfig, useAiFlag } from './hooks';
import { AI_ACTION_KINDS, AI_KIND_INFO } from './labels';
import { routeFor } from './runtime';

export interface HighlightAiActionsProps {
  /** The highlights the actions apply to (their saved quotes are the only text that can be sent). */
  highlights: readonly AiHighlightInput[];
  /** List the stored AI drafts of these highlights under the buttons. Default true. */
  showResults?: boolean;
  /** A result was produced and stored. */
  onResult?: (result: StoredAiResult) => void;
  /** Shows an "Open AI settings" button when AI is off or not set up. */
  onOpenSettings?: () => void;
}

const MAX = 50;

/**
 * AI actions for the given highlights. Everything is opt-in: with the feature flag off the buttons
 * are disabled with the reason and nothing is read from any provider. Each action opens the
 * consent preview; nothing is sent before "Send" is pressed there.
 */
export function HighlightAiActions({
  highlights,
  showResults = true,
  onResult,
  onOpenSettings,
}: HighlightAiActionsProps) {
  const flag = useAiFlag();
  const cfg = useAiConfig(flag.on);
  const [open, setOpen] = useState<AiTaskKind | null>(null);
  const ids = highlights.map((h) => h.id);

  const reasonFor = (kind: AiTaskKind): string | undefined => {
    const info = AI_KIND_INFO[kind];
    if (!flag.known) return 'Reading your settings…';
    if (!flag.on) return 'AI features are off. Turn them on in the AI settings.';
    if (highlights.length < info.min) {
      return `Select at least ${info.min} highlight${info.min === 1 ? '' : 's'} first.`;
    }
    if (highlights.length > MAX) return `Select at most ${MAX} highlights.`;
    if (!cfg.data) return 'Reading the AI settings…';
    // The provider this task starts with (the primary one unless the settings route it elsewhere).
    const first = routeFor(cfg.data, kind).first;
    if (first.problem) {
      return first.id === cfg.data.profiles[0]?.id
        ? first.problem
        : `${first.label}: ${first.problem}`;
    }
    return undefined;
  };

  const problem = flag.on ? (cfg.data?.problem ?? null) : null;

  return (
    <section className="sv-stack sv-stack--tight" aria-label="AI drafts" data-testid="ai-actions">
      <h3>AI drafts (optional)</h3>
      {flag.known && !flag.on ? (
        <InlineNotice
          tone="info"
          action={
            onOpenSettings ? <Button onClick={onOpenSettings}>Open AI settings</Button> : undefined
          }
        >
          AI is off, so nothing is ever sent from StudyVault. Turn it on in the AI settings if you
          want drafts such as exam pearls, flashcards and summaries.
        </InlineNotice>
      ) : null}
      {problem ? (
        <InlineNotice
          tone="warning"
          action={
            onOpenSettings ? <Button onClick={onOpenSettings}>Open AI settings</Button> : undefined
          }
        >
          {problem}
        </InlineNotice>
      ) : null}
      {flag.error ? (
        <InlineNotice tone="error" title="Could not read your settings">
          {flag.error}
        </InlineNotice>
      ) : null}
      <div className="sv-row sv-wrap">
        {AI_ACTION_KINDS.map((kind) => {
          const reason = reasonFor(kind);
          return (
            <Button
              key={kind}
              data-testid={`ai-action-${kind}`}
              title={reason ?? AI_KIND_INFO[kind].hint}
              {...(reason ? { disabledReason: reason } : {})}
              onClick={() => setOpen(kind)}
            >
              {AI_KIND_INFO[kind].label}
            </Button>
          );
        })}
      </div>
      <p className="sv-muted sv-small">
        You see the exact text first. Nothing is sent until you press Send in the preview.
      </p>
      {open && cfg.data ? (
        <ConsentPreviewDialog
          kind={open}
          highlights={highlights}
          config={cfg.data}
          onClose={() => setOpen(null)}
          {...(onResult ? { onResult } : {})}
        />
      ) : null}
      {showResults && ids.length > 0 ? <AiResultsList highlightIds={ids} /> : null}
    </section>
  );
}
