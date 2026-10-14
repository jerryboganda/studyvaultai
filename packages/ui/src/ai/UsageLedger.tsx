import './ai.css';
import { useState } from 'react';
import { ChartColumn, Coins, Layers, Trash2, Zap } from 'lucide-react';
import { clearAiData, countAiResults, getAiBudget, getAiSettings } from '@storage';
import { Button } from '../Button';
import { ConfirmDialog } from '../ConfirmDialog';
import { BarMeter } from '../design/BarMeter';
import { useAction, useAsync, useDataEpoch } from '../hooks';
import { InlineNotice } from '../Notice';

const usd = (n: number) => `$${n.toFixed(n < 0.01 && n > 0 ? 4 : 2)}`;

/**
 * Today's requests, tokens and estimated cost from the persisted ledger (bars against the daily
 * limits), and "Delete all AI data". The cost is StudyVault's estimate from the pricing you entered;
 * your provider's bill is the authority.
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
  if (!load.data) return <p className="sd-line">Reading the AI ledger…</p>;
  const { settings, budget, results } = load.data;
  const { maxRequestsPerDay, maxCostUsdPerDay } = settings.limits;
  return (
    <section className="ai-block" data-testid="ai-ledger" aria-label="AI usage today">
      <h4 className="ai-block__title">
        <ChartColumn aria-hidden="true" strokeWidth={2.4} />
        Usage today <span className="sd-line">(UTC day {budget.day})</span>
      </h4>
      <dl className="ai-ledger">
        <div className="ai-ledger__row">
          <dt>
            <Zap aria-hidden="true" strokeWidth={2.4} /> Requests
          </dt>
          <dd>
            <BarMeter
              value={budget.requests}
              max={maxRequestsPerDay}
              label="Requests today"
              valueText={`${budget.requests} of ${maxRequestsPerDay}`}
              tone={budget.requests >= maxRequestsPerDay ? 'sun' : 'violet'}
            />
            <span data-testid="ai-ledger-requests">
              {budget.requests} of {maxRequestsPerDay}
            </span>
          </dd>
        </div>
        <div className="ai-ledger__row">
          <dt>
            <Coins aria-hidden="true" strokeWidth={2.4} /> Estimated cost
          </dt>
          <dd>
            {settings.pricing && maxCostUsdPerDay !== null && maxCostUsdPerDay > 0 ? (
              <BarMeter
                value={budget.costUsd}
                max={maxCostUsdPerDay}
                label="Estimated cost today"
                valueText={`${usd(budget.costUsd)} of ${usd(maxCostUsdPerDay)}`}
                tone={budget.costUsd >= maxCostUsdPerDay ? 'sun' : 'violet'}
              />
            ) : null}
            <span data-testid="ai-ledger-cost">
              {settings.pricing
                ? `${usd(budget.costUsd)}${maxCostUsdPerDay === null ? '' : ` of ${usd(maxCostUsdPerDay)}`}`
                : 'Unknown: add pricing above to estimate cost.'}
            </span>
          </dd>
        </div>
        <div className="ai-ledger__row">
          <dt>
            <ChartColumn aria-hidden="true" strokeWidth={2.4} /> Tokens
          </dt>
          <dd data-testid="ai-ledger-tokens">
            {budget.inputTokens} in, {budget.outputTokens} out
          </dd>
        </div>
        <div className="ai-ledger__row">
          <dt>
            <Layers aria-hidden="true" strokeWidth={2.4} /> Drafts on this device
          </dt>
          <dd>{results}</dd>
        </div>
      </dl>
      <p className="sd-line">Tokens as the provider reports them, else estimated.</p>
      <div className="sd-row">
        <Button
          variant="danger"
          data-testid="ai-delete-all"
          busy={wipe.busy}
          onClick={() => setAsking(true)}
        >
          <Trash2 aria-hidden="true" className="ai-inline-icon" /> Delete all AI data…
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
