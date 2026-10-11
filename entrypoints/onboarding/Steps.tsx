import { useEffect, useId, useState, type ReactNode, type RefObject } from 'react';
import { browser } from 'wxt/browser';
import { DENY_LIST_SCOPE_NOTE, type Settings } from '@shared';
import { createBank, createFolder, listBankInfos, listFolderTree, type FolderNode } from '@storage';
import {
  Badge,
  Button,
  IN_PAGE_KEYS,
  InlineNotice,
  Kbd,
  COMMAND,
  pickCommands,
  plural,
  shortcutsPageUrl,
  useAction,
  useShortcuts,
} from '@ui';
import { settingsPath } from '@ui/shell/paths';
import type { OnboardingState } from '@ui/shell/onboardingState';
import { openDashboard } from '@ui/vault/dashboardLink';
import { STEP_COUNT, STEP_TITLES, stepIndex } from './model';
import {
  BANK_PRESETS,
  applyPreset,
  describeApplied,
  findPreset,
  includedKeys,
  plannedFolderCount,
  previewRows,
  pruneExcluded,
  setIncluded,
  type ApplyResult,
  type PresetPorts,
} from './presets';
import { TID } from './testids';

export type Update = (mutate: (s: Settings) => Settings) => Promise<unknown>;

// ---------------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------------

/** Step frame: the heading takes focus when the step changes (keyboard and screen-reader users). */
export function StepFrame({
  step,
  heading,
  children,
}: {
  step: keyof typeof STEP_TITLES;
  heading: RefObjectLike;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="ob__step sv-stack" aria-labelledby={id} data-testid={TID.step(step)}>
      <p className="sv-muted sv-small">
        Step {stepIndex(step) + 1} of {STEP_COUNT}
      </p>
      <h2 id={id} ref={heading} tabIndex={-1} className="ob__heading">
        {STEP_TITLES[step]}
      </h2>
      {children}
    </section>
  );
}

type RefObjectLike = RefObject<HTMLHeadingElement | null>;

function StepNav({
  onBack,
  next,
  also,
}: {
  onBack?: (() => void) | undefined;
  next: {
    label: string;
    onClick(): void;
    busy?: boolean;
    disabledReason?: string;
    testId?: string;
  };
  also?: ReactNode;
}) {
  return (
    <div className="ob__nav sv-row">
      {onBack ? (
        <Button data-testid={TID.back} onClick={onBack}>
          Back
        </Button>
      ) : null}
      <Button
        variant="primary"
        busy={next.busy ?? false}
        data-testid={next.testId ?? TID.next}
        {...(next.disabledReason ? { disabledReason: next.disabledReason } : {})}
        onClick={next.onClick}
      >
        {next.label}
      </Button>
      {also}
    </div>
  );
}

function Check({
  label,
  hint,
  checked,
  testId,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  testId: string;
  onChange(next: boolean): void;
}) {
  const id = useId();
  return (
    <div className="sv-check">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        data-testid={testId}
        aria-describedby={`${id}-hint`}
        onChange={(e) => onChange(e.target.checked)}
      />
      <div>
        <label htmlFor={id}>{label}</label>
        <p id={`${id}-hint`} className="sv-muted sv-small">
          {hint}
        </p>
      </div>
    </div>
  );
}

/** One settings write with its own visible error. */
function useWriter(update: Update) {
  const save = useAction(async (mutate: (s: Settings) => Settings) => {
    await update(mutate);
  });
  const error = save.error ? (
    <InlineNotice
      tone="error"
      title="Your choice was not saved"
      action={
        save.retryable ? (
          <Button busy={save.busy} onClick={save.retry}>
            Retry
          </Button>
        ) : undefined
      }
    >
      {save.error}
    </InlineNotice>
  ) : null;
  return { write: (mutate: (s: Settings) => Settings) => void save.run(mutate), error };
}

interface Flow {
  onBack?: (() => void) | undefined;
  onNext(): void;
}

// ---------------------------------------------------------------------------------------------
// 1. Welcome
// ---------------------------------------------------------------------------------------------

export function WelcomeStep({ heading, onNext }: Flow & { heading: RefObjectLike }) {
  return (
    <StepFrame step="welcome" heading={heading}>
      <p>
        StudyVault turns what you read on the web and in PDFs into a personal study library: every
        highlight keeps its exact quote and where it came from, sits in banks and folders you
        choose, can be searched and can be turned into flashcards for spaced review.
      </p>
      <InlineNotice tone="info" title="Everything stays on this device by default">
        <p>
          There is no account, no analytics and no StudyVault server. Highlights, notes, banks,
          cards and review history are stored in this Chrome profile. Nothing is sent anywhere
          unless you turn on an optional feature (AI assistance or sync) and say where it goes.
        </p>
      </InlineNotice>
      <p>
        This short tour has {STEP_COUNT} steps and changes nothing until you press a button that
        says what it does. You can skip it at any point and open it again from Settings.
      </p>
      <StepNav next={{ label: 'Start', onClick: onNext }} />
    </StepFrame>
  );
}

// ---------------------------------------------------------------------------------------------
// 2. Privacy choices
// ---------------------------------------------------------------------------------------------

function Setting({
  title,
  badge,
  children,
}: {
  title: string;
  badge: ReactNode;
  children: ReactNode;
}) {
  return (
    <li className="ob-card sv-stack sv-stack--tight">
      <h3 className="ob-card__title">
        {title} {badge}
      </h3>
      {children}
    </li>
  );
}

export function PrivacyStep({
  heading,
  settings,
  update,
  onBack,
  onNext,
}: Flow & { heading: RefObjectLike; settings: Settings; update: Update }) {
  const { write, error } = useWriter(update);
  const ai = settings.features.ai;
  const sync = settings.features.sync;
  return (
    <StepFrame step="privacy" heading={heading}>
      <p>
        These are the choices that decide what leaves or stays visible. The safe answer is already
        selected for every one of them. Changes here are saved straight away.
      </p>
      <ul className="sv-stack">
        <Setting
          title="AI assistance"
          badge={
            <span data-testid={TID.aiStatus}>
              <Badge tone={ai ? 'warning' : 'success'} glyph={ai ? '!' : '✓'}>
                {ai ? 'On' : 'Off'}
              </Badge>
            </span>
          }
        >
          <p>
            {ai
              ? 'AI assistance is on because you turned it on in Settings. Review its provider, key and limits there.'
              : 'Off. StudyVault sends nothing to any AI provider and every other feature works the same.'}{' '}
            It is never turned on from this tour: in Settings you see exactly which highlights would
            be sent, and to which address, before anything leaves this device.
          </p>
          <p>
            <a href={settingsPath('ai')} target="_blank" rel="noreferrer">
              AI settings (opens in a new tab)
            </a>
          </p>
        </Setting>
        <Setting
          title="Sync between devices"
          badge={
            <span data-testid={TID.syncStatus}>
              <Badge tone={sync ? 'warning' : 'success'} glyph={sync ? '!' : '✓'}>
                {sync ? 'On' : 'Off'}
              </Badge>
            </span>
          }
        >
          <p>
            {sync
              ? 'Sync is on because you turned it on in Settings.'
              : 'Off. Your data stays on this device.'}{' '}
            There is no StudyVault server: sync only ever talks to a server you or someone you trust
            runs, after you sign in there yourself.
          </p>
          <p>
            <a href={settingsPath('sync')} target="_blank" rel="noreferrer">
              Sync settings (opens in a new tab)
            </a>
          </p>
        </Setting>
        <li className="ob-card sv-stack">
          <h3 className="ob-card__title">Private windows</h3>
          <Check
            label="Save highlights from private windows"
            hint="Off by default. Highlights saved in a private (incognito) window are stored in your normal Chrome profile and stay after you close the window, so the window leaves a trace. Chrome also only runs StudyVault in private windows if you allow it on the extension's details page."
            checked={settings.allowIncognitoCapture}
            testId={TID.privateWindows}
            onChange={(allowIncognitoCapture) => write((s) => ({ ...s, allowIncognitoCapture }))}
          />
        </li>
        <li className="ob-card sv-stack">
          <h3 className="ob-card__title">Highlights on web pages</h3>
          <Check
            label="Show highlights on pages"
            hint="On by default, so a passage you saved is marked when you come back. The marks are drawn through the page's shared highlight list, so scripts that a site itself runs can read which passages you marked, and each one's colour and kind. They cannot read your notes, banks or anything else. Turn this off to keep saving and reviewing without marking pages."
            checked={settings.paintHighlights}
            testId={TID.paintHighlights}
            onChange={(paintHighlights) => write((s) => ({ ...s, paintHighlights }))}
          />
        </li>
        <li className="ob-card sv-stack sv-stack--tight">
          <h3 className="ob-card__title">Sites where StudyVault stays off</h3>
          <p>
            Your deny list has {plural(settings.denyList.length, 'site')}. StudyVault is switched
            off on these sites and all of their subdomains: no toolbar, no highlights, nothing
            saved. {DENY_LIST_SCOPE_NOTE}
          </p>
          <p>
            <a href={settingsPath('site-access')} target="_blank" rel="noreferrer">
              Edit the deny list (opens in a new tab)
            </a>
          </p>
        </li>
      </ul>
      {error}
      <StepNav onBack={onBack} next={{ label: 'Next', onClick: onNext }} />
    </StepFrame>
  );
}

// ---------------------------------------------------------------------------------------------
// 3. Site access
// ---------------------------------------------------------------------------------------------

export function AccessStep({ heading, onBack, onNext }: Flow & { heading: RefObjectLike }) {
  return (
    <StepFrame step="access" heading={heading}>
      <p>
        StudyVault reads a page only after you ask. There are three levels, from narrowest to
        widest:
      </p>
      <dl className="ob-modes">
        <div>
          <dt>This tab</dt>
          <dd>
            Click the StudyVault toolbar button and choose &ldquo;Activate on this tab&rdquo;. It
            works in that tab until you navigate away or reload. No extra permission is needed.
          </dd>
        </div>
        <div>
          <dt>This site</dt>
          <dd>
            In the popup choose &ldquo;Always enable on&hellip;&rdquo;. Chrome asks about that one
            site, and your highlights come back every time you visit it.
          </dd>
        </div>
        <div>
          <dt>All sites</dt>
          <dd>
            In Settings, &ldquo;Enable on all sites&rdquo;. StudyVault then starts by itself on
            every http and https page except the sites on your deny list. Most people do not need
            this.
          </dd>
        </div>
      </dl>
      <InlineNotice tone="success" title="Nothing is requested during this tour">
        Chrome shows its own permission prompt only when you press one of those buttons, and you can
        take access back at any time in Settings.
      </InlineNotice>
      <p className="sv-muted">
        PDFs: Chrome&apos;s built-in PDF viewer cannot be marked up by any extension. Use
        &ldquo;Open in StudyVault reader&rdquo; (in the popup, or right-click a PDF link) to read
        and highlight a PDF in StudyVault&apos;s own reader.
      </p>
      <StepNav onBack={onBack} next={{ label: 'Next', onClick: onNext }} />
    </StepFrame>
  );
}

// ---------------------------------------------------------------------------------------------
// 4. Bank presets
// ---------------------------------------------------------------------------------------------

function flatten(
  nodes: readonly FolderNode[],
): Array<{ id: string; name: string; parentFolderId: string | null }> {
  return nodes.flatMap((n) => [
    { id: n.folder.id, name: n.folder.name, parentFolderId: n.folder.parentFolderId },
    ...flatten(n.children),
  ]);
}

/** The real vault behind `applyPreset`. */
export const storagePorts: PresetPorts = {
  listBanks: async () =>
    (await listBankInfos()).map((b) => ({ id: b.id, name: b.name, isInbox: b.isInbox })),
  createBank: (name) => createBank(name),
  listFolders: async (bankId) => flatten(await listFolderTree(bankId)),
  createFolder: (input) => createFolder(input),
};

/** One run at a time, even across two tour tabs: a second run then finds the first one's work. */
async function exclusive<T>(run: () => Promise<T>): Promise<T> {
  return navigator.locks ? navigator.locks.request('studyvault-onboarding-presets', run) : run();
}

export function BanksStep({
  heading,
  state,
  ports = storagePorts,
  onPreset,
  onExcluded,
  onApplied,
  onBack,
  onNext,
}: Flow & {
  heading: RefObjectLike;
  state: OnboardingState;
  ports?: PresetPorts;
  onPreset(id: string): void;
  onExcluded(list: string[]): void;
  onApplied(result: ApplyResult): void;
}) {
  const uid = useId();
  const preset = findPreset(state.preset.id) ?? BANK_PRESETS[0]!;
  const excludedList = pruneExcluded(preset, state.preset.excluded);
  const excluded = new Set(excludedList);
  const rows = previewRows(preset);
  const included = includedKeys(rows, excluded);
  const planned = plannedFolderCount(preset, excluded);
  const [done, setDone] = useState<ApplyResult | null>(null);

  const create = useAction(async () => {
    const result = await exclusive(() => applyPreset(preset, excluded, ports));
    if (result) {
      onApplied(result);
      setDone(result);
    }
  });

  const creates = preset.bank !== null;
  const nothingSelected = creates && !included.has(preset.bank!.name);
  const change = (fn: () => void) => {
    setDone(null);
    create.clear();
    fn();
  };

  return (
    <StepFrame step="banks" heading={heading}>
      <p>
        A bank is a collection of highlights, and folders organise it. Pick a starting point, adjust
        it, and StudyVault creates it for you. You can rename, move or delete anything later in the
        dashboard.
      </p>
      <fieldset className="ob-fieldset">
        <legend>Starting point</legend>
        <div className="sv-stack sv-stack--tight">
          {BANK_PRESETS.map((p) => (
            <label key={p.id} className="sv-check ob-choice">
              <input
                type="radio"
                name={`${uid}-preset`}
                value={p.id}
                checked={preset.id === p.id}
                data-testid={TID.preset(p.id)}
                onChange={() => change(() => onPreset(p.id))}
              />
              <span>
                {p.label} <span className="sv-muted sv-small">{p.description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {creates ? (
        <fieldset className="ob-fieldset">
          <legend>What will be created</legend>
          <p className="sv-muted sv-small">
            Untick anything you do not want. Unticking a folder leaves out the folders inside it
            too.
          </p>
          <ul className="ob-tree" aria-label={`Preview of ${preset.bank!.name}`}>
            {rows.map((row) => {
              const parentOn = row.parentKey === null || included.has(row.parentKey);
              const on = included.has(row.key);
              const id = `${uid}-${row.key}`;
              return (
                <li
                  key={row.key}
                  className="ob-tree__row"
                  style={{ paddingInlineStart: `${row.depth * 20}px` }}
                >
                  <input
                    id={id}
                    type="checkbox"
                    checked={on}
                    disabled={!parentOn}
                    data-testid={TID.node(row.key)}
                    onChange={(e) =>
                      change(() => onExcluded(setIncluded(excludedList, row.key, e.target.checked)))
                    }
                  />
                  <label htmlFor={id}>
                    {row.name}
                    {row.depth === 0 ? <span className="sv-muted sv-small"> (bank)</span> : null}
                    {!parentOn ? (
                      <span className="sv-muted sv-small"> (left out with its parent)</span>
                    ) : null}
                  </label>
                </li>
              );
            })}
          </ul>
          <p className="sv-small" data-testid={TID.plan}>
            {nothingSelected
              ? 'Nothing is selected, so nothing will be created.'
              : `Creates the bank "${preset.bank!.name}" with ${plural(planned, 'folder')}. Anything that already exists is kept and not duplicated.`}
          </p>
        </fieldset>
      ) : (
        <p className="sv-muted">
          Nothing will be created. Your Inbox is always there for quick saves.
        </p>
      )}

      {done ? (
        <InlineNotice tone="success" live title="Done">
          <span data-testid={TID.applied}>{describeApplied(done)}</span>
        </InlineNotice>
      ) : null}
      {create.error ? (
        <InlineNotice
          tone="error"
          title="The bank was not fully created"
          action={
            create.retryable ? (
              <Button busy={create.busy} onClick={create.retry}>
                Try again
              </Button>
            ) : undefined
          }
        >
          {create.error} Whatever was created is kept, and trying again adds only what is missing.
        </InlineNotice>
      ) : null}

      {creates && !done ? (
        <StepNav
          onBack={onBack}
          next={{
            label: 'Create and continue',
            testId: TID.create,
            busy: create.busy,
            ...(nothingSelected ? { disabledReason: 'Tick at least the bank itself.' } : {}),
            onClick: () => void create.run(),
          }}
          also={
            <Button variant="ghost" onClick={onNext}>
              Skip this step
            </Button>
          }
        />
      ) : (
        <StepNav onBack={onBack} next={{ label: 'Next', onClick: onNext }} />
      )}
    </StepFrame>
  );
}

// ---------------------------------------------------------------------------------------------
// 5. Theme and density
// ---------------------------------------------------------------------------------------------

const THEMES = [
  { id: 'system', label: 'Match my system', hint: 'Follows your operating system setting.' },
  { id: 'light', label: 'Light', hint: 'Always light.' },
  { id: 'dark', label: 'Dark', hint: 'Always dark.' },
] as const;

const DENSITIES = [
  { id: 'comfortable', label: 'Comfortable', hint: 'More space around rows and buttons.' },
  { id: 'compact', label: 'Compact', hint: 'Fits more highlights on screen.' },
] as const;

export function LookStep({
  heading,
  settings,
  update,
  onBack,
  onNext,
}: Flow & { heading: RefObjectLike; settings: Settings; update: Update }) {
  const uid = useId();
  const { write, error } = useWriter(update);
  return (
    <StepFrame step="look" heading={heading}>
      <fieldset className="ob-fieldset">
        <legend>Theme</legend>
        <div className="sv-stack sv-stack--tight">
          {THEMES.map((t) => (
            <label key={t.id} className="sv-check ob-choice">
              <input
                type="radio"
                name={`${uid}-theme`}
                checked={settings.theme === t.id}
                data-testid={TID.theme(t.id)}
                onChange={() => write((s) => ({ ...s, theme: t.id }))}
              />
              <span>
                {t.label} <span className="sv-muted sv-small">{t.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="ob-fieldset">
        <legend>Density</legend>
        <div className="sv-stack sv-stack--tight">
          {DENSITIES.map((d) => (
            <label key={d.id} className="sv-check ob-choice">
              <input
                type="radio"
                name={`${uid}-density`}
                checked={settings.density === d.id}
                data-testid={TID.density(d.id)}
                onChange={() => write((s) => ({ ...s, density: d.id }))}
              />
              <span>
                {d.label} <span className="sv-muted sv-small">{d.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="sv-muted sv-small">
          Density applies to the dashboard and to the toolbar on pages. Colours for each highlight
          kind can be changed in Settings.
        </p>
      </fieldset>
      {error}
      <StepNav onBack={onBack} next={{ label: 'Next', onClick: onNext }} />
    </StepFrame>
  );
}

// ---------------------------------------------------------------------------------------------
// 6. Keyboard shortcuts
// ---------------------------------------------------------------------------------------------

export function KeysStep({ heading, onBack, onNext }: Flow & { heading: RefObjectLike }) {
  const { commands, error, retry } = useShortcuts();
  const open = useAction(async () => {
    // chrome:// pages cannot be linked from an extension page; they can be opened as a new tab.
    await browser.tabs.create({ url: shortcutsPageUrl(navigator.userAgent) });
  });
  return (
    <StepFrame step="keys" heading={heading}>
      <p>
        These keys work from any tab. They are read from Chrome right now, so a key you changed or
        cleared there is shown as it is. Chrome decides which keys an extension may use.
      </p>
      {error ? (
        <InlineNotice
          tone="error"
          title="Could not read the current shortcuts"
          action={<Button onClick={retry}>Retry</Button>}
        >
          {error}
        </InlineNotice>
      ) : commands === null ? (
        <p className="sv-muted">Reading the current shortcuts…</p>
      ) : (
        <ul className="ob-keys" aria-label="Keyboard shortcuts" data-testid={TID.shortcuts}>
          {commands.map((c) => (
            <li key={c.name} className="ob-keys__row">
              <span className="sv-grow">{c.description || c.name}</span>
              <Kbd shortcut={c.shortcut} />
            </li>
          ))}
          {IN_PAGE_KEYS.map((k) => (
            <li key={k.keys} className="ob-keys__row">
              <span className="sv-grow">{k.action} (while the page has focus)</span>
              <Kbd shortcut={k.keys} />
            </li>
          ))}
        </ul>
      )}
      <div className="sv-stack sv-stack--tight">
        <div>
          <Button busy={open.busy} onClick={() => void open.run()}>
            Change shortcuts in Chrome
          </Button>
        </div>
        {open.error ? (
          <InlineNotice tone="error" title="Could not open the shortcuts page">
            {open.error}
          </InlineNotice>
        ) : null}
      </div>
      <StepNav onBack={onBack} next={{ label: 'Next', onClick: onNext }} />
    </StepFrame>
  );
}

// ---------------------------------------------------------------------------------------------
// 7. Finish
// ---------------------------------------------------------------------------------------------

export function DoneStep({
  heading,
  state,
  onBack,
  onFinish,
}: {
  heading: RefObjectLike;
  state: OnboardingState;
  onBack(): void;
  onFinish(): void;
}) {
  const { commands } = useShortcuts();
  /** The window this tour is in: null while asking, 'unknown' when Chrome did not say. */
  const [windowId, setWindowId] = useState<number | 'unknown' | null>(null);
  // Read ahead of the click: chrome.sidePanel.open must be the first thing the click handler does.
  useEffect(() => {
    let live = true;
    browser.windows.getCurrent().then(
      (w) => {
        if (live) setWindowId(w.id ?? 'unknown');
      },
      () => {
        if (live) setWindowId('unknown');
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const [opened, setOpened] = useState(false);
  const open = useAction(async () => {
    if (typeof windowId !== 'number') throw new Error('Chrome did not say which window this is.');
    await browser.sidePanel.open({ windowId });
    setOpened(true);
  });
  const panelKey = pickCommands(commands ?? [], [COMMAND.openSidePanel])[0];
  const applied = state.applied;

  return (
    <StepFrame step="done" heading={heading}>
      {applied ? (
        <p data-testid={TID.summary}>
          {applied.createdBank
            ? `Your bank "${applied.bankName}" is ready with ${plural(applied.createdFolders, 'folder')}.`
            : `Your bank "${applied.bankName}" is ready.`}
        </p>
      ) : null}
      <h3>Open the side panel</h3>
      <p>The side panel is where you read, edit and organise what you save while you browse.</p>
      <ol className="ob-steps">
        <li>
          Click the StudyVault icon in the Chrome toolbar (pin it from the puzzle-piece menu if you
          do not see it), then choose <strong>Open side panel</strong>.
        </li>
        <li>
          Or press <Kbd shortcut={panelKey?.shortcut ?? ''} /> from any tab.
        </li>
        <li>
          Select text on a page you have enabled and use the small StudyVault toolbar to save it.
        </li>
      </ol>
      <div className="sv-stack sv-stack--tight">
        <div>
          <Button
            data-testid={TID.openPanel}
            busy={open.busy}
            {...(windowId === null ? { disabledReason: 'Looking up this window…' } : {})}
            onClick={() => void open.run()}
          >
            Open the side panel now
          </Button>
        </div>
        {opened ? (
          <p role="status" className="sv-muted">
            The side panel is open next to this tab.
          </p>
        ) : null}
        {open.error ? (
          <InlineNotice tone="error" title="Could not open the side panel">
            {open.error} You can open it from the toolbar icon instead.
          </InlineNotice>
        ) : null}
      </div>
      <StepNav
        onBack={onBack}
        next={{ label: 'Finish', testId: TID.finish, onClick: onFinish }}
        also={
          <Button variant="ghost" onClick={() => void openDashboard()}>
            Open the dashboard
          </Button>
        }
      />
    </StepFrame>
  );
}
