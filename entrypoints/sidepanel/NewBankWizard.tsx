import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, CircleAlert, FolderOpen } from 'lucide-react';
import { COLOR_IDS, MAX_BANK_NAME_CHARS, type BankLite, type ColorId } from '@shared';
import { createBank, setBankColor, setBankIcon } from '@storage';
import {
  ChunkyButton,
  VaultBuddy,
  Wizard,
  errorMessage,
  trapTab,
  useModalDialog,
  useToast,
} from '@ui';
import { validateBankName } from './model';

/**
 * Icons a bank can wear, with names for screen readers (a bank's emoji is user content and always
 * sits next to its name). ponytail: the dashboard's wizard keeps its own list; move one list to
 * @ui when both surfaces settle.
 */
export const BANK_ICONS: ReadonlyArray<readonly [string, string]> = [
  ['🧠', 'Brain'],
  ['🫀', 'Heart'],
  ['🩻', 'X-ray'],
  ['💊', 'Pill'],
  ['🧬', 'DNA'],
  ['🦴', 'Bone'],
  ['📚', 'Books'],
  ['🧪', 'Test tube'],
  ['🌍', 'Globe'],
  ['⚖️', 'Scales'],
  ['💻', 'Laptop'],
  ['🎵', 'Music'],
];

const colourName = (c: ColorId) => c.charAt(0).toUpperCase() + c.slice(1);

/** What the done screen shows. */
type Made = BankLite & { icon: string };

/**
 * "New bank" (UX_DESIGN 10): 1 Name · 2 Icon · 3 Colour · 4 Looks good?, then a done screen with
 * "Open bank". The bank is created on the last step; its colour and icon are saved right after
 * (a failure there keeps the bank and says so).
 */
export function NewBankWizard({
  onClose,
  onOpen,
}: {
  /** Closed without a bank, or Done on the done screen. */
  onClose(): void;
  onOpen(bank: BankLite): void;
}) {
  const uid = useId();
  const toast = useToast();
  const [name, setName] = useState('');
  const [icon, setIcon] = useState<string>(BANK_ICONS[0]![0]);
  const [color, setColor] = useState<ColorId>('blue');
  const [failure, setFailure] = useState<string | null>(null);
  const [made, setMade] = useState<Made | null>(null);
  const busy = useRef(false);

  const create = async () => {
    if (busy.current) return; // one bank per press
    busy.current = true;
    setFailure(null);
    try {
      const bank = await createBank(name.trim());
      try {
        if (bank.color !== color) await setBankColor(bank.id, color);
        await setBankIcon(bank.id, icon);
      } catch (err) {
        toast.push({
          tone: 'error',
          message: errorMessage(err, 'The bank was made, but its colour or icon was not saved.'),
        });
      }
      toast.push({ message: `Bank "${bank.name}" created.` });
      setMade({ ...bank, color, icon });
    } catch (err) {
      setFailure(errorMessage(err, 'Could not make the bank. Try again.'));
    } finally {
      busy.current = false;
    }
  };

  if (made) return <BankDone bank={made} onClose={onClose} onOpen={() => onOpen(made)} />;

  // Enter in the name field moves on, like Next.
  const onNameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    e.currentTarget
      .closest('.sv-wiz')
      ?.querySelector<HTMLButtonElement>('.sv-wiz__nav .sv-chunky--primary')
      ?.click();
  };

  return (
    <Wizard
      variant="dialog"
      className="sp-newbank"
      label="New bank"
      finishLabel="Create bank"
      finishIcon={Check}
      dirty={name.trim() !== '' || icon !== BANK_ICONS[0]![0] || color !== 'blue'}
      onClose={onClose}
      onFinish={() => void create()}
      steps={[
        {
          id: 'name',
          title: 'Name it',
          validate: () => validateBankName(name),
          content: ({ error, errorId }) => (
            <div className="sv-textfield">
              <label htmlFor={`${uid}-name`}>Bank name</label>
              <input
                id={`${uid}-name`}
                value={name}
                maxLength={MAX_BANK_NAME_CHARS + 20}
                placeholder="For example: Cardiology"
                dir="auto"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={onNameKey}
              />
            </div>
          ),
        },
        {
          id: 'icon',
          title: 'Pick an icon',
          content: (
            <fieldset className="sp-emojis">
              <legend className="sv-sr">Icon</legend>
              {BANK_ICONS.map(([emoji, label]) => (
                <label key={emoji} className="sp-emoji">
                  <input
                    type="radio"
                    className="hl-pick__input"
                    name={`${uid}-icon`}
                    checked={icon === emoji}
                    onChange={() => setIcon(emoji)}
                  />
                  <span aria-hidden="true">{emoji}</span>
                  <span className="sv-sr">{label}</span>
                </label>
              ))}
            </fieldset>
          ),
        },
        {
          id: 'colour',
          title: 'Pick a colour',
          content: (
            <fieldset className="sp-emojis sp-colours">
              <legend className="sv-sr">Colour</legend>
              {COLOR_IDS.map((c) => (
                <label key={c} className="sp-emoji">
                  <input
                    type="radio"
                    className="hl-pick__input"
                    name={`${uid}-colour`}
                    checked={color === c}
                    onChange={() => setColor(c)}
                  />
                  <span aria-hidden="true">
                    <span className={`sp-swatch sp-sw--${c}`} />
                  </span>
                  {/* The name is shown too: colour is never the only cue. */}
                  <span className="sp-colour__name">{colourName(c)}</span>
                </label>
              ))}
            </fieldset>
          ),
        },
        {
          id: 'review',
          title: 'Looks good?',
          content: (
            <>
              <BankPreview name={name.trim()} icon={icon} color={color} />
              <p className="sp-hint">Change it any time with Back.</p>
              {failure ? (
                <p className="sv-wiz__error" role="alert">
                  <CircleAlert aria-hidden="true" strokeWidth={2.6} />
                  {failure}
                </p>
              ) : null}
            </>
          ),
        },
      ]}
    />
  );
}

function BankPreview({ name, icon, color }: { name: string; icon: string; color: ColorId }) {
  return (
    <div className="sp-bankhead" data-testid="new-bank-preview">
      <span className={`sp-tile sp-sw--${color}`} aria-hidden="true">
        {icon}
      </span>
      <div className="sp-bank__text">
        <strong dir="auto" className="sv-wrap">
          {name}
        </strong>
        <span>
          {colourName(color)}, {BANK_ICONS.find(([e]) => e === icon)?.[1] ?? 'icon'}
        </span>
      </div>
    </div>
  );
}

/** The done screen: cheering mascot, the new bank, "Open bank" or "Done". */
function BankDone({ bank, onClose, onOpen }: { bank: Made; onClose(): void; onOpen(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  useModalDialog(dialog);
  // showModal moved focus to the first button: the title is read first.
  useEffect(() => title.current?.focus(), []);
  return (
    <dialog
      ref={dialog}
      className="sv-wiz sv-wiz--dialog sp-done"
      aria-labelledby={titleId}
      data-testid="new-bank-done"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onKeyDown={(e) => trapTab(e, e.currentTarget)}
    >
      <VaultBuddy pose="cheer" size={112} />
      <h2 id={titleId} className="sv-wiz__title" tabIndex={-1} ref={title}>
        Bank ready!
      </h2>
      <BankPreview name={bank.name} icon={bank.icon} color={bank.color} />
      <div className="sv-wiz__nav">
        <ChunkyButton onClick={onClose}>Done</ChunkyButton>
        <ChunkyButton variant="primary" icon={FolderOpen} onClick={onOpen}>
          Open bank
        </ChunkyButton>
      </div>
    </dialog>
  );
}
