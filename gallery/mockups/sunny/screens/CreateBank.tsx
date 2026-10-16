import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowLeft, Check, CircleAlert, Plus, X } from 'lucide-react';
import { BankCard } from '../shared';
import { VaultBuddy } from '../VaultBuddy';
import { Button, IconButton, WizardProgress } from '../ui';

const EMOJIS = ['🧠', '🫀', '🩻', '💊', '🧬', '🦴', '📚', '🧪', '🌍', '⚖️', '💻', '🎵'];
const COLOURS = [
  { id: 'blue', name: 'Blue' },
  { id: 'sun', name: 'Yellow' },
  { id: 'pink', name: 'Pink' },
  { id: 'green', name: 'Green' },
  { id: 'violet', name: 'Violet' },
  { id: 'orange', name: 'Orange' },
];

export function CreateBank() {
  const [open, setOpen] = useState(true);
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState(EMOJIS[0]!);
  const [colour, setColour] = useState('blue');
  const [error, setError] = useState('');
  const [created, setCreated] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const ids = { title: useId(), name: useId(), err: useId(), emoji: useId(), colour: useId() };

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (open) heading.current?.focus();
  }, [open, step, created]);

  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  const reset = () => {
    setStep(1);
    setName('');
    setEmoji(EMOJIS[0]!);
    setColour('blue');
    setError('');
    setCreated(false);
    setOpen(true);
  };
  const next = () => {
    if (step === 1 && !name.trim()) {
      setError('Enter a name');
      nameInput.current?.focus();
      return;
    }
    setError('');
    setStep(step + 1);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    // Keep Tab inside the dialog: Close is the first button, the nav action the last.
    if (e.key !== 'Tab') return;
    const btns = e.currentTarget.querySelectorAll('button');
    const first = btns[0];
    const last = btns[btns.length - 1];
    if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    }
  };
  // One decision per screen.
  const titles = ['Name your bank', 'Pick an icon', 'Pick a colour', 'Looks good?'];
  const total = titles.length;

  return (
    <div className="sv-screen cb">
      <div className="cb__behind" inert={open}>
        <Button ref={trigger} variant="sun" icon={Plus} onClick={reset}>
          New bank
        </Button>
      </div>
      {open && (
        <div className="cb__scrim">
          <div
            className="sv-card cb__dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={ids.title}
            onKeyDown={onKey}
          >
            <div className="sv-row cb__head">
              <span className="sv-eyebrow">New bank</span>
              <span className="sv-spacer" />
              <IconButton icon={X} label="Close" onClick={close} tipSide="left" />
            </div>

            {created ? (
              <div className="cb__done">
                <VaultBuddy pose="cheer" size={120} />
                <h3 id={ids.title} ref={heading} tabIndex={-1}>
                  Bank ready!
                </h3>
                <BankCard
                  as="div"
                  bank={{
                    id: 'new',
                    name: name.trim(),
                    emoji,
                    colour,
                    highlights: 0,
                    cards: 0,
                    mastered: 0,
                    due: 0,
                  }}
                />
                <Button variant="primary" size="lg" block onClick={close}>
                  Done
                </Button>
              </div>
            ) : (
              <>
                <WizardProgress step={step} total={total} label="New bank" />
                <h3 id={ids.title} className="cb__title" ref={heading} tabIndex={-1}>
                  {titles[step - 1]}
                </h3>

                {step === 1 && (
                  <div className="cb__body">
                    <div className="sv-field">
                      <label className="sv-label" htmlFor={ids.name}>
                        Bank name
                      </label>
                      <input
                        id={ids.name}
                        ref={nameInput}
                        className="sv-input"
                        value={name}
                        maxLength={60}
                        placeholder="e.g. Anatomy"
                        aria-invalid={error ? true : undefined}
                        aria-describedby={error ? ids.err : undefined}
                        onChange={(e) => {
                          setName(e.target.value);
                          setError('');
                        }}
                        onKeyDown={(e) => e.key === 'Enter' && next()}
                      />
                      {error && (
                        <p id={ids.err} className="sv-error">
                          <CircleAlert aria-hidden="true" />
                          {error}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {step === 2 && (
                  <div className="cb__body">
                    <fieldset className="cb__emojis">
                      <legend className="sv-vh">Icon</legend>
                      {EMOJIS.map((e) => (
                        <label key={e} className="cb__emoji">
                          <input
                            type="radio"
                            name={ids.emoji}
                            checked={emoji === e}
                            onChange={() => setEmoji(e)}
                          />
                          <span aria-hidden="true">{e}</span>
                          <span className="sv-vh">{e}</span>
                        </label>
                      ))}
                    </fieldset>
                  </div>
                )}

                {step === 3 && (
                  <fieldset className="cb__body cb__swatches">
                    <legend className="sv-vh">Colour</legend>
                    {COLOURS.map((c) => (
                      <label key={c.id} className="cb__swatch">
                        <input
                          type="radio"
                          name={ids.colour}
                          checked={colour === c.id}
                          onChange={() => setColour(c.id)}
                        />
                        <span className={`cb__dot sv-swatch--${c.id}`} aria-hidden="true">
                          <Check strokeWidth={3.5} />
                        </span>
                        {c.name}
                      </label>
                    ))}
                  </fieldset>
                )}

                {step === 4 && (
                  <div className="cb__body">
                    <BankCard
                      as="div"
                      bank={{
                        id: 'new',
                        name: name.trim(),
                        emoji,
                        colour,
                        highlights: 0,
                        cards: 0,
                        mastered: 0,
                        due: 0,
                      }}
                    />
                    <p className="sv-muted cb__note">You can change it later.</p>
                  </div>
                )}

                <div className="sv-row cb__nav">
                  <Button
                    icon={ArrowLeft}
                    onClick={() => setStep(step - 1)}
                    disabledReason={step === 1 ? 'This is the first step' : undefined}
                  >
                    Back
                  </Button>
                  <span className="sv-spacer" />
                  {step < total ? (
                    <Button variant="primary" onClick={next}>
                      Next
                    </Button>
                  ) : (
                    <Button variant="sun" icon={Check} onClick={() => setCreated(true)}>
                      Create bank
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
