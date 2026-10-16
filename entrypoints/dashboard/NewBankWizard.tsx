import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, CircleAlert, FolderOpen } from 'lucide-react';
import { COLOR_IDS, COLOR_SWATCH, type ColorId } from '@shared';
import {
  ChoiceCards,
  ChunkyButton,
  VaultBuddy,
  Wizard,
  errorMessage,
  trapTab,
  useModalDialog,
  useToast,
} from '@ui';
import { useApi } from './api';
import { BankCardView } from './BankCard';
import { NAME_LIMITS } from './dialogs';
import { useBump } from './hooks';

/** Bank icons offered by the wizard (a bank's emoji is user content, named for screen readers). */
export const BANK_EMOJIS = [
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
] as const;

const colorName = (c: ColorId) => c.charAt(0).toUpperCase() + c.slice(1);

interface Made {
  id: string;
  name: string;
  icon: string;
  color: ColorId;
}

/**
 * "New bank" as a four-step wizard (UX_DESIGN 10): Name, Icon, Colour, Looks good?, then a done
 * screen with "Open bank". The bank is created on the last step; colour and icon are saved right
 * after it (a failure there keeps the bank and says so).
 */
export function NewBankWizard({
  onClose,
  onOpenBank,
}: {
  onClose(): void;
  onOpenBank(bankId: string): void;
}) {
  const api = useApi();
  const bump = useBump();
  const toast = useToast();
  const uid = useId();
  const [name, setName] = useState('');
  const [icon, setIcon] = useState<string>(BANK_EMOJIS[0][0]);
  const [color, setColor] = useState<ColorId>('blue');
  const [failure, setFailure] = useState<string | null>(null);
  const [made, setMade] = useState<Made | null>(null);
  const busy = useRef(false);

  const create = async () => {
    if (busy.current) return;
    busy.current = true;
    setFailure(null);
    const trimmed = name.trim();
    try {
      const bank = await api.createBank(trimmed);
      try {
        if (bank.color !== color) await api.setBankColor(bank.id, color);
        await api.setBankIcon(bank.id, icon);
      } catch (err) {
        toast.push({
          tone: 'error',
          message: errorMessage(err, 'The bank was made, but its colour or icon was not saved.'),
        });
      }
      bump();
      setMade({ id: bank.id, name: trimmed, icon, color });
    } catch (err) {
      setFailure(errorMessage(err, 'Could not make the bank. Try again.'));
    } finally {
      busy.current = false;
    }
  };

  if (made) return <BankDone bank={made} onClose={onClose} onOpen={() => onOpenBank(made.id)} />;

  // Enter in the name field moves on, like Next.
  const onNameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    e.currentTarget
      .closest('.sv-wiz')
      ?.querySelector<HTMLButtonElement>('.sv-wiz__nav .sv-chunky--primary')
      ?.click();
  };

  const preview = {
    name: name.trim(),
    icon,
    color,
    saved: 0,
    cards: 0,
    retention: undefined,
    due: null,
  };

  return (
    <Wizard
      variant="dialog"
      label="New bank"
      className="nb"
      finishLabel="Create bank"
      finishIcon={Check}
      dirty={name.trim() !== '' || icon !== BANK_EMOJIS[0][0] || color !== 'blue'}
      onClose={onClose}
      onFinish={() => void create()}
      steps={[
        {
          id: 'name',
          title: 'Name your bank',
          validate: () => (name.trim() === '' ? 'Enter a name' : null),
          content: ({ error, errorId }) => (
            <div className="sv-textfield">
              <label htmlFor={`${uid}-name`}>Bank name</label>
              <input
                id={`${uid}-name`}
                value={name}
                maxLength={NAME_LIMITS.bank}
                placeholder="e.g. Anatomy"
                dir="auto"
                autoComplete="off"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={onNameKey}
                data-testid="name-input"
              />
            </div>
          ),
        },
        {
          id: 'icon',
          title: 'Pick an icon',
          content: (
            <fieldset className="nb__emojis">
              <legend className="sv-vh">Icon</legend>
              {BANK_EMOJIS.map(([emoji, label]) => (
                <label key={emoji} className="nb__emoji">
                  <input
                    type="radio"
                    className="sv-vh"
                    name={`${uid}-icon`}
                    checked={icon === emoji}
                    onChange={() => setIcon(emoji)}
                  />
                  <span aria-hidden="true">{emoji}</span>
                  <span className="sv-vh">{label}</span>
                </label>
              ))}
            </fieldset>
          ),
        },
        {
          id: 'colour',
          title: 'Pick a colour',
          content: (
            <ChoiceCards
              label="Colour"
              columns={4}
              className="nb__colors"
              value={color}
              onChange={setColor}
              options={COLOR_IDS.map((c) => ({
                value: c,
                label: colorName(c),
                tone: 'neutral',
                art: <span className="nb__dot" style={{ background: COLOR_SWATCH[c].solid }} />,
              }))}
            />
          ),
        },
        {
          id: 'review',
          title: 'Looks good?',
          content: (
            <>
              <BankCardView bank={preview} />
              <p className="nb__note">You can change it later.</p>
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

/** The wizard's done screen: cheering mascot, the new bank, "Open bank" or "Done". */
function BankDone({ bank, onClose, onOpen }: { bank: Made; onClose(): void; onOpen(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  useModalDialog(dialog);
  // After showModal (the effect above) moved focus to the first button: the title is read first.
  useEffect(() => title.current?.focus(), []);
  return (
    <dialog
      ref={dialog}
      className="sv-wiz sv-wiz--dialog nb nb__done"
      aria-labelledby={titleId}
      data-testid="new-bank-done"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onKeyDown={(e) => trapTab(e, e.currentTarget)}
    >
      <VaultBuddy pose="cheer" size={120} />
      <h2 id={titleId} className="sv-wiz__title" tabIndex={-1} ref={title}>
        Bank ready!
      </h2>
      <BankCardView bank={{ ...bank, saved: 0, cards: 0, retention: undefined, due: null }} />
      <div className="sv-wiz__nav nb__doneNav">
        <ChunkyButton onClick={onClose}>Done</ChunkyButton>
        <ChunkyButton
          variant="primary"
          icon={FolderOpen}
          onClick={onOpen}
          data-testid="new-bank-open"
        >
          Open bank
        </ChunkyButton>
      </div>
    </dialog>
  );
}
