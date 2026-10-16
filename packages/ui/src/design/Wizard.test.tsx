import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, useState } from 'react';
import { ChoiceCards } from './ChoiceCards';
import { Wizard, type WizardStep } from './Wizard';

afterEach(cleanup);

function NewBank({
  variant = 'page',
  onFinish = () => {},
  onClose,
}: {
  variant?: 'page' | 'dialog';
  onFinish?: (v: string) => void;
  onClose?: () => void;
}) {
  const [name, setName] = useState('');
  const [colour, setColour] = useState<'blue' | 'sun'>('blue');
  const steps: WizardStep[] = [
    {
      id: 'name',
      title: 'Name your bank',
      validate: () => (name.trim() ? null : 'Enter a name'),
      content: ({ error, errorId }) => (
        <div className="sv-textfield">
          <label htmlFor="bank-name">Bank name</label>
          <input
            id="bank-name"
            value={name}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      ),
    },
    {
      id: 'colour',
      title: 'Pick a colour',
      content: (
        <ChoiceCards
          label="Colour"
          value={colour}
          onChange={setColour}
          options={[
            { value: 'blue', label: 'Blue' },
            { value: 'sun', label: 'Yellow' },
          ]}
        />
      ),
    },
    { id: 'review', title: 'Looks good?', content: <p>{`${name} in ${colour}`}</p> },
  ];
  return (
    <Wizard
      label="New bank"
      steps={steps}
      variant={variant}
      dirty={name !== ''}
      onClose={onClose}
      finishLabel="Create bank"
      onFinish={() => onFinish(`${name}/${colour}`)}
    />
  );
}

function Opener({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open wizard
      </button>
      {open && (
        <NewBank
          variant="dialog"
          onClose={() => {
            onClose?.();
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

describe('Wizard', () => {
  it('blocks Next until the step is valid, focuses the invalid field and clears the error once fixed', async () => {
    const user = userEvent.setup();
    render(<NewBank />);
    await user.click(screen.getByRole('button', { name: 'Next' }));

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Enter a name');
    const input = screen.getByLabelText('Bank name');
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(alert.id);
    expect(screen.getByRole('heading', { name: 'Name your bank' })).toBeTruthy();

    await user.type(input, 'Anatomy');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(input.getAttribute('aria-invalid')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    const heading = screen.getByRole('heading', { name: 'Pick a colour' });
    expect(document.activeElement).toBe(heading);
  });

  it('Back keeps earlier choices, shows progress and Finish hands over the result', async () => {
    const user = userEvent.setup();
    const onFinish = vi.fn();
    render(<NewBank onFinish={onFinish} />);
    // Step 1: Back is there but disabled with its reason (no silent dead control).
    const back = screen.getByRole('button', { name: 'Back' });
    expect(back.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('progressbar', { name: 'New bank progress' })).toBeTruthy();
    expect(document.getElementById(back.getAttribute('aria-describedby')!)?.textContent).toBe(
      'This is the first step',
    );
    await user.click(back);
    expect(screen.getByRole('heading', { name: 'Name your bank' })).toBeTruthy();

    await user.type(screen.getByLabelText('Bank name'), 'Anatomy');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const progress = screen.getByRole('progressbar', { name: 'New bank progress' });
    expect(progress.getAttribute('aria-valuenow')).toBe('2');
    expect(progress.getAttribute('aria-valuemax')).toBe('3');
    expect(progress.getAttribute('aria-valuetext')).toBe('Step 2 of 3: Pick a colour');

    await user.click(screen.getByRole('radio', { name: 'Yellow' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Anatomy in sun')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Looks good?' }));

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Pick a colour' }));
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Yellow' }).checked).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect((screen.getByLabelText('Bank name') as HTMLInputElement).value).toBe('Anatomy');

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Create bank' }));
    expect(onFinish).toHaveBeenCalledWith('Anatomy/sun');
  });

  it('a page wizard does not take focus on mount, even under StrictMode', () => {
    render(
      <StrictMode>
        <NewBank />
      </StrictMode>,
    );
    expect(document.activeElement).toBe(document.body);
  });

  it('an unanswered picture-card step marks the group invalid and focuses its first card', async () => {
    const user = userEvent.setup();
    function Goal() {
      const [goal, setGoal] = useState<'10' | '30' | null>(null);
      return (
        <Wizard
          label="Setup"
          onFinish={() => {}}
          steps={[
            {
              id: 'goal',
              title: 'Your daily goal',
              validate: () => (goal ? null : 'Pick a goal'),
              content: ({ error, errorId }) => (
                <ChoiceCards
                  label="Daily goal"
                  value={goal}
                  onChange={setGoal}
                  invalid={Boolean(error)}
                  describedBy={error ? errorId : undefined}
                  options={[
                    { value: '10', label: 'Casual' },
                    { value: '30', label: 'Regular' },
                  ]}
                />
              ),
            },
            { id: 'done', title: 'All set', content: <p>Done</p> },
          ]}
        />
      );
    }
    render(<Goal />);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const group = screen.getByRole('radiogroup', { name: 'Daily goal' });
    expect(group.getAttribute('aria-invalid')).toBe('true');
    expect(group.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Casual' }));

    await user.keyboard(' ');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(group.hasAttribute('aria-invalid')).toBe(false);
  });
});

describe('Wizard dialog', () => {
  it('traps Tab, closes on Escape when clean and gives focus back to the opener', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Opener onClose={onClose} />);
    const opener = screen.getByRole('button', { name: 'Open wizard' });
    await user.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'New bank' });
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Name your bank' }));

    const close = screen.getByRole('button', { name: 'Close' });
    const next = screen.getByRole('button', { name: 'Next' });
    next.focus();
    await user.tab();
    expect(document.activeElement).toBe(close); // wrapped from the last control to the first
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(next); // and back
    for (let i = 0; i < 6; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('asks before discarding typed changes; Escape or Keep editing returns to the step', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Opener onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Open wizard' }));
    await user.type(screen.getByLabelText('Bank name'), 'Anatomy');

    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: 'Discard changes?' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep editing' }));

    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Name your bank' }));
    expect((screen.getByLabelText('Bank name') as HTMLInputElement).value).toBe('Anatomy');

    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByRole('heading', { name: 'Name your bank' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open wizard' }));
  });
});
