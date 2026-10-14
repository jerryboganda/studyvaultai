// Create-bank wizard (modal over the dashboard): name + icon, colour, confirm with a preview.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { AlertCircle, ArrowLeft, ArrowRight, Check, Plus, X } from 'lucide-react';
import { BANK_ICONS, BANKS, HL_COLORS, type HlColor } from '../data';
import { BankTile, Button, Chip, IconButton, Stepper } from '../ui';
import { VaultBuddy } from '../VaultBuddy';

const STEPS = ['Name and icon', 'Colour', 'Confirm'];
const MAX = 40;

interface NewBank {
  name: string;
  icon: string;
  color: HlColor;
}

const iconOf = (id: string) => (BANK_ICONS.find((x) => x.id === id) ?? BANK_ICONS[0])?.icon ?? Plus;

function NewTile({ b }: { b: NewBank }) {
  return <BankTile name={b.name} icon={iconOf(b.icon)} color={b.color} items={0} due={0} pct={0} />;
}

export function CreateBank() {
  const [open, setOpen] = useState(true);
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<NewBank>({ name: 'Anatomy', icon: 'steth', color: 'violet' });
  const [error, setError] = useState('');
  const [created, setCreated] = useState<NewBank[]>([]);
  const [justMade, setJustMade] = useState(false);
  const [touched, setTouched] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const nameId = useId();
  const errId = useId();

  // Move focus into each step (and back to the trigger on close) only after the user acts.
  useEffect(() => {
    if (!touched) return;
    if (!open) {
      trigger.current?.focus();
      return;
    }
    const d = dialog.current;
    const target =
      d?.querySelector<HTMLElement>('[data-autofocus]') ??
      d?.querySelector<HTMLElement>('input:checked') ??
      d?.querySelector<HTMLElement>('input, button');
    target?.focus();
  }, [open, step, justMade, touched]);

  const close = () => {
    setTouched(true);
    setOpen(false);
  };
  const reopen = () => {
    setTouched(true);
    setDraft({ name: '', icon: 'book', color: 'gold' });
    setStep(0);
    setError('');
    setJustMade(false);
    setOpen(true);
  };
  const next = () => {
    setTouched(true);
    if (step === 0) {
      const n = draft.name.trim();
      if (!n) return setError('Enter a name.');
      if (n.length > MAX) return setError(`Keep it under ${MAX} letters.`);
    }
    setError('');
    if (step < STEPS.length - 1) setStep(step + 1);
    else {
      setCreated((c) => [...c, { ...draft, name: draft.name.trim() }]);
      setJustMade(true);
    }
  };

  const trap = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab' || !dialog.current) return;
    const els = [
      ...dialog.current.querySelectorAll<HTMLElement>('button, input, [tabindex="0"]'),
    ].filter(
      (el) =>
        !el.hasAttribute('disabled') &&
        el.tabIndex >= 0 &&
        !(el instanceof HTMLInputElement && el.type === 'radio' && !el.checked),
    );
    const first = els[0];
    const last = els.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  };

  return (
    <div className="cb">
      <div className="cb-behind" inert={open} aria-hidden={open}>
        <div className="cb-behind__rail">
          <VaultBuddy pose="wave" size={36} />
        </div>
        <div className="cb-behind__main">
          <div className="cb-behind__head">
            <h2>Banks</h2>
            <button ref={trigger} type="button" className="sv-btn sv-btn--primary" onClick={reopen}>
              <Plus aria-hidden size={18} strokeWidth={2.8} />
              <span>New bank</span>
            </button>
          </div>
          <div className="cb-behind__grid">
            {BANKS.map((b) => (
              <BankTile
                key={b.id}
                name={b.name}
                icon={b.icon}
                color={b.color}
                items={b.items}
                due={b.due}
                pct={Math.round(b.mastery * 100)}
              />
            ))}
            {created.map((b, i) => (
              <NewTile key={i} b={b} />
            ))}
          </div>
        </div>
      </div>

      {open && (
        <>
          <div className="cb-scrim" aria-hidden onClick={close} />
          <div
            ref={dialog}
            className="cb-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onKeyDown={trap}
          >
            <header className="cb-modal__head">
              <h2 id={titleId}>New bank</h2>
              <IconButton tip="below-end" label="Close" icon={X} onClick={close} />
            </header>

            {justMade ? (
              <div className="cb-made">
                <VaultBuddy pose="cheer" size={120} />
                <p className="cb-made__title">{draft.name.trim()} is ready!</p>
                <NewTile b={draft} />
                <Button variant="primary" size="lg" icon={Check} onClick={close} data-autofocus>
                  Done
                </Button>
              </div>
            ) : (
              <>
                <Stepper step={step} total={STEPS.length} label={STEPS[step] ?? ''} />
                {step === 0 && (
                  <div className="cb-step">
                    <div className="sv-field">
                      <label htmlFor={nameId}>Name</label>
                      <input
                        id={nameId}
                        className="sv-input"
                        value={draft.name}
                        maxLength={60}
                        placeholder="e.g. Anatomy"
                        aria-invalid={error ? true : undefined}
                        aria-describedby={error ? errId : undefined}
                        data-autofocus
                        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') next();
                        }}
                      />
                      {error && (
                        <p className="sv-error" id={errId}>
                          <AlertCircle aria-hidden size={16} strokeWidth={2.6} /> {error}
                        </p>
                      )}
                    </div>
                    <fieldset className="cb-fieldset">
                      <legend className="sv-label">Icon</legend>
                      <div className="cb-icons">
                        {BANK_ICONS.map((ic) => (
                          <label key={ic.id} className="cb-icon">
                            <input
                              type="radio"
                              name="cb-icon"
                              value={ic.id}
                              checked={draft.icon === ic.id}
                              onChange={() => setDraft({ ...draft, icon: ic.id })}
                            />
                            <ic.icon aria-hidden size={22} strokeWidth={2.4} />
                            <span className="sv-sr">{ic.name}</span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  </div>
                )}
                {step === 1 && (
                  <fieldset className="cb-step cb-fieldset">
                    <legend className="sv-label">Colour</legend>
                    <div className="cb-colors">
                      {HL_COLORS.map((c) => (
                        <label key={c.id} className={`cb-color sv-c-${c.id}`}>
                          <input
                            type="radio"
                            name="cb-color"
                            value={c.id}
                            checked={draft.color === c.id}
                            onChange={() => setDraft({ ...draft, color: c.id })}
                          />
                          <span className="cb-color__dot" aria-hidden>
                            {draft.color === c.id && <Check size={20} strokeWidth={3.5} />}
                          </span>
                          <span>{c.name}</span>
                        </label>
                      ))}
                    </div>
                    <p className="cb-chip">
                      <span className="sv-muted">Chip</span>
                      <Chip color={draft.color} icon={iconOf(draft.icon)}>
                        {draft.name.trim()}
                      </Chip>
                    </p>
                  </fieldset>
                )}
                {step === 2 && (
                  <div className="cb-step">
                    <p className="sv-label">Looks good?</p>
                    <NewTile b={{ ...draft, name: draft.name.trim() }} />
                    <p className="sv-muted cb-note">Empty for now. Save a highlight to fill it.</p>
                  </div>
                )}
                <footer className="cb-nav">
                  <Button
                    variant="ghost"
                    icon={ArrowLeft}
                    onClick={() => {
                      setTouched(true);
                      setStep(step - 1);
                    }}
                    disabledReason={step === 0 ? 'This is the first step' : undefined}
                  >
                    Back
                  </Button>
                  <Button
                    variant="primary"
                    iconAfter={step === 2 ? Check : ArrowRight}
                    onClick={next}
                  >
                    {step === 2 ? 'Create bank' : 'Next'}
                  </Button>
                </footer>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
