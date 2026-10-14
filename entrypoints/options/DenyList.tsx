import { useId, useRef, useState, type FormEvent } from 'react';
import { Ban, Plus, X } from 'lucide-react';
import { DEFAULT_DENY_HOSTS, DENY_LIST_SCOPE_NOTE, type Settings } from '@shared';
import { Button, IconButton, InlineNotice, editDenyList, plural, useAction, useToast } from '@ui';
import { addDenyEntry, missingDefaults, removeDenyEntry, sortedDeny } from './model';
import { Card } from './ui';

/** Above this many missing starter sites the list is summarised, not spelled out. */
const MAX_NAMED = 8;

/**
 * The deny list as chips: the sites you added up front, the long starter list one click away.
 * StudyVault is off on every listed site and its subdomains.
 */
export function DenyList({ settings }: { settings: Settings }) {
  const { announce } = useToast();
  const heading = useRef<HTMLHeadingElement>(null);
  const edit = useAction(
    async (change: (list: string[]) => string[], spoken: string, focusHeading: boolean) => {
      await editDenyList(change);
      announce(spoken);
      // A removed chip takes its button (and focus) with it.
      if (focusHeading) heading.current?.focus();
    },
  );
  const defaults: readonly string[] = DEFAULT_DENY_HOSTS;
  const lacking = missingDefaults(settings.denyList, defaults);
  const all = sortedDeny(settings.denyList);
  const mine = all.filter((h) => !defaults.includes(h));
  const starter = all.filter((h) => defaults.includes(h));

  const chips = (hosts: string[], label: string) => (
    <ul className="opt-chiplist" aria-label={label}>
      {hosts.map((host) => (
        <li key={host} className="opt-chip" dir="ltr">
          <span className="sv-wrap">{host}</span>
          <IconButton
            icon={X}
            size="sm"
            tipSide="top"
            label={`Remove ${host} from the deny list`}
            aria-disabled={edit.busy || undefined}
            onClick={() => {
              if (edit.busy) return;
              void edit.run(
                (list) => removeDenyEntry(list, host),
                `Removed ${host} from the deny list.`,
                true,
              );
            }}
          />
        </li>
      ))}
    </ul>
  );

  return (
    <Card
      title="Deny list"
      icon={Ban}
      tone="danger"
      headingRef={heading}
      aside={<span className="opt-count">{plural(all.length, 'site')}</span>}
      info={`StudyVault is switched off on these sites and all of their subdomains: no toolbar, no highlights, nothing saved. ${DENY_LIST_SCOPE_NOTE}`}
    >
      <p className="opt-line">Always off here, subdomains too.</p>
      <AddSite
        denyList={settings.denyList}
        busy={edit.busy}
        onAdd={(host) =>
          void edit.run(
            (list) => [...list.filter((h) => h !== host), host],
            `Added ${host} to the deny list.`,
            false,
          )
        }
      />
      {edit.error ? (
        <InlineNotice
          tone="error"
          title="Could not update the deny list"
          action={
            edit.retryable ? (
              <Button busy={edit.busy} onClick={edit.retry}>
                Retry
              </Button>
            ) : undefined
          }
        >
          {edit.error}
        </InlineNotice>
      ) : null}
      {all.length === 0 ? (
        <p className="sv-muted">The list is empty: StudyVault may run on any site you turn on.</p>
      ) : null}
      {mine.length > 0 ? chips(mine, 'Sites you added') : null}
      {starter.length > 0 ? (
        <details className="opt-more">
          <summary className="opt-more__summary">
            Starter sites <span className="opt-count">{starter.length}</span>
          </summary>
          <div className="opt-more__body">{chips(starter, 'Starter sites')}</div>
        </details>
      ) : null}
      <div className="opt-restore">
        <Button
          busy={edit.busy}
          disabledReason={
            lacking.length === 0 ? 'All default sites are already on the list.' : undefined
          }
          onClick={() =>
            void edit.run(
              (list) => [...list, ...missingDefaults(list, defaults)],
              'Default sites restored to the deny list.',
              false,
            )
          }
        >
          Restore default sites
        </Button>
        {lacking.length > 0 ? (
          <p className="sv-muted sv-small">
            {lacking.length <= MAX_NAMED
              ? `Missing: ${lacking.join(', ')}.`
              : `${lacking.length} of the ${defaults.length} starter sites are missing.`}{' '}
            Your own sites stay.
          </p>
        ) : null}
      </div>
    </Card>
  );
}

/** Own component so typing re-renders this form, not the (long) list below it. */
export function AddSite({
  denyList,
  busy,
  onAdd,
  label = 'Add a site',
}: {
  denyList: readonly string[];
  busy: boolean;
  onAdd(host: string): void;
  label?: string;
}) {
  const uid = useId();
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const result = addDenyEntry(denyList, text);
    if (!result.ok) {
      setProblem(result.error);
      return;
    }
    setProblem(null);
    setText('');
    onAdd(result.host);
  };

  return (
    <form className="opt-addform" onSubmit={submit} noValidate>
      <div className="sv-textfield">
        <label htmlFor={`${uid}-input`}>{label}</label>
        <div className="opt-addrow">
          <input
            id={`${uid}-input`}
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="example.com"
            value={text}
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? `${uid}-err` : undefined}
            onChange={(e) => {
              setText(e.target.value);
              setProblem(null);
            }}
          />
          <Button type="submit" variant="primary" busy={busy}>
            <Plus aria-hidden="true" strokeWidth={2.6} className="opt-btnicon" />
            Add site
          </Button>
        </div>
      </div>
      {problem ? (
        <p id={`${uid}-err`} role="alert" className="opt-error">
          {problem}
        </p>
      ) : null}
    </form>
  );
}
