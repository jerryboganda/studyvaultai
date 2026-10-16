import { useId, useState } from 'react';
import { Link2, Plus, Trash } from 'lucide-react';
import {
  LIMITS,
  VERIFICATION_STATUSES,
  type Claim,
  type ClaimReliability,
  type KnowledgePoint,
  type VerificationStatus,
} from '@study';
import {
  acceptKnowledgePoint,
  createCardsFromKnowledgePoint,
  createKnowledgePoint,
  deleteKnowledgePoint,
  listKnowledgePoints,
  updateKnowledgePoint,
  type HighlightListItem,
} from '@storage';
import {
  Badge,
  Button,
  ChunkyButton,
  ConfirmDialog,
  IconButton,
  InfoTip,
  InlineNotice,
  truncate,
  useAction,
  useObserved,
  useToast,
} from '@ui';
import { TID } from '@ui/review';
import { VERIFICATION_LABEL } from './ExplainPanel';
import { Disclosure } from './ManageKit';

const RELIABILITY: { id: ClaimReliability; label: string }[] = [
  { id: 'unrated', label: 'Not rated' },
  { id: 'low', label: 'Low' },
  { id: 'moderate', label: 'Moderate' },
  { id: 'high', label: 'High' },
];

const STATUS_HELP: Record<VerificationStatus, string> = {
  not_checked: 'Not checked against anything yet.',
  source_supported: 'A linked source says this.',
  conflicting: 'Sources you know of disagree.',
  externally_verified: 'You checked it against an outside reference.',
};

interface Draft {
  oneLiner: string;
  pearl: string;
  misconception: string;
  claims: Claim[];
  status: VerificationStatus;
}

const toDraft = (kp: KnowledgePoint | null): Draft => ({
  oneLiner: kp?.shortOneLiner ?? '',
  pearl: kp?.examPearl ?? '',
  misconception: kp?.misconception ?? '',
  claims: kp?.claims ?? [],
  status: kp?.verificationStatus ?? 'not_checked',
});

/** The knowledge points of one highlight: list, edit, create, and make cards from them. */
export function KnowledgePointEditor({
  highlightId,
  highlights,
}: {
  highlightId: string;
  /** Highlights the learner may link as evidence (the list shown in the picker). */
  highlights: readonly HighlightListItem[];
}) {
  const points = useObserved(() => listKnowledgePoints({ highlightId }), [highlightId]);
  const [creating, setCreating] = useState(false);
  const list = points.data ?? [];

  return (
    <section className="rvm-fields" aria-label="Knowledge points" data-testid={TID.kpEditor}>
      <p className="rvm-line rvm-label">
        Your own short take on this quote.
        <InfoTip label="About knowledge points">
          The quote itself never changes. You set the verification label; StudyVault never fills it
          in.
        </InfoTip>
      </p>
      {points.error ? <InlineNotice tone="error">{points.error}</InlineNotice> : null}
      {list.map((kp) => (
        <KpForm
          key={`${kp.id}-${kp.updatedAt}`}
          highlightId={highlightId}
          kp={kp}
          highlights={highlights}
          onDone={() => undefined}
        />
      ))}
      {creating || (list.length === 0 && !points.loading) ? (
        <KpForm
          key="new"
          highlightId={highlightId}
          kp={null}
          highlights={highlights}
          onDone={() => setCreating(false)}
          // Opened by "Add another": a way back out without saving.
          onCancel={list.length > 0 ? () => setCreating(false) : undefined}
        />
      ) : (
        <div>
          <ChunkyButton icon={Plus} onClick={() => setCreating(true)}>
            Add another
          </ChunkyButton>
        </div>
      )}
    </section>
  );
}

function KpForm({
  highlightId,
  kp,
  highlights,
  onDone,
  onCancel,
}: {
  highlightId: string;
  kp: KnowledgePoint | null;
  highlights: readonly HighlightListItem[];
  onDone(): void;
  onCancel?: (() => void) | undefined;
}) {
  const uid = useId();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>(() => toDraft(kp));
  const [claimsOpen] = useState(() => (kp?.claims.length ?? 0) > 0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const base = toDraft(kp);
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  const hasEvidence = draft.claims.some((c) => c.evidenceHighlightIds.length > 0);
  const label = (id: string): string => {
    const h = highlights.find((x) => x.highlight.id === id);
    return h ? truncate(h.highlight.exactQuote, 80) : 'A highlight no longer in the list';
  };
  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));
  const setClaim = (i: number, p: Partial<Claim>) =>
    patch({ claims: draft.claims.map((c, j) => (j === i ? { ...c, ...p } : c)) });

  const problems: string[] = [];
  if (draft.oneLiner.trim() === '') problems.push('Write the one-line statement first.');
  if (draft.oneLiner.length > LIMITS.oneLiner) {
    problems.push(`Keep the one-liner under ${LIMITS.oneLiner} characters.`);
  }
  if (draft.claims.some((c) => c.text.trim() === '')) problems.push('Every claim needs text.');
  if (draft.status === 'source_supported' && !hasEvidence) {
    problems.push('“Supported by a source” needs a claim with a linked highlight.');
  }
  const disabledReason =
    problems[0] ?? (kp && !dirty ? 'There are no changes to save.' : undefined);

  const save = useAction(async () => {
    if (disabledReason) return;
    const claims = draft.claims.map((c) => ({ ...c, text: c.text.trim() }));
    if (kp) {
      await updateKnowledgePoint(kp.id, {
        shortOneLiner: draft.oneLiner.trim(),
        examPearl: draft.pearl.trim() === '' ? null : draft.pearl.trim(),
        misconception: draft.misconception.trim() === '' ? null : draft.misconception.trim(),
        claims,
        verificationStatus: draft.status,
      });
      toast.push({ message: 'Knowledge point saved.' });
    } else {
      const created = await createKnowledgePoint({
        highlightId,
        shortOneLiner: draft.oneLiner.trim(),
        examPearl: draft.pearl.trim() === '' ? null : draft.pearl.trim(),
        misconception: draft.misconception.trim() === '' ? null : draft.misconception.trim(),
        claims,
      });
      // The label is applied in a second step so that it is always an explicit, user-made change.
      if (draft.status !== 'not_checked') {
        await updateKnowledgePoint(created.id, { verificationStatus: draft.status });
      }
      toast.push({ message: 'Knowledge point created.' });
      onDone();
    }
  });

  const makeCard = useAction(async (template: 'pearl' | 'misconception') => {
    if (!kp) return;
    const cards = await createCardsFromKnowledgePoint(kp.id, template);
    toast.push({ message: `Created ${cards.length} card from this knowledge point.` });
  });

  const accept = useAction(async () => {
    if (kp) await acceptKnowledgePoint(kp.id);
  });

  const remove = useAction(async () => {
    if (!kp) return;
    await deleteKnowledgePoint(kp.id);
    setConfirmDelete(false);
    toast.push({ message: 'Knowledge point deleted. Its cards and the highlight are kept.' });
  });

  const area = (
    name: string,
    text: string,
    value: string,
    set: (v: string) => void,
    testId: string,
  ) => (
    <div className="sv-field">
      <label className="sv-label" htmlFor={`${uid}-${name}`}>
        {text}
      </label>
      <textarea
        id={`${uid}-${name}`}
        className="sv-control"
        rows={2}
        data-testid={testId}
        value={value}
        onChange={(e) => set(e.target.value)}
      />
    </div>
  );

  return (
    <form
      className="rvm-kp"
      aria-label={kp ? 'Knowledge point' : 'New knowledge point'}
      onSubmit={(e) => {
        e.preventDefault();
        void save.run();
      }}
    >
      <div className="rvm-card__head">
        <h3>{kp ? 'Knowledge point' : 'New knowledge point'}</h3>
        {kp ? (
          <Badge tone={VERIFICATION_LABEL[kp.verificationStatus].tone}>
            {VERIFICATION_LABEL[kp.verificationStatus].label}
          </Badge>
        ) : null}
        {kp?.createdBy === 'ai' ? <Badge tone="warning">AI-made, unverified</Badge> : null}
      </div>
      {kp && kp.acceptedAt === null ? (
        <InlineNotice
          tone="warning"
          title="Not accepted yet"
          action={
            <Button busy={accept.busy} onClick={() => void accept.run()}>
              Accept as mine
            </Button>
          }
        >
          Proposed for you; unchecked until you accept it.
        </InlineNotice>
      ) : null}

      <div className="sv-field">
        <label className="sv-label" htmlFor={`${uid}-one`}>
          One-liner
        </label>
        <textarea
          id={`${uid}-one`}
          className="sv-control"
          rows={2}
          data-testid={TID.kpOneLiner}
          maxLength={LIMITS.oneLiner}
          value={draft.oneLiner}
          onChange={(e) => patch({ oneLiner: e.target.value })}
        />
        <p className="rvm-line">
          {draft.oneLiner.length} / {LIMITS.oneLiner}
        </p>
      </div>
      {area('pearl', 'Exam pearl (optional)', draft.pearl, (v) => patch({ pearl: v }), TID.kpPearl)}
      {area(
        'mis',
        'Misconception (optional)',
        draft.misconception,
        (v) => patch({ misconception: v }),
        TID.kpMisconception,
      )}

      <Disclosure
        open={claimsOpen}
        summary={
          <>
            <Link2 aria-hidden="true" width={18} height={18} />
            Claims ({draft.claims.length})
          </>
        }
      >
        <p className="rvm-line">A claim is one statement you back with a highlight.</p>
        <ul className="rvm-fields">
          {draft.claims.map((c, i) => {
            const linkable = highlights.filter(
              (h) => !c.evidenceHighlightIds.includes(h.highlight.id),
            );
            return (
              <li key={i} className="rvm-claim">
                <div className="sv-field">
                  <label className="sv-label" htmlFor={`${uid}-c${i}`}>
                    Claim {i + 1}
                  </label>
                  <textarea
                    id={`${uid}-c${i}`}
                    className="sv-control"
                    rows={2}
                    value={c.text}
                    onChange={(e) => setClaim(i, { text: e.target.value })}
                  />
                </div>
                <div className="rvm-row">
                  <div className="sv-field">
                    <label className="sv-label" htmlFor={`${uid}-r${i}`}>
                      Reliability
                    </label>
                    <select
                      id={`${uid}-r${i}`}
                      className="sv-control"
                      value={c.reliability}
                      onChange={(e) =>
                        setClaim(i, { reliability: e.target.value as ClaimReliability })
                      }
                    >
                      {RELIABILITY.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="sv-field">
                    <label className="sv-label" htmlFor={`${uid}-e${i}`}>
                      Link evidence
                    </label>
                    <select
                      id={`${uid}-e${i}`}
                      className="sv-control"
                      value=""
                      disabled={
                        linkable.length === 0 || c.evidenceHighlightIds.length >= LIMITS.evidence
                      }
                      onChange={(e) => {
                        if (e.target.value)
                          setClaim(i, {
                            evidenceHighlightIds: [...c.evidenceHighlightIds, e.target.value],
                          });
                      }}
                    >
                      <option value="">Choose a highlight…</option>
                      {linkable.map((h) => (
                        <option key={h.highlight.id} value={h.highlight.id}>
                          {truncate(h.highlight.exactQuote, 70)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <IconButton
                    icon={Trash}
                    label={`Remove claim ${i + 1}`}
                    onClick={() => patch({ claims: draft.claims.filter((_, j) => j !== i) })}
                  />
                </div>
                {c.evidenceHighlightIds.length > 0 ? (
                  <ul className="rvm-fields">
                    {c.evidenceHighlightIds.map((id) => (
                      <li key={id} className="rvm-optrow">
                        <span className="sv-quote sv-small sv-grow">{label(id)}</span>
                        <Button
                          aria-label={`Unlink evidence: ${label(id)}`}
                          onClick={() =>
                            setClaim(i, {
                              evidenceHighlightIds: c.evidenceHighlightIds.filter((x) => x !== id),
                            })
                          }
                        >
                          Unlink
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="rvm-line">No evidence linked yet.</p>
                )}
              </li>
            );
          })}
        </ul>
        <div>
          <ChunkyButton
            size="sm"
            icon={Plus}
            data-testid={TID.kpAddClaim}
            disabledReason={
              draft.claims.length >= LIMITS.claims ? `At most ${LIMITS.claims} claims.` : undefined
            }
            onClick={() =>
              patch({
                claims: [
                  ...draft.claims,
                  {
                    text: '',
                    evidenceHighlightIds: highlights.some((h) => h.highlight.id === highlightId)
                      ? [highlightId]
                      : [],
                    reliability: 'unrated',
                  },
                ],
              })
            }
          >
            Add a claim
          </ChunkyButton>
        </div>
      </Disclosure>

      <div className="sv-field">
        <span className="rvm-label">
          <label className="sv-label" htmlFor={`${uid}-status`}>
            Verification
          </label>
          <InfoTip label="About verification">
            Set by you, and it changes only when you change it. Supported by a source needs a claim
            with a linked highlight.
          </InfoTip>
        </span>
        <select
          id={`${uid}-status`}
          className="sv-control"
          data-testid={TID.kpStatus}
          value={draft.status}
          aria-describedby={`${uid}-status-h`}
          onChange={(e) => patch({ status: e.target.value as VerificationStatus })}
        >
          {VERIFICATION_STATUSES.map((s) => (
            <option key={s} value={s} disabled={s === 'source_supported' && !hasEvidence}>
              {VERIFICATION_LABEL[s].label}
              {s === 'source_supported' && !hasEvidence ? ' (link evidence to a claim first)' : ''}
            </option>
          ))}
        </select>
        <p id={`${uid}-status-h`} className="rvm-line">
          {STATUS_HELP[draft.status]}
        </p>
      </div>

      {save.error ? (
        <InlineNotice tone="error" title="Not saved">
          {save.error}
        </InlineNotice>
      ) : null}
      {makeCard.error ? <InlineNotice tone="error">{makeCard.error}</InlineNotice> : null}
      {accept.error ? <InlineNotice tone="error">{accept.error}</InlineNotice> : null}
      {remove.error ? <InlineNotice tone="error">{remove.error}</InlineNotice> : null}
      <div className="rvm-row">
        <Button
          variant="primary"
          type="submit"
          data-testid={TID.kpSave}
          busy={save.busy}
          disabledReason={disabledReason}
        >
          {kp ? 'Save' : 'Create'}
        </Button>
        {onCancel ? <Button onClick={onCancel}>Cancel</Button> : null}
        {kp ? (
          <>
            <Button
              busy={makeCard.busy}
              disabledReason={
                dirty
                  ? 'Save your changes first.'
                  : kp.examPearl
                    ? undefined
                    : 'Add an exam pearl first.'
              }
              onClick={() => void makeCard.run('pearl')}
            >
              Card from pearl
            </Button>
            <Button
              busy={makeCard.busy}
              disabledReason={
                dirty
                  ? 'Save your changes first.'
                  : kp.misconception
                    ? undefined
                    : 'Add a misconception first.'
              }
              onClick={() => void makeCard.run('misconception')}
            >
              Card from misconception
            </Button>
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          </>
        ) : null}
        {disabledReason && dirty ? <span className="rvm-line">{disabledReason}</span> : null}
      </div>
      {confirmDelete ? (
        <ConfirmDialog
          danger
          title="Delete this knowledge point?"
          confirmLabel="Delete"
          onConfirm={() => void remove.run()}
          onCancel={() => setConfirmDelete(false)}
        >
          <p>The highlight, its quote and the cards made from it stay.</p>
          {remove.error ? <InlineNotice tone="error">{remove.error}</InlineNotice> : null}
        </ConfirmDialog>
      ) : null}
    </form>
  );
}
