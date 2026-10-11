import { useId, useState } from 'react';
import { parseCloze, type Card } from '@study';
import type { CardPatch } from '@storage';
import { Button, InlineNotice } from '@ui';
import { CardFace, TID } from '@ui/review';

/**
 * Edit the content of a card in place. Scheduling, the source link and the quote snapshot are not
 * editable here: they are provenance and memory state, not wording.
 */
export function CardEditForm({
  card,
  busy,
  error,
  onSave,
  onCancel,
}: {
  card: Card;
  busy: boolean;
  error?: string | null;
  onSave(patch: CardPatch): Promise<boolean> | boolean;
  onCancel(): void;
}) {
  const uid = useId();
  const [front, setFront] = useState(card.front);
  const [back, setBack] = useState(card.back);
  const [explanation, setExplanation] = useState(card.explanation ?? '');
  const [tags, setTags] = useState(card.tags.join(', '));
  const [markup, setMarkup] = useState(card.cloze?.text ?? '');
  const [choices, setChoices] = useState(card.choices ?? []);
  const [answerId, setAnswerId] = useState(card.answerChoiceId ?? '');
  const isCloze = card.cardType === 'cloze';
  const isMcq = card.cardType === 'mcq';

  const tagList = tags
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const patch: CardPatch = {};
  if (!isCloze && front.trim() !== card.front) patch.front = front;
  if (!isCloze && !isMcq && back.trim() !== card.back) patch.back = back;
  if (isCloze && markup !== card.cloze?.text) patch.clozeMarkup = markup;
  if (explanation.trim() !== (card.explanation ?? '')) patch.explanation = explanation;
  if (JSON.stringify(tagList) !== JSON.stringify(card.tags)) patch.tags = tagList;
  if (isMcq) {
    if (JSON.stringify(choices) !== JSON.stringify(card.choices)) patch.choices = choices;
    if (answerId !== card.answerChoiceId) patch.answerChoiceId = answerId;
  }
  const changed = Object.keys(patch).length > 0;

  const problems: string[] = [];
  if (!isCloze && front.trim() === '') problems.push('The question is empty.');
  if (!isCloze && !isMcq && back.trim() === '') problems.push('The answer is empty.');
  if (isCloze && parseCloze(markup).deletions.length === 0) {
    problems.push('Add at least one deletion, written as {{c1::answer}} or {{c1::answer::hint}}.');
  }
  if (isMcq) {
    if (choices.length < 2) problems.push('A multiple-choice card needs at least 2 options.');
    if (choices.some((c) => c.text.trim() === '')) problems.push('Every option needs text.');
    if (!choices.some((c) => c.id === answerId)) problems.push('Mark which option is correct.');
  }
  const disabledReason =
    problems.length > 0 ? problems[0] : !changed ? 'There are no changes to save.' : undefined;

  const preview: Card = isCloze
    ? {
        ...card,
        cloze: {
          text: markup,
          deletions: parseCloze(markup).deletions,
          activeIndex: card.cloze?.activeIndex ?? null,
        },
      }
    : { ...card, front, back, choices, answerChoiceId: answerId || undefined };

  const nextChoiceId = () => {
    const used = new Set(choices.map((c) => c.id));
    for (let n = choices.length + 1; n < 100; n += 1) if (!used.has(`ch${n}`)) return `ch${n}`;
    return `ch${Date.now() % 100000}`;
  };

  return (
    <form
      className="sv-stack rv-edit"
      aria-label="Edit card"
      data-testid={TID.editor}
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabledReason) void onSave(patch);
      }}
    >
      {isCloze ? (
        <div className="sv-field">
          <label className="sv-label" htmlFor={`${uid}-markup`}>
            Cloze text
          </label>
          <textarea
            id={`${uid}-markup`}
            className="sv-control"
            rows={4}
            value={markup}
            aria-describedby={`${uid}-markup-hint`}
            onChange={(e) => setMarkup(e.target.value)}
          />
          <p id={`${uid}-markup-hint`} className="sv-small sv-muted">
            Hide a word with {'{{c1::answer}}'} or add a hint with {'{{c1::answer::hint}}'}. Editing
            this card does not change the other cards made from the same text.
          </p>
        </div>
      ) : (
        <>
          <div className="sv-field">
            <label className="sv-label" htmlFor={`${uid}-front`}>
              {isMcq ? 'Question' : 'Front'}
            </label>
            <textarea
              id={`${uid}-front`}
              className="sv-control"
              rows={3}
              value={front}
              onChange={(e) => setFront(e.target.value)}
            />
          </div>
          {isMcq ? (
            <fieldset className="rv-fieldset">
              <legend className="sv-label">Options (mark the correct one)</legend>
              <ul className="sv-stack sv-stack--tight">
                {choices.map((c, i) => (
                  <li key={c.id} className="rv-row">
                    <input
                      type="radio"
                      name={`${uid}-key`}
                      checked={answerId === c.id}
                      aria-label={`Option ${i + 1} is correct`}
                      onChange={() => setAnswerId(c.id)}
                    />
                    <input
                      className="sv-control sv-grow"
                      value={c.text}
                      aria-label={`Option ${i + 1} text`}
                      onChange={(e) =>
                        setChoices(
                          choices.map((x) => (x.id === c.id ? { ...x, text: e.target.value } : x)),
                        )
                      }
                    />
                    <Button
                      aria-label={`Remove option ${i + 1}`}
                      disabledReason={
                        choices.length <= 2 ? 'A question needs at least 2 options.' : undefined
                      }
                      onClick={() => {
                        setChoices(choices.filter((x) => x.id !== c.id));
                        if (answerId === c.id) setAnswerId('');
                      }}
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
              <Button
                disabledReason={choices.length >= 8 ? 'At most 8 options.' : undefined}
                onClick={() => setChoices([...choices, { id: nextChoiceId(), text: '' }])}
              >
                Add option
              </Button>
            </fieldset>
          ) : (
            <div className="sv-field">
              <label className="sv-label" htmlFor={`${uid}-back`}>
                Back
              </label>
              <textarea
                id={`${uid}-back`}
                className="sv-control"
                rows={3}
                value={back}
                onChange={(e) => setBack(e.target.value)}
              />
            </div>
          )}
        </>
      )}
      <div className="sv-field">
        <label className="sv-label" htmlFor={`${uid}-explanation`}>
          Explanation (optional)
        </label>
        <textarea
          id={`${uid}-explanation`}
          className="sv-control"
          rows={2}
          value={explanation}
          onChange={(e) => setExplanation(e.target.value)}
        />
      </div>
      <div className="sv-field">
        <label className="sv-label" htmlFor={`${uid}-tags`}>
          Tags (comma separated)
        </label>
        <input
          id={`${uid}-tags`}
          className="sv-control"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />
      </div>
      <div className="rv-preview-box" aria-label="How the card will look">
        <p className="sv-label">Preview</p>
        <CardFace card={preview} reveal={false} />
      </div>
      {error ? (
        <InlineNotice tone="error" title="Not saved">
          {error}
        </InlineNotice>
      ) : null}
      <div className="sv-row">
        <Button variant="primary" type="submit" busy={busy} disabledReason={disabledReason}>
          Save card
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
        {disabledReason ? <span className="sv-small sv-muted">{disabledReason}</span> : null}
      </div>
    </form>
  );
}
