import { useEffect, useId, useState, type ReactNode, type RefObject } from 'react';
import { browser } from 'wxt/browser';
import {
  AppWindow,
  ArrowLeft,
  ArrowRight,
  Ban,
  Bike,
  Bookmark,
  Check,
  ChevronDown,
  Coffee,
  EyeOff,
  Flame,
  FolderTree,
  Gamepad2,
  Globe,
  GraduationCap,
  HardDrive,
  Highlighter,
  Inbox,
  Keyboard,
  Layers,
  Library,
  Monitor,
  Moon,
  MousePointerClick,
  PanelRight,
  Plus,
  Power,
  Puzzle,
  RefreshCw,
  Rocket,
  Rows2,
  Rows4,
  ScanLine,
  Settings as SettingsIcon,
  Sparkles,
  Stethoscope,
  Sun,
  TextSelect,
  Trophy,
  UserX,
  VenetianMask,
  type LucideIcon,
} from 'lucide-react';
import { DENY_LIST_SCOPE_NOTE, type Settings } from '@shared';
import {
  createBank,
  createFolder,
  listBankInfos,
  listFolderTree,
  setDailyGoal,
  setGameMode,
  type FolderNode,
} from '@storage';
import {
  AsyncSwitch,
  Badge,
  Button,
  ChunkyButton,
  IN_PAGE_KEYS,
  InfoTip,
  InlineNotice,
  Kbd,
  COMMAND,
  VaultBuddy,
  pickCommands,
  plural,
  shortcutsPageUrl,
  useAction,
  useShortcuts,
  type ArtTone,
  type BuddyPose,
  type ChunkyButtonProps,
} from '@ui';
import {
  DAILY_GOALS,
  DEFAULT_DAILY_GOAL,
  XP,
  type DailyGoal,
  type GameState,
  useGame,
} from '@ui/game';
import { settingsPath } from '@ui/shell/paths';
import type { OnboardingState } from '@ui/shell/onboardingState';
import { STEP_TITLES } from './model';
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
  type PresetId,
  type PresetPorts,
  type PreviewRow,
} from './presets';
import { TID } from './testids';

export type Update = (mutate: (s: Settings) => Settings) => Promise<unknown>;

// ---------------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------------

type RefObjectLike = RefObject<HTMLHeadingElement | null>;

/**
 * One step: the mascot with a one-line speech bubble (title, optional (i), one helper line), the
 * step's single decision, then Back / Next. The heading takes focus when the step changes.
 */
export function StepFrame({
  step,
  heading,
  pose = 'think',
  line,
  tip,
  center = false,
  nav,
  children,
}: {
  step: keyof typeof STEP_TITLES;
  heading: RefObjectLike;
  pose?: BuddyPose;
  line?: string;
  tip?: { label: string; text: ReactNode };
  center?: boolean;
  nav: ReactNode;
  children?: ReactNode;
}) {
  const id = useId();
  const title = (
    <div className="ob__titleRow">
      <h2 id={id} ref={heading} tabIndex={-1} className="ob__title">
        {STEP_TITLES[step]}
      </h2>
      {tip ? (
        <InfoTip label={tip.label} align={center ? 'center' : 'start'}>
          {tip.text}
        </InfoTip>
      ) : null}
    </div>
  );
  return (
    <section
      className={`ob__step${center ? ' ob__step--center' : ''}`}
      aria-labelledby={id}
      data-testid={TID.step(step)}
    >
      {center ? (
        <div className="ob__hero">
          <VaultBuddy pose={pose} size={140} className="ob__buddy" />
          {title}
          {line ? <p className="ob__line">{line}</p> : null}
        </div>
      ) : (
        <div className="ob__intro">
          <VaultBuddy pose={pose} size={96} className="ob__buddy" />
          <div className="ob__bubble">
            {title}
            {line ? <p className="ob__line">{line}</p> : null}
          </div>
        </div>
      )}
      <div className="ob__body">{children}</div>
      {nav}
    </section>
  );
}

type NextButton = {
  label: string;
  onClick(): void;
  busy?: boolean;
  disabledReason?: string;
  testId?: string;
  variant?: ChunkyButtonProps['variant'];
  icon?: LucideIcon;
};

/** Back (disabled with its reason on the first step), an optional extra, then the main action. */
function StepNav({
  onBack,
  next,
  also,
}: {
  onBack?: (() => void) | undefined;
  next: NextButton;
  also?: ReactNode;
}) {
  const busy = next.busy ?? false;
  return (
    <div className="ob__nav">
      <ChunkyButton
        size="lg"
        icon={ArrowLeft}
        data-testid={TID.back}
        {...(onBack ? { onClick: onBack } : { disabledReason: 'This is the first step' })}
      >
        Back
      </ChunkyButton>
      <span className="ob__spacer" />
      {also}
      <ChunkyButton
        size="lg"
        variant={next.variant ?? 'primary'}
        data-testid={next.testId ?? TID.next}
        aria-busy={busy || undefined}
        {...(next.icon ? { icon: next.icon } : {})}
        {...(next.disabledReason ? { disabledReason: next.disabledReason } : {})}
        onClick={() => {
          if (!busy) next.onClick();
        }}
      >
        {next.label}
      </ChunkyButton>
    </div>
  );
}

interface PickOption<T extends string> {
  value: T;
  /** <= 2 words. */
  label: string;
  /** <= 3 words. */
  hint?: string;
  icon: LucideIcon;
  tone: ArtTone;
  tag?: string;
  testId?: string;
}

/**
 * Picture cards over native radios (UX_DESIGN 6.11), drawn with the shared `.sv-choice` styles.
 * Local rather than `ChoiceCards` because the tour's radios carry `data-testid`s and a tag.
 */
function PickCards<T extends string>({
  legend,
  showLegend = false,
  options,
  value,
  onChange,
  columns,
}: {
  legend: string;
  showLegend?: boolean;
  options: readonly PickOption<T>[];
  value: T;
  onChange(value: T): void;
  columns: 2 | 3 | 4;
}) {
  const name = useId();
  return (
    <fieldset className="sv-choiceset ob-picks">
      <legend className={showLegend ? 'ob-legend' : 'sv-vh'}>{legend}</legend>
      <div className={`sv-choices sv-choices--${columns}`}>
        {options.map(({ value: v, label, hint, icon: Icon, tone, tag, testId }) => (
          <label key={v} className="sv-choice">
            <input
              type="radio"
              className="ob-pick__input"
              name={name}
              value={v}
              checked={v === value}
              data-testid={testId}
              onChange={() => onChange(v)}
            />
            <span className="sv-choice__check" aria-hidden="true">
              <Check strokeWidth={3.5} />
            </span>
            <span className={`sv-choice__art sv-art--${tone}`} aria-hidden="true">
              <Icon strokeWidth={2.4} />
            </span>
            <span className="sv-choice__text">
              <span className="sv-choice__label">{label}</span>
              {hint ? <span className="sv-choice__hint">{hint}</span> : null}
              {tag ? <span className="ob-tag">{tag}</span> : null}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * A small secondary choice under a step's main one: pill radios with an icon and a tick on the
 * picked one (so the pick never rests on colour alone).
 */
function PickPills<T extends string>({
  legend,
  options,
  value,
  onChange,
}: {
  legend: string;
  options: readonly PickOption<T>[];
  value: T;
  onChange(value: T): void;
}) {
  const name = useId();
  return (
    <fieldset className="sv-choiceset ob-picks">
      <legend className="ob-legend">{legend}</legend>
      <div className="ob-pills">
        {options.map(({ value: v, label, icon: Icon, testId }) => (
          <label key={v} className="ob-pill">
            <input
              type="radio"
              className="ob-pick__input"
              name={name}
              value={v}
              checked={v === value}
              data-testid={testId}
              onChange={() => onChange(v)}
            />
            <Icon aria-hidden="true" strokeWidth={2.4} />
            {label}
            <Check aria-hidden="true" strokeWidth={3.5} className="ob-pill__tick" />
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** A row of picture tiles (icon, short label, optional key), numbered when they are a sequence. */
function Tiles({
  label,
  items,
  numbered = false,
}: {
  label: string;
  items: ReadonlyArray<{ icon: LucideIcon; tone: ArtTone; label: string; key?: string }>;
  numbered?: boolean;
}) {
  const List = numbered ? 'ol' : 'ul';
  return (
    <List className="ob-try" aria-label={label}>
      {items.map(({ icon: Icon, tone, label: text, key }, i) => (
        <li key={text} className="ob-try__step">
          <span className={`ob-try__art sv-art--${tone}`} aria-hidden="true">
            <Icon strokeWidth={2.4} />
            {numbered ? <span className="ob-try__num">{i + 1}</span> : null}
          </span>
          <span className="ob-try__label">{text}</span>
          {key ? <Kbd shortcut={key} /> : null}
        </li>
      ))}
    </List>
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
// 1. Welcome and daily goal
// ---------------------------------------------------------------------------------------------

export const GOAL_NAMES: Record<DailyGoal, string> = {
  10: 'Casual',
  30: 'Regular',
  50: 'Serious',
  100: 'Intense',
};

const GOAL_LOOK: Record<DailyGoal, { icon: LucideIcon; tone: ArtTone }> = {
  10: { icon: Coffee, tone: 'success' },
  30: { icon: Bike, tone: 'primary' },
  50: { icon: Rocket, tone: 'violet' },
  100: { icon: Flame, tone: 'danger' },
};

const GOAL_PICKS: PickOption<`${DailyGoal}`>[] = DAILY_GOALS.map((g) => ({
  value: `${g}`,
  label: GOAL_NAMES[g],
  hint: `${g} XP a day`,
  ...GOAL_LOOK[g],
  ...(g === DEFAULT_DAILY_GOAL ? { tag: 'Suggested' } : {}),
}));

/** How XP is earned (ADR-022): the engine's own numbers. */
const EARN = [
  { icon: Layers, label: 'Review', xp: XP.review, tone: 'primary' },
  { icon: Bookmark, label: 'Save', xp: XP.save, tone: 'sun' },
  { icon: Plus, label: 'New card', xp: XP.card, tone: 'violet' },
  { icon: Trophy, label: 'Session', xp: XP.session, tone: 'success' },
] as const;

const PROMISES = [
  { icon: HardDrive, label: 'On this device' },
  { icon: UserX, label: 'No account' },
  { icon: EyeOff, label: 'No tracking' },
] as const;

/** What StudyVault does, shown in place of the goal when Game mode is off. */
const WHAT_IT_DOES = [
  { icon: Highlighter, tone: 'sun', label: 'Save quotes' },
  { icon: Library, tone: 'primary', label: 'Sort into banks' },
  { icon: Layers, tone: 'success', label: 'Review as cards' },
] as const;

/**
 * The goal to write when the person presses Start, or null for none: the card they picked unless
 * it is already the stored choice; with no pick, the suggested goal on a ledger that has never had
 * one chosen (pressing Start accepts it). Nothing while the ledger is unknown or Game mode is off.
 */
export function goalToWrite(
  data: GameState | undefined,
  picked: DailyGoal | null,
): DailyGoal | null {
  if (!data?.mode) return null;
  if (picked !== null) {
    return data.ready && data.goal.chosen && data.goal.value === picked ? null : picked;
  }
  return data.ready && !data.goal.chosen ? data.goal.value : null;
}

export function WelcomeStep({ heading, onNext }: Flow & { heading: RefObjectLike }) {
  // The ledger is read only on the two steps that show it, not while banks are being created.
  const game = useGame();
  const [picked, setPicked] = useState<DailyGoal | null>(null);
  const data = game.data;
  const showGoal = data?.mode === true;
  const shown = picked ?? (data?.ready ? data.goal.value : DEFAULT_DAILY_GOAL);
  const start = useAction(async () => {
    const goal = goalToWrite(data, picked);
    if (goal !== null) await setDailyGoal(goal);
    onNext();
  });

  return (
    <StepFrame
      step="welcome"
      heading={heading}
      pose="wave"
      line={
        showGoal ? 'Pick a daily goal. Change it any time.' : 'Save, sort and review what you read.'
      }
      tip={{
        label: 'About StudyVault',
        text: 'Save quotes from web pages and PDFs, sort them into banks and review them as cards. Everything stays in this Chrome profile: no account, no server, no analytics.',
      }}
      nav={
        <StepNav
          next={{
            label: 'Start',
            busy: start.busy,
            onClick: () => void start.run(),
          }}
        />
      }
    >
      {showGoal ? (
        <>
          <PickCards
            legend="Daily goal"
            options={GOAL_PICKS}
            value={`${shown}`}
            columns={4}
            onChange={(v) => setPicked(Number(v) as DailyGoal)}
          />
          <ul className="ob-chips" aria-label="How you earn XP">
            <li className="ob-chips__label" aria-hidden="true">
              Earn XP
            </li>
            {EARN.map(({ icon: Icon, label, xp, tone }) => (
              <li key={label} className={`ob-chip sv-art--${tone}`}>
                <Icon aria-hidden="true" strokeWidth={2.4} />
                {label} +{xp}
              </li>
            ))}
          </ul>
        </>
      ) : data === undefined && !game.error ? (
        <p className="sv-muted" role="status">
          Loading your goal…
        </p>
      ) : (
        <Tiles label="What StudyVault does" items={WHAT_IT_DOES} />
      )}
      {game.error ? (
        <InlineNotice
          tone="warning"
          title="Daily goal unavailable"
          action={<Button onClick={game.reload}>Retry</Button>}
        >
          {game.error} You can set it later in Settings.
        </InlineNotice>
      ) : null}
      <ul className="ob-chips ob-chips--quiet" aria-label="Your privacy">
        {PROMISES.map(({ icon: Icon, label }) => (
          <li key={label} className="ob-chip ob-chip--quiet">
            <Icon aria-hidden="true" strokeWidth={2.4} />
            {label}
          </li>
        ))}
      </ul>
      {start.error ? (
        <InlineNotice
          tone="error"
          title="Your goal was not saved"
          action={
            start.retryable ? (
              <Button busy={start.busy} onClick={start.retry}>
                Retry
              </Button>
            ) : undefined
          }
        >
          {start.error}
        </InlineNotice>
      ) : null}
    </StepFrame>
  );
}

// ---------------------------------------------------------------------------------------------
// 2. Privacy choices
// ---------------------------------------------------------------------------------------------

/** A setting as a card: art tile, two-word label, one short line, (i) with the detail, switch. */
function SwitchCard({
  icon: Icon,
  tone,
  label,
  hint,
  detail,
  checked,
  testId,
  onChange,
}: {
  icon: LucideIcon;
  tone: ArtTone;
  label: string;
  hint: string;
  detail: string;
  checked: boolean;
  testId: string;
  onChange(next: boolean): void;
}) {
  const id = useId();
  return (
    <div className="ob-tcard">
      <span className={`ob-tcard__art sv-art--${tone}`} aria-hidden="true">
        <Icon strokeWidth={2.4} />
      </span>
      <span className="ob-tcard__text">
        <label htmlFor={id} className="ob-tcard__label">
          {label}
        </label>
        <span className="ob-tcard__hint">{hint}</span>
      </span>
      <InfoTip label={`About ${label.toLowerCase()}`} align="end">
        {detail}
      </InfoTip>
      <span className="sv-check">
        <input
          id={id}
          type="checkbox"
          className="sv-switch"
          checked={checked}
          data-testid={testId}
          aria-describedby={`${id}-detail`}
          onChange={(e) => onChange(e.target.checked)}
        />
      </span>
      {/* The whole explanation, spoken with the switch; seen through the (i). */}
      <span id={`${id}-detail`} hidden>
        {detail}
      </span>
    </div>
  );
}

/** An optional feature or list as a tile linking to its Settings section. */
function StatusTile({
  icon: Icon,
  label,
  href,
  children,
}: {
  icon: LucideIcon;
  label: string;
  href: string;
  children: ReactNode;
}) {
  return (
    <li>
      <a className="ob-stat" href={href} target="_blank" rel="noreferrer">
        <Icon aria-hidden="true" strokeWidth={2.4} className="ob-stat__icon" />
        <span className="ob-stat__label">{label}</span>
        <span className="ob-stat__value">{children}</span>
        <span className="sv-vh"> (opens Settings in a new tab)</span>
      </a>
    </li>
  );
}

function OnOff({ on, testId }: { on: boolean; testId: string }) {
  return (
    <span data-testid={testId}>
      <Badge tone={on ? 'warning' : 'success'} glyph={on ? '!' : '✓'}>
        {on ? 'On' : 'Off'}
      </Badge>
    </span>
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
  const { ai, sync } = settings.features;
  return (
    <StepFrame
      step="privacy"
      heading={heading}
      line="The safe answer is already selected."
      tip={{
        label: 'About these choices',
        text: 'Changes save at once and can be changed later in Settings. AI and sync are never turned on from this tour.',
      }}
      nav={<StepNav onBack={onBack} next={{ label: 'Next', onClick: onNext }} />}
    >
      <div className="ob-tcards">
        <SwitchCard
          icon={VenetianMask}
          tone="violet"
          label="Private windows"
          hint="Save in incognito too"
          detail="Off by default. Highlights saved in a private (incognito) window are stored in your normal Chrome profile and stay after you close the window, so the window leaves a trace. Chrome also only runs StudyVault in private windows if you allow it on the extension's details page."
          checked={settings.allowIncognitoCapture}
          testId={TID.privateWindows}
          onChange={(allowIncognitoCapture) => write((s) => ({ ...s, allowIncognitoCapture }))}
        />
        <SwitchCard
          icon={Highlighter}
          tone="sun"
          label="Show highlights"
          hint="Mark saved passages"
          detail="On by default, so a passage you saved is marked when you come back. The marks are drawn through the page's shared highlight list, so scripts that a site itself runs can read which passages you marked, and each one's colour and kind. They cannot read your notes, banks or anything else. Turn this off to keep saving and reviewing without marking pages."
          checked={settings.paintHighlights}
          testId={TID.paintHighlights}
          onChange={(paintHighlights) => write((s) => ({ ...s, paintHighlights }))}
        />
      </div>
      <div className="ob-stats">
        <ul className="ob-stats__list" aria-label="Optional features">
          <StatusTile icon={Sparkles} label="AI" href={settingsPath('ai')}>
            <OnOff on={ai} testId={TID.aiStatus} />
          </StatusTile>
          <StatusTile icon={RefreshCw} label="Sync" href={settingsPath('sync')}>
            <OnOff on={sync} testId={TID.syncStatus} />
          </StatusTile>
          <StatusTile icon={Ban} label="Blocked sites" href={settingsPath('site-access')}>
            <Badge tone="neutral">{plural(settings.denyList.length, 'site')}</Badge>
          </StatusTile>
        </ul>
        <InfoTip label="About AI, sync and blocked sites" align="end">
          {ai || sync
            ? 'You turned on AI or sync in Settings; review them there. '
            : 'AI and sync stay off until you set them up in Settings; there is no StudyVault server. '}
          StudyVault stays off on blocked sites and their subdomains. {DENY_LIST_SCOPE_NOTE}
        </InfoTip>
      </div>
      {error}
    </StepFrame>
  );
}

// ---------------------------------------------------------------------------------------------
// 3. Site access
// ---------------------------------------------------------------------------------------------

export type Access = 'tab' | 'site' | 'all';

const ACCESS_PICKS: PickOption<Access>[] = [
  { value: 'tab', label: 'This tab', hint: 'When you click', icon: MousePointerClick, tone: 'sun' },
  { value: 'site', label: 'One site', hint: 'Every visit', icon: AppWindow, tone: 'primary' },
  // The broadest grant gets a plain globe and a caution tone, never a "safe" shield.
  { value: 'all', label: 'All sites', hint: 'Everywhere', icon: Globe, tone: 'warning' },
];

/** Where each level is switched on later: two taps, drawn as a path (the popup's own labels). */
const ACCESS_HOW: Record<Access, Array<{ icon: LucideIcon; label: string }>> = {
  tab: [
    { icon: Puzzle, label: 'Toolbar icon' },
    { icon: Power, label: 'Turn on' },
  ],
  site: [
    { icon: Puzzle, label: 'Toolbar icon' },
    { icon: Check, label: 'Always on' },
  ],
  all: [
    { icon: SettingsIcon, label: 'Settings' },
    { icon: Globe, label: 'Site access' },
  ],
};

/** `access` is held by the tour, so Back keeps it and the last step can show it. */
export function AccessStep({
  heading,
  access,
  onAccess,
  onBack,
  onNext,
}: Flow & { heading: RefObjectLike; access: Access; onAccess(access: Access): void }) {
  return (
    <StepFrame
      step="access"
      heading={heading}
      line="Nothing is requested during this tour."
      tip={{
        label: 'About site access',
        text: 'StudyVault reads a page only after you ask, and Chrome shows its own prompt for a site or for all sites. Take access back any time in Settings. For PDFs, use Open in StudyVault reader.',
      }}
      nav={<StepNav onBack={onBack} next={{ label: 'Next', onClick: onNext }} />}
    >
      <PickCards
        legend="Site access"
        options={ACCESS_PICKS}
        value={access}
        columns={3}
        onChange={onAccess}
      />
      <div className="ob-how">
        <span className="ob-how__label">Later</span>
        <ol className="ob-how__path" aria-label="How to turn it on">
          {ACCESS_HOW[access].map(({ icon: Icon, label }, i) => (
            <li key={label} className="ob-how__stop">
              {i > 0 ? <ArrowRight aria-hidden="true" className="ob-how__arrow" /> : null}
              <span className="ob-chip ob-chip--quiet">
                <Icon aria-hidden="true" strokeWidth={2.4} />
                {label}
              </span>
            </li>
          ))}
        </ol>
        {access === 'all' ? (
          <a
            className="sv-chunky sv-chunky--secondary sv-chunky--sm"
            href={settingsPath('site-access')}
            target="_blank"
            rel="noreferrer"
          >
            Open Settings<span className="sv-vh"> (new tab)</span>
          </a>
        ) : null}
      </div>
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

const PRESET_LOOK: Record<PresetId, { label: string; icon: LucideIcon; tone: ArtTone }> = {
  blank: { label: 'Blank', icon: Inbox, tone: 'neutral' },
  general: { label: 'General study', icon: GraduationCap, tone: 'primary' },
  medicine: { label: 'Medicine', icon: Stethoscope, tone: 'danger' },
  radiology: { label: 'Radiology', icon: ScanLine, tone: 'violet' },
};

const PRESET_PICKS: PickOption<PresetId>[] = BANK_PRESETS.map((p) => ({
  value: p.id,
  ...PRESET_LOOK[p.id],
  hint: p.bank ? plural(plannedFolderCount(p, new Set()), 'folder') : 'Inbox only',
  testId: TID.preset(p.id),
}));

/**
 * The preset's folders as nested checkbox lists, so the hierarchy is in the markup (screen readers
 * hear the nesting) and not only in the indent. A row under an unticked parent is disabled and
 * dimmed; why is spoken with it.
 */
function FolderChecklist({
  label,
  rows,
  parentKey,
  included,
  uid,
  onToggle,
}: {
  label?: string;
  rows: readonly PreviewRow[];
  parentKey: string | null;
  included: ReadonlySet<string>;
  uid: string;
  onToggle(key: string, on: boolean): void;
}) {
  const parentOn = parentKey === null || included.has(parentKey);
  return (
    <ul className="ob-tree" aria-label={label}>
      {rows
        .filter((row) => row.parentKey === parentKey)
        .map((row) => {
          const id = `${uid}-${row.key}`;
          return (
            <li key={row.key}>
              <span className={`ob-tree__row${parentOn ? '' : ' ob-tree__row--off'}`}>
                <input
                  id={id}
                  type="checkbox"
                  checked={included.has(row.key)}
                  disabled={!parentOn}
                  data-testid={TID.node(row.key)}
                  onChange={(e) => onToggle(row.key, e.target.checked)}
                />
                <label htmlFor={id}>
                  {row.name}
                  {row.depth === 0 ? <span className="sv-muted sv-small"> (bank)</span> : null}
                  {!parentOn ? <span className="sv-vh"> (left out with its parent)</span> : null}
                </label>
              </span>
              {row.hasChildren ? (
                <FolderChecklist
                  rows={rows}
                  parentKey={row.key}
                  included={included}
                  uid={uid}
                  onToggle={onToggle}
                />
              ) : null}
            </li>
          );
        })}
    </ul>
  );
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
  // Folders start folded away; a tour resumed with folders left out shows them.
  const [treeOpen] = useState(excludedList.length > 0);

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
    <StepFrame
      step="banks"
      heading={heading}
      line="Pick one. Rename or delete it later."
      tip={{
        label: 'About banks',
        text: 'A bank holds your highlights and folders sort it. Anything that already exists is kept and never duplicated. The Inbox is always there for quick saves.',
      }}
      nav={
        creates && !done ? (
          <StepNav
            onBack={onBack}
            next={{
              label: 'Create bank',
              icon: Plus,
              testId: TID.create,
              busy: create.busy,
              ...(nothingSelected ? { disabledReason: 'Tick at least the bank itself.' } : {}),
              onClick: () => void create.run(),
            }}
            also={
              <ChunkyButton size="lg" variant="ghost" onClick={onNext}>
                Skip step
              </ChunkyButton>
            }
          />
        ) : (
          <StepNav onBack={onBack} next={{ label: 'Next', onClick: onNext }} />
        )
      }
    >
      <PickCards
        legend="Starter bank"
        options={PRESET_PICKS}
        value={preset.id}
        columns={4}
        onChange={(id) => change(() => onPreset(id))}
      />

      {creates ? (
        <div className="ob-plan">
          <p className="ob-plan__line" data-testid={TID.plan}>
            <Library aria-hidden="true" strokeWidth={2.4} />
            <span>
              {nothingSelected
                ? 'Nothing is selected, so nothing will be created.'
                : `"${preset.bank!.name}" with ${plural(planned, 'folder')}`}
            </span>
          </p>
          <details className="ob-folders" open={treeOpen}>
            <summary className="ob-disclose">
              <FolderTree aria-hidden="true" strokeWidth={2.4} />
              Choose folders
              <ChevronDown aria-hidden="true" strokeWidth={2.4} className="ob-disclose__chev" />
            </summary>
            <FolderChecklist
              label={`Preview of ${preset.bank!.name}`}
              rows={rows}
              parentKey={null}
              included={included}
              uid={uid}
              onToggle={(key, on) => change(() => onExcluded(setIncluded(excludedList, key, on)))}
            />
          </details>
        </div>
      ) : null}

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
    </StepFrame>
  );
}

// ---------------------------------------------------------------------------------------------
// 5. Theme and density
// ---------------------------------------------------------------------------------------------

const THEME_PICKS: PickOption<Settings['theme']>[] = [
  {
    value: 'system',
    label: 'System',
    hint: 'Match my device',
    icon: Monitor,
    tone: 'neutral',
    testId: TID.theme('system'),
  },
  {
    value: 'light',
    label: 'Light',
    hint: 'Always light',
    icon: Sun,
    tone: 'sun',
    testId: TID.theme('light'),
  },
  {
    value: 'dark',
    label: 'Dark',
    hint: 'Always dark',
    icon: Moon,
    tone: 'violet',
    testId: TID.theme('dark'),
  },
];

const DENSITY_PICKS: PickOption<Settings['density']>[] = [
  {
    value: 'comfortable',
    label: 'Comfortable',
    icon: Rows2,
    tone: 'primary',
    testId: TID.density('comfortable'),
  },
  {
    value: 'compact',
    label: 'Compact',
    icon: Rows4,
    tone: 'primary',
    testId: TID.density('compact'),
  },
];

export function LookStep({
  heading,
  settings,
  update,
  onBack,
  onNext,
}: Flow & { heading: RefObjectLike; settings: Settings; update: Update }) {
  const { write, error } = useWriter(update);
  return (
    <StepFrame
      step="look"
      heading={heading}
      line="It changes right away."
      tip={{
        label: 'About the look',
        text: 'Density applies to the dashboard and to the toolbar on pages. Colours for each highlight kind can be changed in Settings.',
      }}
      nav={<StepNav onBack={onBack} next={{ label: 'Next', onClick: onNext }} />}
    >
      <PickCards
        legend="Theme"
        showLegend
        options={THEME_PICKS}
        value={settings.theme}
        columns={3}
        onChange={(theme) => write((s) => ({ ...s, theme }))}
      />
      <PickPills
        legend="Density"
        options={DENSITY_PICKS}
        value={settings.density}
        onChange={(density) => write((s) => ({ ...s, density }))}
      />
      {error}
    </StepFrame>
  );
}

// ---------------------------------------------------------------------------------------------
// 6. Try it: how to save, and the keys Chrome reports
// ---------------------------------------------------------------------------------------------

export function KeysStep({ heading, onBack, onNext }: Flow & { heading: RefObjectLike }) {
  const { commands, error, retry } = useShortcuts();
  const open = useAction(async () => {
    // chrome:// pages cannot be linked from an extension page; they can be opened as a new tab.
    await browser.tabs.create({ url: shortcutsPageUrl(navigator.userAgent) });
  });
  const quickSave = pickCommands(commands ?? [], [COMMAND.quickSave])[0]?.shortcut;
  const how: Array<{ icon: LucideIcon; tone: ArtTone; label: string; key?: string }> = [
    { icon: TextSelect, tone: 'primary', label: 'Select text' },
    { icon: Bookmark, tone: 'sun', label: 'Press Save', ...(quickSave ? { key: quickSave } : {}) },
    { icon: Library, tone: 'success', label: 'Find it later' },
  ];
  return (
    <StepFrame
      step="keys"
      heading={heading}
      pose="wave"
      line="On a page you turned on, select text and save it."
      tip={{
        label: 'About shortcuts',
        text: 'These keys work from any tab. They are read from Chrome, which decides which keys an extension may use.',
      }}
      nav={<StepNav onBack={onBack} next={{ label: 'Next', onClick: onNext }} />}
    >
      <Tiles label="How to save" items={how} numbered />

      <details className="ob-keys">
        <summary className="ob-disclose">
          <Keyboard aria-hidden="true" strokeWidth={2.4} />
          All shortcuts
          <ChevronDown aria-hidden="true" strokeWidth={2.4} className="ob-disclose__chev" />
        </summary>
        {error ? (
          <InlineNotice
            tone="error"
            title="Could not read the current shortcuts"
            action={<Button onClick={retry}>Retry</Button>}
          >
            {error}
          </InlineNotice>
        ) : commands === null ? (
          <p className="sv-muted" role="status">
            Reading the current shortcuts…
          </p>
        ) : (
          <ul className="ob-keys__list" aria-label="Keyboard shortcuts" data-testid={TID.shortcuts}>
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
        <div>
          <ChunkyButton
            size="sm"
            icon={SettingsIcon}
            aria-busy={open.busy || undefined}
            onClick={() => {
              if (!open.busy) void open.run();
            }}
          >
            Change keys
          </ChunkyButton>
        </div>
        {open.error ? (
          <InlineNotice tone="error" title="Could not open the shortcuts page">
            {open.error}
          </InlineNotice>
        ) : null}
      </details>
    </StepFrame>
  );
}

// ---------------------------------------------------------------------------------------------
// 7. Finish
// ---------------------------------------------------------------------------------------------

export function DoneStep({
  heading,
  state,
  access,
  onBack,
  onFinish,
}: {
  heading: RefObjectLike;
  state: OnboardingState;
  /** The site-access card picked in this visit; null when the tour resumed past it. */
  access: Access | null;
  onBack(): void;
  onFinish(): void;
}) {
  const game = useGame();
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
  const mode = useAction((on: boolean) => setGameMode(on));
  const panelKey = pickCommands(commands ?? [], [COMMAND.openSidePanel])[0]?.shortcut;
  const applied = state.applied;
  const data = game.data;
  const goal = data?.ready && data.mode ? data.goal.value : null;
  const GoalIcon = goal ? GOAL_LOOK[goal].icon : null;
  const site = ACCESS_PICKS.find((a) => a.value === access);

  return (
    <StepFrame
      step="done"
      heading={heading}
      pose="cheer"
      center
      nav={
        <StepNav
          onBack={onBack}
          next={{
            label: 'Finish',
            variant: 'sun',
            icon: Check,
            testId: TID.finish,
            onClick: onFinish,
          }}
        />
      }
    >
      {goal || site || applied ? (
        <ul className="ob-chips ob-chips--center" aria-label="Your choices">
          {goal && GoalIcon ? (
            <li className="ob-chip ob-chip--lg sv-art--primary">
              <GoalIcon aria-hidden="true" strokeWidth={2.4} />
              {GOAL_NAMES[goal]} · {goal} XP a day
            </li>
          ) : null}
          {site ? (
            <li className="ob-chip ob-chip--lg sv-art--sun">
              <site.icon aria-hidden="true" strokeWidth={2.4} />
              {site.label}
            </li>
          ) : null}
          {applied ? (
            <li className="ob-chip ob-chip--lg sv-art--success" data-testid={TID.summary}>
              <Library aria-hidden="true" strokeWidth={2.4} />
              {applied.createdBank
                ? `${applied.bankName} · ${plural(applied.createdFolders, 'folder')}`
                : applied.bankName}
            </li>
          ) : null}
        </ul>
      ) : null}

      {data ? (
        <div className="ob-game">
          <span className="ob-tcard__art sv-art--sun" aria-hidden="true">
            <Gamepad2 strokeWidth={2.4} />
          </span>
          <AsyncSwitch
            checked={data.mode}
            label="Game mode"
            hint={data.mode ? 'XP, streaks, badges' : 'Plain mode'}
            onChange={(on) => mode.run(on)}
          />
        </div>
      ) : null}
      {mode.error ? (
        <InlineNotice tone="error" title="Your change was not saved">
          {mode.error}
        </InlineNotice>
      ) : null}

      <div className="ob-panel">
        <ChunkyButton
          icon={PanelRight}
          data-testid={TID.openPanel}
          aria-busy={open.busy || undefined}
          {...(windowId === null ? { disabledReason: 'Looking up this window…' } : {})}
          onClick={() => {
            if (!open.busy) void open.run();
          }}
        >
          Open side panel
        </ChunkyButton>
        {panelKey ? <Kbd shortcut={panelKey} /> : null}
        <InfoTip label="Other ways to open it">
          Click the StudyVault icon in the Chrome toolbar (pin it from the puzzle-piece menu if you
          do not see it), then choose Open side panel.
        </InfoTip>
      </div>
      {opened ? (
        <p role="status" className="ob-chip ob-chip--lg sv-art--success">
          <Check aria-hidden="true" strokeWidth={3} />
          The side panel is open next to this tab.
        </p>
      ) : null}
      {open.error ? (
        <InlineNotice tone="error" title="Could not open the side panel">
          {open.error} You can open it from the toolbar icon instead.
        </InlineNotice>
      ) : null}
    </StepFrame>
  );
}
