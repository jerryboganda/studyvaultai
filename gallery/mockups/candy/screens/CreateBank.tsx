// Create-bank wizard (modal): 1 name + icon, 2 colour, 3 confirm with a preview card, then done.
import { useEffect, useId, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  ArrowLeft,
  ArrowRight,
  Atom,
  BookOpen,
  Brain,
  Calculator,
  Check,
  CircleAlert,
  FlaskConical,
  Globe,
  HeartPulse,
  Leaf,
  Music,
  Palette,
  Pill,
  Plus,
  Stethoscope,
  X,
  type LucideIcon,
} from 'lucide-react';
import { BANKS, type Tone } from '../data';
import { VaultBuddy } from '../VaultBuddy';
import { Btn, GO_EVENT, IconButton, Steps, trapTab } from '../ui';

const ICONS: { id: string; label: string; icon: LucideIcon }[] = [
  { id: 'heart', label: 'Heart', icon: HeartPulse },
  { id: 'brain', label: 'Brain', icon: Brain },
  { id: 'pill', label: 'Pill', icon: Pill },
  { id: 'steth', label: 'Stethoscope', icon: Stethoscope },
  { id: 'flask', label: 'Flask', icon: FlaskConical },
  { id: 'atom', label: 'Atom', icon: Atom },
  { id: 'book', label: 'Book', icon: BookOpen },
  { id: 'globe', label: 'Globe', icon: Globe },
  { id: 'calc', label: 'Maths', icon: Calculator },
  { id: 'music', label: 'Music', icon: Music },
  { id: 'palette', label: 'Art', icon: Palette },
  { id: 'leaf', label: 'Nature', icon: Leaf },
];
const TONES: { id: Tone; label: string }[] = [
  { id: 'lavender', label: 'Lavender' },
  { id: 'mint', label: 'Mint' },
  { id: 'peach', label: 'Peach' },
  { id: 'butter', label: 'Butter' },
  { id: 'sky', label: 'Sky' },
  { id: 'rose', label: 'Rose' },
];
const STEPS = ['Name', 'Colour', 'Check'];

function Preview({ name, icon: Icon, tone }: { name: string; icon: LucideIcon; tone: Tone }) {
  return (
    <div className="cb-preview db-bank" data-tone={tone}>
      <span className="db-bank__blob" aria-hidden="true" />
      <div className="db-bank__top">
        <span className="sv-well">
          <Icon aria-hidden="true" strokeWidth={2.4} />
        </span>
        <span className="sv-chip" data-tone="sky">
          New
        </span>
      </div>
      <p className="db-bank__name">{name || 'Your bank'}</p>
      <p className="sv-hint">0 items</p>
    </div>
  );
}

export function CreateBank() {
  const ids = useId();
  const [open, setOpen] = useState(true);
  const [step, setStep] = useState(0);
  const [name, setName] = useState('Biochemistry');
  const [icon, setIcon] = useState('flask');
  const [tone, setTone] = useState<Tone>('mint');
  const [error, setError] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const head = useRef<HTMLHeadingElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const Icon = ICONS.find((i) => i.id === icon)!.icon;
  const toneLabel = TONES.find((t) => t.id === tone)!.label;

  const show = (n: number) => {
    flushSync(() => setStep(n));
    head.current?.focus();
  };
  const start = () => {
    flushSync(() => {
      setOpen(true);
      setStep(0);
      setError(false);
    });
    head.current?.focus();
  };
  const close = () => {
    setOpen(false);
    opener.current?.focus();
  };
  const next = () => {
    if (step === 0 && !name.trim()) {
      setError(true);
      nameInput.current?.focus();
      return;
    }
    show(step + 1);
  };

  // Other mockups ("New bank") open this wizard.
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<string>).detail === 'create-bank') start();
    };
    window.addEventListener(GO_EVENT, on);
    return () => window.removeEventListener(GO_EVENT, on);
  });

  return (
    <div className="cb">
      <div className="cb-page" inert={open}>
        <div className="cb-page__head">
          <h3>Banks</h3>
          <Btn variant="primary" icon={Plus} onClick={start} btnRef={opener}>
            New bank
          </Btn>
        </div>
        <ul className="cb-page__grid">
          {BANKS.slice(0, 4).map((b) => {
            const BIcon = b.icon;
            return (
              <li key={b.id} className="db-bank" data-tone={b.tone}>
                <span className="db-bank__blob" aria-hidden="true" />
                <span className="sv-well">
                  <BIcon aria-hidden="true" strokeWidth={2.4} />
                </span>
                <p className="db-bank__name">{b.name}</p>
                <p className="sv-hint">{b.items} items</p>
              </li>
            );
          })}
        </ul>
      </div>

      {open && (
        <div className="sv-scrim">
          {/* Product: aria-modal + inert page. The gallery keeps the other mockups reachable. */}
          <div
            className="sv-dialog cb-dialog"
            role="dialog"
            aria-labelledby={`${ids}-title`}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                close();
              }
              trapTab(e);
            }}
          >
            <IconButton
              className="sv-dialog__close"
              label="Close"
              icon={X}
              tip="below-end"
              onClick={close}
            />
            <p className="cb-kicker">New bank</p>
            {step < 3 && <Steps steps={STEPS} current={step} label="New bank steps" />}

            <div className="cb-body" key={step}>
              {step === 0 && (
                <>
                  <h2 id={`${ids}-title`} ref={head} tabIndex={-1}>
                    Name your bank
                  </h2>
                  <div className="sv-field">
                    <label htmlFor={`${ids}-name`} className="sv-label">
                      Bank name
                    </label>
                    <input
                      ref={nameInput}
                      id={`${ids}-name`}
                      className="sv-input"
                      value={name}
                      maxLength={60}
                      aria-invalid={error || undefined}
                      aria-describedby={error ? `${ids}-err` : undefined}
                      onChange={(e) => {
                        setName(e.target.value);
                        if (e.target.value.trim()) setError(false);
                      }}
                    />
                    {error && (
                      <p id={`${ids}-err`} className="sv-error">
                        <CircleAlert aria-hidden="true" strokeWidth={2.6} />
                        Enter a name
                      </p>
                    )}
                  </div>
                  <fieldset className="cb-icons">
                    <legend className="sv-label">Icon</legend>
                    {ICONS.map((i) => {
                      const I = i.icon;
                      return (
                        <label key={i.id} className="cb-icon sv-tip" data-tip={i.label}>
                          <input
                            type="radio"
                            name={`${ids}-icon`}
                            value={i.id}
                            aria-label={i.label}
                            checked={icon === i.id}
                            onChange={() => setIcon(i.id)}
                          />
                          <I aria-hidden="true" strokeWidth={2.3} />
                        </label>
                      );
                    })}
                  </fieldset>
                </>
              )}

              {step === 1 && (
                <>
                  <h2 id={`${ids}-title`} ref={head} tabIndex={-1}>
                    Pick a colour
                  </h2>
                  <div className="cb-colour">
                    <fieldset className="cb-swatches">
                      <legend className="sv-vh">Colour</legend>
                      {TONES.map((t) => (
                        <label key={t.id} className="cb-swatch" data-tone={t.id}>
                          <input
                            type="radio"
                            name={`${ids}-tone`}
                            value={t.id}
                            checked={tone === t.id}
                            onChange={() => setTone(t.id)}
                          />
                          <span className="cb-swatch__dot" aria-hidden="true">
                            <Check strokeWidth={3.5} />
                          </span>
                          {t.label}
                        </label>
                      ))}
                    </fieldset>
                    <Preview name={name} icon={Icon} tone={tone} />
                  </div>
                </>
              )}

              {step === 2 && (
                <>
                  <h2 id={`${ids}-title`} ref={head} tabIndex={-1}>
                    Looks good?
                  </h2>
                  <div className="cb-confirm">
                    <Preview name={name} icon={Icon} tone={tone} />
                    <dl className="cb-facts">
                      <div>
                        <dt>Name</dt>
                        <dd>{name}</dd>
                      </div>
                      <div>
                        <dt>Icon</dt>
                        <dd>{ICONS.find((i) => i.id === icon)!.label}</dd>
                      </div>
                      <div>
                        <dt>Colour</dt>
                        <dd>{toneLabel}</dd>
                      </div>
                    </dl>
                  </div>
                </>
              )}

              {step === 3 && (
                <div className="cb-done">
                  <VaultBuddy pose="cheer" size={132} />
                  <h2 id={`${ids}-title`} ref={head} tabIndex={-1}>
                    Bank created!
                  </h2>
                  <p className="sv-muted">{name} is ready for saves.</p>
                </div>
              )}
            </div>

            <div className="cb-nav">
              {step < 3 ? (
                <>
                  <Btn
                    variant="ghost"
                    icon={ArrowLeft}
                    onClick={() => show(step - 1)}
                    disabledReason={step === 0 ? 'This is the first step' : undefined}
                  >
                    Back
                  </Btn>
                  {step < 2 ? (
                    <Btn
                      variant="primary"
                      onClick={next}
                      trailing={<ArrowRight aria-hidden="true" strokeWidth={2.6} />}
                    >
                      Next
                    </Btn>
                  ) : (
                    <Btn variant="go" icon={Check} onClick={() => show(3)}>
                      Create bank
                    </Btn>
                  )}
                </>
              ) : (
                <Btn variant="primary" block onClick={close}>
                  Done
                </Btn>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
