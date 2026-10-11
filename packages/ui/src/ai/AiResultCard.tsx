import './ai.css';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { CLINICAL_NOTICE, VERIFICATION_LABELS, type VerificationState } from '@ai';
import {
  acceptAiItem,
  aiItemPaths,
  deleteAiResult,
  discardAiItems,
  getAiResult,
  listAiDeckChoices,
  resolveAiSources,
  type AiSourceRef,
  type StoredAiResult,
} from '@storage';
import { Badge, type Tone } from '../Badge';
import { Button } from '../Button';
import { ConfirmDialog } from '../ConfirmDialog';
import { useAction, useAsync, useDataEpoch } from '../hooks';
import { InlineNotice } from '../Notice';
import { buildAccept, initialDraft, type AiDraft } from './accept';
import { AI_KIND_INFO } from './labels';
import { LinkContradiction } from './LinkContradiction';

const NEW_DECK = '__new__';
const EMPTY_SOURCES: ReadonlyMap<string, AiSourceRef> = new Map();

const STATE_TONE: Record<VerificationState, { tone: Tone; glyph: string }> = {
  unverified: { tone: 'warning', glyph: '?' },
  source_supported: { tone: 'info', glyph: '✓' },
  conflicting: { tone: 'danger', glyph: '≠' },
  unsupported: { tone: 'danger', glyph: '!' },
};

const REASONS: Record<string, string> = {
  unknown_id: 'it names a passage that was not sent',
  quote_not_found: 'the quoted text is not in the cited passage',
  quote_too_short: 'the quote is too short to verify',
  not_a_candidate: 'the pair was not one of the pairs offered to the model',
};

// ---------------------------------------------------------------------------------------------
// Citations: always the vault's immutable text, never what the model wrote
// ---------------------------------------------------------------------------------------------

function Cite({
  result,
  sources,
  path,
  quoteId,
}: {
  result: StoredAiResult;
  sources: ReadonlyMap<string, AiSourceRef>;
  /** JSON pointer of the quoted text inside `output` (key of the grounding report). */
  path: string;
  quoteId: string;
}) {
  const claim = result.grounding.claims.find((c) => c.path === path);
  if (!claim?.supported) {
    return (
      <p className="ai-flag" data-testid="ai-unsupported">
        <strong>Unsupported citation.</strong> The model&apos;s quote could not be matched:{' '}
        {REASONS[claim?.reason ?? ''] ?? 'it could not be verified'}. It is not shown, and it is not
        evidence.
      </p>
    );
  }
  const ref = sources.get(quoteId);
  if (!ref || ref.deleted) {
    return (
      <p className="sv-muted sv-small" data-testid="ai-citation-missing">
        The cited {ref?.kind ?? 'passage'} is no longer in your vault.
      </p>
    );
  }
  return (
    <figure className="ai-cite" data-testid="ai-citation">
      <blockquote className="sv-quote">{ref.text}</blockquote>
      <figcaption className="sv-muted sv-small">
        Your saved {ref.kind}
        {ref.sourceTitle ? ` from ${ref.sourceTitle}` : ''}
        {ref.host ? ` (${ref.host})` : ''}
      </figcaption>
    </figure>
  );
}

function Cites({
  result,
  sources,
  base,
  evidence,
}: {
  result: StoredAiResult;
  sources: ReadonlyMap<string, AiSourceRef>;
  base: string;
  evidence: readonly { quoteId: string }[];
}) {
  return (
    <>
      {evidence.map((e, i) => (
        <Cite
          key={`${base}/${i}`}
          result={result}
          sources={sources}
          path={`${base}/${i}/text`}
          quoteId={e.quoteId}
        />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Output bodies (every model string is a React text node)
// ---------------------------------------------------------------------------------------------

function Plain({ children }: { children: ReactNode }) {
  return <p className="ai-pre">{children}</p>;
}

function Output({
  result,
  sources,
  item,
}: {
  result: StoredAiResult;
  sources: ReadonlyMap<string, AiSourceRef>;
  /** Wraps each independently reviewable card (flashcards only). */
  item: (path: string, body: ReactNode) => ReactNode;
}) {
  const c = { result, sources };
  switch (result.kind) {
    case 'exam_pearl':
      return (
        <>
          <Plain>
            <strong>{result.output.oneLiner}</strong>
          </Plain>
          <Plain>{result.output.why}</Plain>
          <Cite {...c} path="/sourceQuote" quoteId={result.output.sourceQuoteId} />
        </>
      );
    case 'summary':
      return (
        <>
          <Plain>{result.output.summary}</Plain>
          <ul>
            {result.output.keyPoints.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
          <Cites {...c} base="/evidence" evidence={result.output.evidence} />
        </>
      );
    case 'structured_notes':
      return (
        <>
          <h4>{result.output.title}</h4>
          {result.output.sections.map((s, i) => (
            <section key={i} className="sv-stack sv-stack--tight">
              <h5>{s.heading}</h5>
              <ul>
                {s.bullets.map((b, j) => (
                  <li key={j}>
                    {b.text}
                    <Cites
                      {...c}
                      base={`/sections/${i}/bullets/${j}/evidence`}
                      evidence={b.evidence}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      );
    case 'flashcards':
      return (
        <ul className="ai-list">
          {result.output.cards.map((card, i) =>
            item(
              `/cards/${i}`,
              <>
                <Badge>{card.type === 'basic' ? 'Basic card' : 'Cloze card'}</Badge>
                {card.type === 'basic' ? (
                  <>
                    <Plain>
                      <strong>Front:</strong> {card.front}
                    </Plain>
                    <Plain>
                      <strong>Back:</strong> {card.back}
                    </Plain>
                  </>
                ) : (
                  <>
                    <Plain>{card.text}</Plain>
                    {card.extra ? <Plain>{card.extra}</Plain> : null}
                  </>
                )}
                <Cites {...c} base={`/cards/${i}/evidence`} evidence={card.evidence} />
              </>,
            ),
          )}
        </ul>
      );
    case 'mcq': {
      const o = result.output;
      return (
        <>
          <Plain>{o.stem}</Plain>
          <ol type="A">
            {o.choices.map((ch) => (
              <li key={ch.id}>
                {ch.text}
                {ch.id === o.keyChoiceId ? (
                  <>
                    {' '}
                    <Badge tone="warning">Proposed key (unverified)</Badge>
                  </>
                ) : null}
              </li>
            ))}
          </ol>
          <Plain>{o.explanation}</Plain>
          {o.requiresHumanVerification ? (
            <InlineNotice tone="warning">
              Requires human verification: check the key and the wording before you rely on it.
            </InlineNotice>
          ) : null}
          <Cites {...c} base="/evidence" evidence={o.evidence} />
        </>
      );
    }
    case 'explain':
      return (
        <>
          {result.question ? (
            <Plain>
              <strong>Question:</strong> {result.question}
            </Plain>
          ) : null}
          <Badge tone={result.output.answerState === 'answered' ? 'info' : 'warning'}>
            {result.output.answerState.replace(/_/g, ' ')}
          </Badge>
          <Plain>{result.output.answer}</Plain>
          {result.output.uncertainty ? (
            <Plain>
              <strong>Not settled by your sources:</strong> {result.output.uncertainty}
            </Plain>
          ) : null}
          <Cites {...c} base="/evidence" evidence={result.output.evidence} />
        </>
      );
    case 'compare_topics':
      return (
        <>
          {result.output.rows.map((row, i) => (
            <section key={i} className="sv-stack sv-stack--tight">
              <h5>{row.aspect}</h5>
              <ul>
                {row.cells.map((cell, j) => (
                  <li key={j}>
                    <strong>{cell.topic}:</strong> {cell.text}
                    <Cites
                      {...c}
                      base={`/rows/${i}/cells/${j}/evidence`}
                      evidence={cell.evidence}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      );
    case 'contradictions':
      return (
        <>
          <p className="sv-muted">
            {result.output.candidateCount} candidate pair
            {result.output.candidateCount === 1 ? '' : 's'} judged;{' '}
            {result.output.contradictions.length} reported.
          </p>
          {result.output.contradictions.map((x, i) => (
            <section key={i} className="sv-stack sv-stack--tight">
              <Plain>{x.explanation}</Plain>
              <Cite {...c} path={`/contradictions/${i}/a/text`} quoteId={x.a.quoteId} />
              <Cite {...c} path={`/contradictions/${i}/b/text`} quoteId={x.b.quoteId} />
              <LinkContradiction
                a={sources.get(x.a.quoteId)}
                b={sources.get(x.b.quoteId)}
                grounded={['a', 'b'].every(
                  (end) =>
                    result.grounding.claims.find(
                      (claim) => claim.path === `/contradictions/${i}/${end}/text`,
                    )?.supported === true,
                )}
              />
            </section>
          ))}
        </>
      );
    case 'fact_check':
      return (
        <>
          {result.output.checks.map((chk, i) => (
            <section key={chk.claimId} className="sv-stack sv-stack--tight">
              <Plain>
                <strong>{chk.claim}</strong>
              </Plain>
              <Badge tone={chk.label === 'conflicting' ? 'danger' : 'neutral'}>
                {chk.label.replace(/_/g, ' ')}
              </Badge>
              <Plain>{chk.explanation}</Plain>
              <Cites {...c} base={`/checks/${i}/evidence`} evidence={chk.evidence} />
            </section>
          ))}
        </>
      );
    case 'mnemonic':
      return (
        <>
          {result.output.aids.map((aid, i) => (
            <section key={i} className="sv-stack sv-stack--tight" data-testid="ai-aid">
              {/* The quote the aid is anchored to comes first: it is the fact, the aid is not. */}
              <Cites {...c} base={`/aids/${i}/evidence`} evidence={aid.evidence} />
              <div className="sv-row sv-wrap">
                <Badge tone="warning" glyph="?">
                  Memory aid, not a fact
                </Badge>
                <Badge>{aid.type}</Badge>
              </div>
              <Plain>
                <strong>{aid.mnemonic}</strong>
              </Plain>
              <Plain>{aid.howItWorks}</Plain>
              <p className="sv-muted sv-small">Anchored to: {aid.fact}</p>
            </section>
          ))}
        </>
      );
    case 'short_viva':
      return (
        <ol className="ai-list">
          {result.output.questions.map((q, i) => (
            <li key={i} className="ai-item" data-testid="ai-viva-question">
              <Plain>
                <strong>Question {i + 1}:</strong> {q.question}
              </Plain>
              <Plain>
                <strong>Model answer (a draft to check):</strong> {q.modelAnswer}
              </Plain>
              <Cites {...c} base={`/questions/${i}/evidence`} evidence={q.evidence} />
            </li>
          ))}
        </ol>
      );
    case 'study_outline':
      return (
        <>
          <h4>{result.output.title}</h4>
          <ul className="ai-list" data-testid="ai-outline">
            {result.output.items.map((it, i) => (
              <li key={i} className={`ai-outline ai-outline--l${it.level}`} data-level={it.level}>
                {it.text}
                <Cites {...c} base={`/items/${i}/evidence`} evidence={it.evidence} />
              </li>
            ))}
          </ul>
        </>
      );
  }
}

// ---------------------------------------------------------------------------------------------
// Review controls for one item
// ---------------------------------------------------------------------------------------------

function TextField({
  label,
  value,
  onChange,
  rows,
}: {
  label: string;
  value: string;
  onChange(next: string): void;
  rows?: number;
}) {
  const id = useId();
  return (
    <div className="sv-field">
      <label className="sv-label" htmlFor={id}>
        {label}
      </label>
      {rows ? (
        <textarea
          id={id}
          className="sv-control"
          rows={rows}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          id={id}
          className="sv-control"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}

function DraftFields({ draft, onChange }: { draft: AiDraft; onChange(next: AiDraft): void }) {
  const keyId = useId();
  switch (draft.type) {
    case 'pearl':
      return (
        <>
          <TextField
            label="One-line statement"
            value={draft.oneLiner}
            onChange={(oneLiner) => onChange({ ...draft, oneLiner })}
          />
          <TextField
            label="Why it matters"
            rows={3}
            value={draft.why}
            onChange={(why) => onChange({ ...draft, why })}
          />
        </>
      );
    case 'note':
      return (
        <>
          <TextField
            label="Note title"
            value={draft.title}
            onChange={(title) => onChange({ ...draft, title })}
          />
          <TextField
            label="Note text (Markdown)"
            rows={10}
            value={draft.body}
            onChange={(body) => onChange({ ...draft, body })}
          />
        </>
      );
    case 'basic':
      return (
        <>
          <TextField
            label="Front"
            rows={2}
            value={draft.front}
            onChange={(front) => onChange({ ...draft, front })}
          />
          <TextField
            label="Back"
            rows={2}
            value={draft.back}
            onChange={(back) => onChange({ ...draft, back })}
          />
        </>
      );
    case 'cloze':
      return (
        <>
          <TextField
            label="Cloze text, deletions as {{c1::answer}}"
            rows={3}
            value={draft.text}
            onChange={(text) => onChange({ ...draft, text })}
          />
          <TextField
            label="Extra (optional)"
            value={draft.extra}
            onChange={(extra) => onChange({ ...draft, extra })}
          />
        </>
      );
    case 'mcq':
      return (
        <>
          <TextField
            label="Question"
            rows={2}
            value={draft.stem}
            onChange={(stem) => onChange({ ...draft, stem })}
          />
          {draft.choices.map((text, i) => (
            <TextField
              key={i}
              label={`Choice ${String.fromCharCode(65 + i)}${i === draft.keyIndex ? ' (key)' : ''}`}
              value={text}
              onChange={(next) =>
                onChange({ ...draft, choices: draft.choices.map((c, j) => (j === i ? next : c)) })
              }
            />
          ))}
          <div className="sv-field ai-narrow">
            <label className="sv-label" htmlFor={keyId}>
              Correct choice
            </label>
            <select
              id={keyId}
              className="sv-control"
              value={draft.keyIndex}
              onChange={(e) => onChange({ ...draft, keyIndex: Number(e.target.value) })}
            >
              {draft.choices.map((_, i) => (
                <option key={i} value={i}>
                  {String.fromCharCode(65 + i)}
                </option>
              ))}
            </select>
          </div>
          <TextField
            label="Explanation"
            rows={3}
            value={draft.explanation}
            onChange={(explanation) => onChange({ ...draft, explanation })}
          />
        </>
      );
  }
}

const ACCEPT_LABEL: Record<AiDraft['type'], string> = {
  pearl: 'Accept as knowledge point',
  note: 'Save as note',
  basic: 'Add card to deck',
  cloze: 'Add card to deck',
  mcq: 'Add question to deck',
};

const TARGET_LABEL: Record<string, string> = {
  knowledgePoints: 'knowledge point',
  cards: 'card',
  notes: 'note',
};

function ItemReview({
  result,
  path,
  sources,
  sourcesReady,
  decks,
  onChanged,
}: {
  result: StoredAiResult;
  path: string;
  sources: ReadonlyMap<string, AiSourceRef>;
  sourcesReady: boolean;
  decks: readonly { id: string; name: string }[];
  onChanged?: (() => void) | undefined;
}) {
  const initial = useMemo(() => initialDraft(result, path, sources), [result, path, sources]);
  const [draft, setDraft] = useState<AiDraft | null>(null);
  const [editing, setEditing] = useState(false);
  const [deckPick, setDeckPick] = useState('');
  const [deckName, setDeckName] = useState('AI drafts');
  const current = draft ?? initial;
  const edited = draft !== null && JSON.stringify(draft) !== JSON.stringify(initial);
  const review = result.items[path];
  const prefix = path === '' ? '' : `${path}/`;
  const unsupported = result.grounding.claims.some(
    (g) => g.path.startsWith(prefix) && !g.supported,
  );
  const isCard = current.type === 'basic' || current.type === 'cloze' || current.type === 'mcq';
  const deckChoice = deckPick || decks[0]?.id || NEW_DECK;

  const accept = useAction(async () => {
    const built = buildAccept(result, path, current, edited, {
      now: new Date(),
      sources,
      deck: !isCard ? null : deckChoice === NEW_DECK ? { name: deckName } : { id: deckChoice },
    });
    if (!built.ok) throw new Error(built.issues.join(' '));
    await acceptAiItem(built.input);
    onChanged?.();
  });
  const discard = useAction(async () => {
    await discardAiItems(result.id, [path]);
    onChanged?.();
  });

  if (review?.state === 'accepted') {
    const made = review.targets.map((t) => TARGET_LABEL[t.table] ?? t.table);
    return (
      <p className="sv-muted" data-testid="ai-item-accepted">
        Accepted{review.edited ? ' after your edits' : ''}: created {made.join(', ')}. It stays
        marked as AI-generated and unverified until you check it.
      </p>
    );
  }
  if (review?.state === 'discarded') {
    return (
      <p className="sv-muted" data-testid="ai-item-discarded">
        Discarded.
      </p>
    );
  }

  let reason: string | undefined;
  if (!sourcesReady) reason = 'Loading your saved sources…';
  else if (unsupported && !edited) {
    reason = 'This item cites text that is not in your sources. Edit it first, or discard it.';
  } else if (
    current.type === 'pearl' &&
    (sources.get(current.highlightId)?.kind !== 'highlight' ||
      sources.get(current.highlightId)?.deleted === true)
  ) {
    reason = 'The cited highlight is no longer in your vault.';
  } else if (isCard && deckChoice === NEW_DECK && !deckName.trim()) {
    reason = 'Name the new deck.';
  }

  return (
    <div className="sv-stack sv-stack--tight">
      {editing ? (
        <div className="ai-box sv-stack sv-stack--tight">
          <DraftFields draft={current} onChange={setDraft} />
          <p className="sv-muted sv-small">
            Your edits are used for the new item only. The source highlight and your other notes are
            never changed.
          </p>
        </div>
      ) : null}
      {isCard ? (
        <div className="sv-row sv-wrap">
          <div className="sv-field">
            <label className="sv-label" htmlFor={`${result.id}${path}-deck`}>
              Deck
            </label>
            <select
              id={`${result.id}${path}-deck`}
              className="sv-control"
              data-testid="ai-deck-select"
              value={deckChoice}
              onChange={(e) => setDeckPick(e.target.value)}
            >
              {decks.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
              <option value={NEW_DECK}>New deck…</option>
            </select>
          </div>
          {deckChoice === NEW_DECK ? (
            <TextField label="New deck name" value={deckName} onChange={setDeckName} />
          ) : null}
        </div>
      ) : null}
      <div className="sv-row sv-wrap">
        <Button
          variant="primary"
          data-testid="ai-accept"
          busy={accept.busy}
          {...(reason ? { disabledReason: reason } : {})}
          onClick={() => void accept.run()}
        >
          {ACCEPT_LABEL[current.type]}
        </Button>
        <Button data-testid="ai-edit" onClick={() => setEditing((v) => !v)}>
          {editing ? 'Done editing' : 'Edit'}
        </Button>
        <Button data-testid="ai-discard" busy={discard.busy} onClick={() => void discard.run()}>
          Discard
        </Button>
      </div>
      {reason ? (
        <p className="sv-muted sv-small" data-testid="ai-accept-reason">
          {reason}
        </p>
      ) : null}
      {accept.error ? (
        <InlineNotice tone="error" title="Could not accept this item">
          {accept.error}
        </InlineNotice>
      ) : null}
      {discard.error ? (
        <InlineNotice tone="error" title="Could not discard this item">
          {discard.error}
        </InlineNotice>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------------------------

export interface AiResultCardProps {
  result: StoredAiResult;
  /** Called after an item was accepted or discarded, or the result was deleted. */
  onChanged?: () => void;
}

/**
 * One AI result. Always labelled with its verification state; citations are the immutable vault
 * quotes (resolved by id), unsupported ones are flagged and not shown. Nothing is created until the
 * person accepts an item, and nothing the model wrote can overwrite a quote or a note.
 */
export function AiResultCard({ result: given, onChanged }: AiResultCardProps) {
  const epoch = useDataEpoch();
  const headingId = useId();
  const [asking, setAsking] = useState(false);
  // The row as stored now: accepting or discarding an item changes it, wherever the card is shown.
  const stored = useAsync(() => getAiResult(given.id), [given.id], [epoch]);
  const result = stored.data ?? given;
  const ids = result.inputSourceIds.join(',');
  const sourcesLoad = useAsync(
    () => resolveAiSources(result.inputSourceIds),
    [result.id, ids],
    [epoch],
  );
  const needsDecks = result.kind === 'flashcards' || result.kind === 'mcq';
  const decksLoad = useAsync(
    () => (needsDecks ? listAiDeckChoices() : Promise.resolve([])),
    [needsDecks],
    [epoch],
  );
  const sources = sourcesLoad.data ?? EMPTY_SOURCES;
  const decks = decksLoad.data ?? [];
  const state = STATE_TONE[result.verificationState];
  const remove = useAction(async () => {
    await deleteAiResult(result.id);
    onChanged?.();
  });

  const review = (path: string) => (
    <ItemReview
      key={path}
      result={result}
      path={path}
      sources={sources}
      sourcesReady={!sourcesLoad.loading && !decksLoad.loading}
      decks={decks}
      onChanged={onChanged}
    />
  );
  const paths = aiItemPaths(result);

  if (stored.data === null) {
    return (
      <p className="sv-muted" data-testid="ai-result-gone">
        This AI draft was deleted.
      </p>
    );
  }

  return (
    <article
      className="ai-card"
      aria-labelledby={headingId}
      data-testid="ai-result-card"
      data-kind={result.kind}
    >
      <header className="sv-row sv-wrap">
        <h3 id={headingId}>{AI_KIND_INFO[result.kind].label}</h3>
        <span data-testid="ai-verification" data-state={result.verificationState}>
          <Badge tone={state.tone} glyph={state.glyph}>
            {VERIFICATION_LABELS[result.verificationState]}
          </Badge>
        </span>
      </header>
      <p className="sv-muted sv-small">
        {result.provider} · {result.model} · {new Date(result.createdAt).toLocaleString()} ·{' '}
        {result.usage.inputTokens + result.usage.outputTokens} tokens
        {result.usage.estimatedCostUsd === null
          ? ''
          : ` · about $${result.usage.estimatedCostUsd.toFixed(4)}`}
      </p>
      {result.notices.map((n) =>
        n === CLINICAL_NOTICE ? (
          <InlineNotice key={n} tone="warning" title="Study aid">
            <span data-testid="ai-notice-clinical">{n}</span>
          </InlineNotice>
        ) : (
          <p key={n} className="sv-muted sv-small" data-testid="ai-notice">
            {n}
          </p>
        ),
      )}
      {sourcesLoad.error ? (
        <InlineNotice tone="error" title="Could not read your saved sources">
          {sourcesLoad.error}
        </InlineNotice>
      ) : null}
      <Output
        result={result}
        sources={sources}
        item={(path, body) => (
          <li key={path} className="ai-item">
            {body}
            {review(path)}
          </li>
        )}
      />
      {result.kind !== 'flashcards' ? review(paths[0] ?? '') : null}
      <div className="sv-row">
        <Button variant="ghost" onClick={() => setAsking(true)}>
          Delete this AI result
        </Button>
      </div>
      {remove.error ? (
        <InlineNotice tone="error" title="Could not delete the result">
          {remove.error}
        </InlineNotice>
      ) : null}
      {asking ? (
        <ConfirmDialog
          title="Delete this AI result?"
          confirmLabel="Delete result"
          danger
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false);
            void remove.run();
          }}
        >
          <p>
            The draft is removed from this device. Anything you already accepted from it stays in
            your vault.
          </p>
        </ConfirmDialog>
      ) : null}
    </article>
  );
}
