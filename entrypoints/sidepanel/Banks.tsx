import { useId, useState, type FormEvent } from 'react';
import { createBank, listBanksWithCounts } from '@storage';
import { Badge, Button, InlineNotice, plural, useAction, useObserved, useToast } from '@ui';
import { validateBankName } from './model';

/**
 * Banks tab. Names are typed here, in the extension origin, because the page overlay has no text
 * input (ADR-005); the overlay only picks among the banks listed below.
 */
export function Banks() {
  const banks = useObserved(() => listBanksWithCounts(), []);
  return (
    <div className="sv-stack">
      <h2 className="sv-sr">Banks</h2>
      <NewBankForm />
      {banks.error ? (
        <InlineNotice
          tone="error"
          title="Could not load banks"
          action={<Button onClick={banks.reload}>Retry</Button>}
        >
          {banks.error}
        </InlineNotice>
      ) : !banks.data ? (
        <p className="sv-muted" role="status">
          Loading banks…
        </p>
      ) : (
        <ul className="bank-list" aria-label="Your banks">
          {banks.data.map(({ bank, count }) => (
            <li key={bank.id} className="bank-item">
              <span className="sv-grow sv-wrap">{bank.name}</span>
              {bank.isInbox ? <Badge>Default</Badge> : null}
              <Badge>{plural(count, 'highlight')}</Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NewBankForm() {
  const uid = useId();
  const toast = useToast();
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const create = useAction(async (bankName: string) => {
    const bank = await createBank(bankName);
    setName('');
    toast.push({ message: `Bank "${bank.name}" created.` });
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (create.busy) return; // aria-disabled buttons still submit; one bank per request
    const invalid = validateBankName(name);
    setProblem(invalid);
    if (invalid === null) void create.run(name.trim());
  };

  return (
    <form className="sv-stack sv-stack--tight" onSubmit={onSubmit} noValidate>
      <div className="sv-field">
        <label className="sv-label" htmlFor={`${uid}-name`}>
          New bank
        </label>
        <input
          id={`${uid}-name`}
          className="sv-control"
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="For example: Cardiology"
          value={name}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${uid}-problem` : undefined}
          onChange={(e) => {
            setName(e.target.value);
            setProblem(null);
          }}
        />
      </div>
      <div>
        <Button type="submit" variant="primary" busy={create.busy}>
          Create bank
        </Button>
      </div>
      {problem ? (
        <p id={`${uid}-problem`} role="alert" className="panel__error">
          Error: {problem}
        </p>
      ) : null}
      {create.error ? (
        <InlineNotice
          tone="error"
          title="Could not create the bank"
          action={<Button onClick={create.retry}>Retry</Button>}
        >
          {create.error}
        </InlineNotice>
      ) : null}
    </form>
  );
}
