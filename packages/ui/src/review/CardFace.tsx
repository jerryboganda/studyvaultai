import { renderCloze, type CardType, type Choice, type ClozeData, type McqGrade } from '@study';
import { TID, blankId, choiceId as choiceTestId } from './testids';

/** What a face needs from a card: also satisfied by an unsaved draft in the authoring preview. */
export interface FaceCard {
  cardType: CardType;
  front: string;
  back: string;
  cloze: ClozeData | null;
  choices?: Choice[] | undefined;
  answerChoiceId?: string | undefined;
}

export interface CardFaceProps {
  card: FaceCard;
  /** The answer side is showing. */
  reveal: boolean;
  /** Cloze: deletion numbers uncovered one at a time (question side). */
  revealedBlanks?: readonly number[];
  onRevealBlank?: (index: number) => void;
  /** Multiple choice: options in display order (default: as stored). */
  choices?: readonly Choice[];
  choiceId?: string | null;
  grade?: McqGrade | null;
  /** Absent in previews: options are listed but cannot be picked. */
  onChoose?: (choiceId: string) => void;
}

/**
 * One card, question or answer side. Every piece of text is a React text node (never HTML), so a
 * quote that contains markup stays inert. Meaning never rests on colour alone: a correct option
 * says "Correct answer" and a wrong pick says "Your answer".
 */
export function CardFace({
  card,
  reveal,
  revealedBlanks = [],
  onRevealBlank,
  choices,
  choiceId,
  grade,
  onChoose,
}: CardFaceProps) {
  if (card.cardType === 'cloze' && card.cloze) {
    const opts = { activeIndex: card.cloze.activeIndex };
    const hidden = renderCloze(card.cloze.text, { ...opts, reveal: false });
    const shown = renderCloze(card.cloze.text, { ...opts, reveal: true });
    return (
      <p className="rv-face rv-cloze" data-testid={TID.question}>
        {hidden.map((seg, i) => {
          if (seg.kind === 'text' || seg.kind === 'answer') {
            return <span key={i}>{seg.text}</span>;
          }
          const answer = shown[i];
          const text = answer && answer.kind === 'answer' ? answer.text : '';
          const open = reveal || revealedBlanks.includes(seg.index);
          if (open) {
            return (
              <mark key={i} className="rv-cloze__answer" data-testid={blankId(seg.index)}>
                <span className="sv-sr">Answer {seg.index}: </span>
                {text}
              </mark>
            );
          }
          const label = seg.hint ? `[${seg.hint}]` : '[…]';
          return onRevealBlank ? (
            <button
              key={i}
              type="button"
              className="rv-cloze__blank"
              data-testid={blankId(seg.index)}
              aria-label={`Show hidden answer ${seg.index}${seg.hint ? `, hint: ${seg.hint}` : ''}`}
              onClick={() => onRevealBlank(seg.index)}
            >
              {label}
            </button>
          ) : (
            <span key={i} className="rv-cloze__blank rv-cloze__blank--static">
              {label}
            </span>
          );
        })}
      </p>
    );
  }

  if (card.cardType === 'mcq') {
    const options = choices && choices.length > 0 ? choices : (card.choices ?? []);
    const keyId = grade?.answerChoiceId ?? card.answerChoiceId;
    return (
      <div className="rv-mcq">
        <p className="rv-face" data-testid={TID.question}>
          {card.front}
        </p>
        <ol className="rv-choices" data-testid={TID.choices} aria-label="Answer options">
          {options.map((c, i) => {
            const isKey = reveal && c.id === keyId;
            const picked = choiceId === c.id;
            const wrongPick = reveal && picked && c.id !== keyId;
            const cls = `rv-choice${isKey ? ' rv-choice--key' : ''}${wrongPick ? ' rv-choice--wrong' : ''}`;
            const body = (
              <>
                <span className="rv-choice__n" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="rv-choice__text">{c.text}</span>
                {isKey ? <span className="rv-choice__mark">✓ Correct answer</span> : null}
                {wrongPick ? <span className="rv-choice__mark">✕ Your answer</span> : null}
              </>
            );
            return (
              <li key={c.id}>
                {!reveal && onChoose ? (
                  <button
                    type="button"
                    className={cls}
                    data-testid={choiceTestId(i)}
                    onClick={() => onChoose(c.id)}
                  >
                    {body}
                  </button>
                ) : (
                  <div className={cls} data-testid={choiceTestId(i)}>
                    {body}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    );
  }

  return (
    <div className="rv-qa">
      <p className="rv-face" data-testid={TID.question}>
        {card.front}
      </p>
      {reveal ? (
        <>
          <hr className="rv-rule" />
          <p className="rv-face rv-face--answer" data-testid={TID.answer}>
            {card.back}
          </p>
        </>
      ) : null}
    </div>
  );
}
