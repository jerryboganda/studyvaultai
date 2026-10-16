import { useId, useState, type KeyboardEvent } from 'react';
import { Earth, Globe, ListPlus, Plus, ShieldCheck, TriangleAlert, X } from 'lucide-react';
import { DENY_LIST_SCOPE_NOTE, type Settings } from '@shared';
import {
  Button,
  ChoiceCards,
  IconButton,
  InfoTip,
  InlineNotice,
  Wizard,
  editDenyList,
  useAction,
  useToast,
  type WizardStep,
} from '@ui';
import { sitePatternFromInput, sortedDeny } from './model';
import { AddSite } from './DenyList';

type Scope = 'one' | 'some' | 'all';
export type SitePick = { pattern: string; host: string };
export type SitePlan = { scope: 'all' } | { scope: 'sites'; picks: SitePick[] };

const SCOPES = [
  {
    value: 'one' as const,
    label: 'One site',
    hint: 'Type its address',
    icon: Globe,
    tone: 'primary' as const,
  },
  {
    value: 'some' as const,
    label: 'Some sites',
    hint: 'A short list',
    icon: ListPlus,
    tone: 'violet' as const,
  },
  {
    value: 'all' as const,
    label: 'All sites',
    hint: 'Every web page',
    icon: Earth,
    tone: 'warning' as const,
  },
];

/**
 * Site access as a wizard (UX_DESIGN 10): 1 where (one site, some sites, all sites), 2 which sites
 * (or, for all sites, the deny list that keeps it off), 3 what Chrome will be asked. The final
 * button hands the plan to `onFinish` inside its own click, so Chrome's prompt keeps the gesture.
 * "This tab" needs no setting: the popup's button turns StudyVault on for the tab you are on.
 */
export function SiteWizard({
  settings,
  onClose,
  onFinish,
}: {
  settings: Settings;
  onClose(): void;
  onFinish(plan: SitePlan): void;
}) {
  const uid = useId();
  const { announce } = useToast();
  const [scope, setScope] = useState<Scope | null>(null);
  const [text, setText] = useState('');
  const [picks, setPicks] = useState<SitePick[]>([]);
  const [addProblem, setAddProblem] = useState<string | null>(null);
  const stayOff = sortedDeny(settings.denyList);

  const check = (input: string, list: SitePick[]) =>
    sitePatternFromInput(input, {
      denyList: settings.denyList,
      taken: [...settings.persistentOrigins, ...list.map((p) => p.pattern)],
    });
  /** The sites the plan covers: the added chips, plus what is typed if it is a valid site. */
  const chosen = (): SitePick[] => {
    if (scope === 'one') {
      const r = check(text, []);
      return r.ok ? [{ pattern: r.pattern, host: r.host }] : [];
    }
    const r = text.trim() ? check(text, picks) : null;
    return r?.ok ? [...picks, { pattern: r.pattern, host: r.host }] : picks;
  };

  const add = () => {
    const r = check(text, picks);
    if (!r.ok) {
      setAddProblem(r.error);
      return;
    }
    setPicks([...picks, { pattern: r.pattern, host: r.host }]);
    setText('');
    setAddProblem(null);
  };

  const deny = useAction(async (host: string) => {
    await editDenyList((list) => [...list.filter((h) => h !== host), host]);
    announce(`Added ${host} to the deny list.`);
  });

  const field = (error: string | null, errorId: string, onEnter?: () => void) => (
    <div className="sv-textfield">
      <label htmlFor={`${uid}-site`}>Site address</label>
      <input
        id={`${uid}-site`}
        type="text"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        placeholder="example.com"
        value={text}
        aria-invalid={error || addProblem ? true : undefined}
        aria-describedby={error ? errorId : addProblem ? `${uid}-add-err` : undefined}
        onChange={(e) => {
          setText(e.target.value);
          setAddProblem(null);
        }}
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key === 'Enter' && onEnter) {
            e.preventDefault();
            onEnter();
          }
        }}
      />
    </div>
  );

  const whichStep: WizardStep =
    scope === 'all'
      ? {
          id: 'stay-off',
          title: 'Stay off on',
          content: (
            <div className="opt-stack opt-stack--tight">
              {stayOff.length === 0 ? (
                <p className="opt-warnline">
                  <TriangleAlert aria-hidden="true" strokeWidth={2.4} />
                  Your deny list is empty, so sign-in, mail and bank pages are included.
                </p>
              ) : (
                <>
                  <p className="opt-line">
                    Stays off on these {stayOff.length} sites, subdomains too.
                    <InfoTip label="About the deny list" align="start">
                      {DENY_LIST_SCOPE_NOTE}
                    </InfoTip>
                  </p>
                  <div
                    className="opt-scrollbox"
                    role="region"
                    aria-label="Sites on your deny list"
                    tabIndex={0}
                  >
                    <ul className="opt-chiplist">
                      {stayOff.map((host) => (
                        <li key={host} className="opt-chip" dir="ltr">
                          {host}
                        </li>
                      ))}
                    </ul>
                  </div>
                </>
              )}
              <AddSite
                denyList={settings.denyList}
                busy={deny.busy}
                label="Also keep off"
                onAdd={(host) => void deny.run(host)}
              />
              {deny.error ? (
                <InlineNotice tone="error" title="Could not update the deny list">
                  {deny.error}
                </InlineNotice>
              ) : null}
            </div>
          ),
        }
      : scope === 'some'
        ? {
            id: 'sites',
            title: 'Which sites?',
            validate: () => {
              const r = text.trim() ? check(text, picks) : null;
              if (r && !r.ok) return r.error;
              return chosen().length > 0 ? null : 'Add at least one site.';
            },
            content: ({ error, errorId }) => (
              <div className="opt-stack opt-stack--tight">
                <div className="opt-addrow">
                  {field(error, errorId, add)}
                  <Button onClick={add}>
                    <Plus aria-hidden="true" strokeWidth={2.6} className="opt-btnicon" />
                    Add
                  </Button>
                </div>
                {addProblem ? (
                  <p id={`${uid}-add-err`} role="alert" className="opt-error">
                    {addProblem}
                  </p>
                ) : null}
                {picks.length > 0 ? (
                  <ul className="opt-chiplist" aria-label="Sites to turn on">
                    {picks.map((p) => (
                      <li key={p.pattern} className="opt-chip" dir="ltr">
                        {p.host}
                        <IconButton
                          icon={X}
                          size="sm"
                          label={`Remove ${p.host}`}
                          tipSide="top"
                          onClick={() => setPicks(picks.filter((x) => x !== p))}
                        />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ),
          }
        : {
            id: 'site',
            title: 'Which site?',
            validate: () => {
              const r = check(text, []);
              return r.ok ? null : r.error;
            },
            content: ({ error, errorId }) => field(error, errorId),
          };

  const steps: WizardStep[] = [
    {
      id: 'where',
      title: 'Where to run',
      validate: () => (scope ? null : 'Pick one to go on.'),
      content: ({ error, errorId }) => (
        <ChoiceCards
          label="Where to run"
          options={SCOPES}
          value={scope}
          columns={3}
          invalid={Boolean(error)}
          describedBy={error ? errorId : undefined}
          onChange={setScope}
        />
      ),
    },
    whichStep,
    {
      id: 'confirm',
      title: 'Chrome asks',
      content:
        scope === 'all' ? (
          <div className="opt-plan">
            <span className="opt-art opt-art--lg sv-art--warning" aria-hidden="true">
              <Earth strokeWidth={2.4} />
            </span>
            <div className="opt-plan__text">
              <p className="opt-plan__title">Every site</p>
              <p className="sv-muted">
                {stayOff.length === 0
                  ? 'Nothing is kept off.'
                  : `Except ${stayOff.length} on your deny list.`}
              </p>
              <p className="opt-line">
                Chrome shows its own prompt next.
                <InfoTip label="What turning on all sites means" align="start">
                  StudyVault starts by itself on every http and https page, except your deny list.
                  It reads the page text on this device to place your highlights and sends it
                  nowhere.
                  {settings.features.sync
                    ? ' Sync is on, so what you save goes to your server.'
                    : ''}
                </InfoTip>
              </p>
            </div>
          </div>
        ) : (
          <div className="opt-plan">
            <span className="opt-art opt-art--lg sv-art--primary" aria-hidden="true">
              <Globe strokeWidth={2.4} />
            </span>
            <div className="opt-plan__text">
              <ul className="opt-chiplist" aria-label="Sites to turn on">
                {chosen().map((p) => (
                  <li key={p.pattern} className="opt-chip" dir="ltr">
                    {p.host}
                  </li>
                ))}
              </ul>
              <p className="opt-line">
                Chrome shows its own prompt next.
                <InfoTip label="What turning on a site means" align="start">
                  StudyVault starts by itself on these sites and brings your highlights back on
                  every visit. Page text is read on this device only.
                </InfoTip>
              </p>
            </div>
          </div>
        ),
    },
  ];

  return (
    <Wizard
      variant="dialog"
      label="Site access"
      steps={steps}
      dirty={scope !== null}
      onClose={onClose}
      finishLabel="Ask Chrome"
      finishIcon={ShieldCheck}
      onFinish={() => {
        // Synchronous: the plan goes out inside this click (Chrome's prompt needs the gesture).
        onFinish(scope === 'all' ? { scope: 'all' } : { scope: 'sites', picks: chosen() });
      }}
    />
  );
}
