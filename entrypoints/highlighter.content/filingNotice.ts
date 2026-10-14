import { filingMessage, type CaptureResult, type FilingOutcome } from '@shared';
import type { CaptureHost } from './contract';

/**
 * The toasts that tell a person what an auto-filing rule did or offers (docs/adr/017-filing-rules.md).
 * Plain functions over a notice shape, no framework: both the toolbar overlay and the controller
 * (keyboard shortcut, context menu) show them, each through its own toast channel.
 */

export interface FilingNotice {
  text: string;
  tone: 'info' | 'success' | 'error';
  action?: { label: string; run: () => void };
  secondary?: { label: string; run: () => void };
  /** Overrides how long the notice stays (ms). Only the toolbar overlay uses it. */
  ttl?: number;
  /** XP the save earned (CaptureResult.xp); the overlay shows it as a chip. */
  xp?: number;
}

export type FilingOps = Pick<CaptureHost, 'acceptFiling' | 'dismissFiling' | 'undoFiling'>;

/** A suggestion is a decision to read, not a confirmation to glance at: it stays longer than Undo. */
export const SUGGESTION_MS = 12_000;

const failure = (err: unknown, fallback: string): FilingNotice => ({
  text: err instanceof Error && err.message.trim() !== '' ? err.message : fallback,
  tone: 'error',
});

/** What `filing.accept` or the first reply says, as a notice (with Undo when something was filed). */
function outcomeNotice(
  outcome: FilingOutcome,
  ops: FilingOps,
  highlightId: string,
  push: (notice: FilingNotice) => void,
): FilingNotice | null {
  switch (outcome.status) {
    case 'filed':
      return {
        text: filingMessage(outcome),
        tone: 'success',
        action: {
          label: 'Undo',
          run: () => {
            ops.undoFiling(highlightId).then(
              (done) =>
                push({
                  text: done.restored
                    ? 'Filing undone. The highlight is back where it was.'
                    : (done.reason ?? 'Nothing was undone.'),
                  tone: 'info',
                }),
              (err: unknown) => push(failure(err, 'Could not undo the filing.')),
            );
          },
        },
      };
    case 'suggested':
      return {
        text: filingMessage(outcome),
        tone: 'info',
        ttl: SUGGESTION_MS,
        action: {
          label: 'File',
          run: () => {
            ops.acceptFiling(highlightId).then(
              (done) => {
                const next = outcomeNotice(done, ops, highlightId, push);
                if (next) push(next);
              },
              (err: unknown) => push(failure(err, 'Could not file the highlight.')),
            );
          },
        },
        secondary: {
          label: 'Not now',
          run: () => {
            ops
              .dismissFiling(highlightId)
              .catch((err: unknown) => push(failure(err, 'Could not dismiss the suggestion.')));
          },
        },
      };
    case 'unavailable':
      return {
        text: filingMessage(outcome),
        tone: 'info',
      };
  }
}

/**
 * Shows the result of a save and of the rules that ran after it. A highlight a rule filed is in a
 * different bank than `saved` says, so that toast gives way to "Filed in ..."; a suggestion or a
 * notice is shown after the "Saved to ..." toast, the newest being the one the keyboard reaches.
 */
export function pushSaved(
  result: Pick<CaptureResult, 'highlight' | 'filing'>,
  saved: FilingNotice,
  ops: FilingOps,
  push: (notice: FilingNotice) => void,
): void {
  const filing = result.filing
    ? outcomeNotice(result.filing, ops, result.highlight.id, push)
    : null;
  const withTtl = (n: FilingNotice): FilingNotice => ({ ...n, ttl: n.ttl ?? saved.ttl });
  if (filing && result.filing?.status === 'filed') {
    // "Filed in ..." stands in for "Saved to ...", so it carries the save's XP.
    push(saved.xp ? { ...withTtl(filing), xp: saved.xp } : withTtl(filing));
    return;
  }
  push(saved);
  if (filing) push(withTtl(filing));
}
