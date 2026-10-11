import './ai.css';
import { useState } from 'react';
import { clearAiData, countAiResults, getAiBudget, getAiSettings } from '@storage';
import { Button } from '../Button';
import { ConfirmDialog } from '../ConfirmDialog';
import { useAction, useAsync, useDataEpoch } from '../hooks';
import { InlineNotice } from '../Notice';

const usd = (n: number) => `$${n.toFixed(n < 0.01 && n > 0 ? 4 : 2)}`;

/**
 * Today's requests, tokens and estimated cost from the persisted ledger, and "Delete all AI data".
 * The cost is StudyVault's estimate from the pricing you entered; your provider's bill is the
 * authority.
 */
export function UsageLedger({ onDeleted }: { onDeleted?: () => void }) {
  const epoch = useDataEpoch();
  const [asking, setAsking] = useState(false);
  const load = useAsync(
    async () => ({
      settings: await getAiSettings(),
      budget: await getAiBudget(),
      results: await countAiResults(),
    }),
    [],
    [epoch],
  );
  const wipe = useAction(async () => {
    await clearAiData();
    onDeleted?.();
  });

  if (load.error) {
    return (
      <InlineNotice tone="error" title="Could not read the AI ledger">
        {load.error}
      </InlineNotice>
    );
  }
  if (!load.data) return <p className="sv-muted">Reading the AI ledger…</p>;
  const { settings, budget, results } = load.data;
  const { maxRequestsPerDay, maxCostUsdPerDay } = settings.limits;
  return (
    <section
      className="sv-stack sv-stack--tight"
      data-testid="ai-ledger"
      aria-label="AI usage today"
    >
      <h3>AI usage today (UTC day {budget.day})</h3>
      <dl className="sv-stack sv-stack--tight">
        <div>
          <dt className="sv-muted sv-small">Requests</dt>
          <dd data-testid="ai-ledger-requests">
            {budget.requests} of {maxRequestsPerDay}
          </dd>
        </div>
        <div>
          <dt className="sv-muted sv-small">
            Tokens (as reported by the provider, else estimated)
          </dt>
          <dd data-testid="ai-ledger-tokens">
            {budget.inputTokens} in, {budget.outputTokens} out
          </dd>
        </div>
        <div>
          <dt className="sv-muted sv-small">Estimated cost</dt>
          <dd data-testid="ai-ledger-cost">
            {settings.pricing
              ? `${usd(budget.costUsd)}${maxCostUsdPerDay === null ? '' : ` of ${usd(maxCostUsdPerDay)}`}`
              : 'Unknown: add pricing in the settings above to estimate cost.'}
          </dd>
        </div>
        <div>
          <dt className="sv-muted sv-small">AI drafts stored on this device</dt>
          <dd>{results}</dd>
        </div>
      </dl>
      <div>
        <Button
          variant="danger"
          data-testid="ai-delete-all"
          busy={wipe.busy}
          onClick={() => setAsking(true)}
        >
          Delete all AI data…
        </Button>
      </div>
      {wipe.error ? (
        <InlineNotice tone="error" title="AI data was not deleted">
          {wipe.error}
        </InlineNotice>
      ) : null}
      {asking ? (
        <ConfirmDialog
          title="Delete all AI data?"
          confirmLabel="Delete AI data"
          danger
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false);
            void wipe.run();
          }}
        >
          <p>
            This removes every stored AI draft, today&apos;s usage ledger, the AI settings and your
            saved API key from this device.
          </p>
          <p>
            Notes, flashcards and knowledge points you already accepted stay in your vault and stay
            marked as AI-generated.
          </p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
