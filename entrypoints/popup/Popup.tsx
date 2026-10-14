import { useId, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { browser } from 'wxt/browser';
import {
  Ban,
  Bell,
  BookOpen,
  Check,
  FileText,
  Flame,
  Gamepad2,
  Globe,
  Highlighter,
  House,
  Layers,
  Library,
  MousePointerClick,
  PanelRight,
  Power,
  RotateCw,
  Settings,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  COLOR_SWATCH,
  DEFAULT_DENY_HOSTS,
  DENY_LIST_SCOPE_NOTE,
  KIND_LABELS,
  type Settings as StoredSettings,
  type SiteStatus,
} from '@shared';
import { callBackground, callTab } from '@runtime';
import { pdfReaderPath } from '@pdf/readerUrl';
import { listBanks, listRecentHighlights, setGameMode } from '@storage';
import {
  BarMeter,
  COMMAND,
  IconButton,
  InfoTip,
  Kbd,
  ProgressRing,
  StatChip,
  ToastProvider,
  VaultBuddy,
  editDenyList,
  errorMessage,
  grantSiteAccess,
  hostOf,
  pickCommands,
  revokeSiteAccess,
  truncate,
  useAction,
  useActiveTab,
  useApplyTheme,
  useAsync,
  useDataEpoch,
  useObserved,
  useSettings,
  useShortcuts,
  useToast,
  type ActiveTab,
} from '@ui';
import { useGame, type GameView } from '@ui/game';
import { useDueCount } from '@ui/review/hooks';
import { useReminderRaised } from '@ui/review/ReminderNotice';
import { reminderText } from '@ui/review/reminders';
import { reviewPageUrl } from '@ui/review/links';
import { settingsPath, type SettingsSectionId } from '@ui/shell/paths';
import { openDashboard } from '@ui/vault/dashboardLink';
import {
  derivePopupState,
  pdfName,
  studyView,
  todayView,
  type PdfReaderOffer,
  type PopupState,
  type StudyView,
} from './model';
import { Act, LevelEmblem, LogoMark, SwitchButton, ToggleChip } from './widgets';

const RECENT_LIMIT = 2;

type Op = 'activate' | 'enable' | 'disable' | 'allow';

export function Popup() {
  return (
    <ToastProvider>
      <PopupBody />
    </ToastProvider>
  );
}

function PopupBody() {
  const settingsState = useSettings();
  const { settings, error: settingsError } = settingsState;
  useApplyTheme(settings?.theme);
  const tabState = useActiveTab();
  const { tab, loading: tabLoading, error: tabError } = tabState;
  const game = useGame();
  const { commands } = useShortcuts();
  const [quickSave, panelKey] = commands
    ? [COMMAND.quickSave, COMMAND.openSidePanel].map(
        (name) => pickCommands(commands, [name])[0]?.shortcut,
      )
    : [];
  /** Focus lands here after an action replaced the control that had it (never on <body>). */
  const heading = useRef<HTMLHeadingElement>(null);

  const url = tab?.url;
  const status = useAsync<SiteStatus | null>(
    () =>
      tab && tab.url !== undefined
        ? callBackground('site.status', { tabId: tab.id, url: tab.url })
        : Promise.resolve(null),
    [tab?.id, tab?.url],
  );

  const state: PopupState | null =
    settings === null || tabLoading
      ? null
      : derivePopupState({ url, status: status.data ?? null, denyList: settings.denyList });

  const failure = settingsError ?? tabError ?? status.error;
  // Only the worker's answer can be a non-transient storage error; settings and tab reads can be redone.
  const retryable = settingsError || tabError ? true : status.retryable;
  /** Retries whatever failed: the settings read, the tab query, or the worker's site check. */
  const retry = () => {
    if (settingsError) settingsState.retry();
    if (tabError) tabState.retry();
    if (status.error) status.refresh();
  };

  return (
    <div className="popup">
      <Header heading={heading} game={game} />
      <main className="popup__main">
        {failure ? (
          <CheckFailed
            message={failure}
            retry={retryable ? retry : undefined}
            busy={status.refreshing}
          />
        ) : state === null || state.kind === 'loading' ? (
          <SiteCard tile={<Globe />} name={hostOf(url) ?? 'This tab'} sub="Checking this tab…" />
        ) : (
          <TabState
            tab={tab}
            state={state}
            pdfReaderOn={settings?.features.pdfReader ?? true}
            refreshing={status.refreshing}
            onChanged={status.refresh}
            focusAfter={heading}
          />
        )}
        <div className="pp-actions">
          <OpenPanel tab={tab} loading={tabLoading} shortcut={panelKey} />
          {settings?.features.review ? (
            <section className="popup__study" aria-label="Study">
              {/* The tab check comes first: the worker answers it, and the card count opens the
                  database. A failed check is settled too, or the count would wait forever. */}
              {failure || (state !== null && state.kind !== 'loading') ? (
                <WithReview onReminderDismissed={() => heading.current?.focus()} />
              ) : (
                <ReviewButton view={null} />
              )}
            </section>
          ) : null}
        </div>
        {settings ? (
          <QuickToggles settings={settings} update={settingsState.update} game={game} />
        ) : null}
        {state?.kind === 'active' ? <Recent lastBankId={settings?.lastBankId ?? null} /> : null}
      </main>
      <Footer quickSave={quickSave} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Frame: header, footer, shared bits
// ---------------------------------------------------------------------------------------------

function Header({
  heading,
  game,
}: {
  heading: RefObject<HTMLHeadingElement | null>;
  game: GameView;
}) {
  const open = useAction(async () => {
    await browser.runtime.openOptionsPage();
    window.close();
  });
  return (
    <header className="popup__head">
      <div className="pp-head">
        <LogoMark />
        <h1 ref={heading} tabIndex={-1} className="pp-brand">
          StudyVault
        </h1>
        <span className="pp-spacer" />
        <GameCluster game={game} />
        <IconButton
          icon={Settings}
          label="Settings and privacy"
          tipSide="left"
          aria-busy={open.busy || undefined}
          onClick={open.busy ? undefined : () => void open.run()}
        />
      </div>
      {open.error ? (
        <Problem
          title="Can't open settings"
          message={open.error}
          retry={open.retryable ? open.retry : undefined}
        />
      ) : null}
    </header>
  );
}

function Footer({ quickSave }: { quickSave: string | undefined }) {
  const open = useAction(async () => {
    await openDashboard();
    window.close();
  });
  return (
    <footer className="popup__foot">
      <div className="pp-foot">
        <Act
          variant="ghost"
          size="sm"
          icon={House}
          busy={open.busy}
          data-testid="popup-dashboard"
          onClick={() => void open.run()}
        >
          Open dashboard
        </Act>
        <span className="pp-spacer" />
        {quickSave !== undefined ? (
          <span className="pp-keys">
            Save <Kbd shortcut={quickSave} />
          </span>
        ) : null}
      </div>
      {open.error ? (
        <Problem
          title="Can't open page"
          message={open.error}
          retry={open.retryable ? open.retry : undefined}
        />
      ) : null}
    </footer>
  );
}

/**
 * A failure in a few words with the way out (Retry when it can help); the full message is behind
 * (i) (UX_DESIGN 8). Announced (role="alert").
 */
function Problem({
  title,
  message,
  retry,
  busy,
}: {
  title: string;
  message: string;
  retry?: () => void;
  busy?: boolean;
}) {
  return (
    <div className="pp-problem" role="alert">
      <TriangleAlert aria-hidden="true" className="pp-problem__icon" strokeWidth={2.5} />
      <p className="pp-problem__text">
        <strong>{title}</strong>
      </p>
      <InfoTip label={`About: ${title}`} align="end">
        <span dir="auto">{message}</span>
      </InfoTip>
      {retry ? (
        <Act size="sm" busy={busy} onClick={retry}>
          Retry
        </Act>
      ) : null}
    </div>
  );
}

function Pill({
  tone = 'neutral',
  icon: Icon,
  children,
}: {
  tone?: 'neutral' | 'success' | 'primary' | 'warning';
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <span className={`pp-pill pp-pill--${tone}`}>
      <Icon aria-hidden="true" strokeWidth={2.6} />
      {children}
    </span>
  );
}

/** The "This page" card: icon or mascot tile, name, one line, status badge, then its controls. */
function SiteCard({
  tile,
  name,
  sub,
  wrap = false,
  badge,
  children,
}: {
  tile: ReactNode;
  name: string;
  sub?: string | null;
  /** The line is a reason, not a page title: wrap it instead of cutting it. */
  wrap?: boolean;
  badge?: ReactNode;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <section className="pp-card pp-site" aria-labelledby={id}>
      <div className="pp-site__top">
        <span className="pp-tile" aria-hidden="true">
          {tile}
        </span>
        <div className="pp-where">
          <h2 id={id} className="pp-where__name" dir="auto">
            {name}
          </h2>
          {sub ? (
            <p className={`pp-where__sub${wrap ? ' pp-where__sub--wrap' : ''}`} dir="auto">
              {sub}
            </p>
          ) : null}
        </div>
        {badge}
      </div>
      {children}
    </section>
  );
}

/** The tab check failed: say so plainly, with Retry, or Reload when retrying cannot help. */
function CheckFailed({
  message,
  retry,
  busy,
}: {
  message: string;
  retry?: () => void;
  busy: boolean;
}) {
  return (
    <section className="pp-card pp-site" role="alert" aria-label="This tab">
      <div className="pp-site__top">
        <span className="pp-tile pp-tile--buddy" aria-hidden="true">
          <VaultBuddy pose="think" size={40} />
        </span>
        <div className="pp-where">
          <h2 className="pp-where__name">Can&apos;t check tab</h2>
          {/* Only a storage_unavailable answer is not retryable (isRetryable). */}
          <p className="pp-where__sub">
            {retry ? 'Something went wrong.' : "Your data can't be opened."}
          </p>
        </div>
      </div>
      <div className="pp-site__row">
        {retry ? (
          <Act busy={busy} onClick={retry}>
            Retry
          </Act>
        ) : (
          // A storage error repeats on a plain retry; a fresh start opens the database again.
          <Act onClick={() => window.location.reload()}>Reload</Act>
        )}
        <InfoTip label="About: Can't check tab" align="start">
          <span dir="auto">{message}</span>
        </InfoTip>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// This page
// ---------------------------------------------------------------------------------------------

function TabState({
  tab,
  state,
  pdfReaderOn,
  refreshing,
  onChanged,
  focusAfter,
}: {
  tab: ActiveTab | null;
  state: Exclude<PopupState, { kind: 'loading' }>;
  /** Settings.features.pdfReader: while off, the reader is not offered. */
  pdfReaderOn: boolean;
  /** The quiet re-check after an action is running. */
  refreshing: boolean;
  /** Quiet re-check: the current view stays until the new answer arrives. */
  onChanged(): void;
  focusAfter: RefObject<HTMLElement | null>;
}) {
  const { announce } = useToast();
  /** Why "Always on" did not (fully) happen; shown as a warning in every state. */
  const [warning, setWarning] = useState<string | null>(null);
  /** Allowing a starter-list site needs a second, deliberate step. */
  const [confirming, setConfirming] = useState<'no' | 'asking' | 'cancelled'>('no');
  /** Which button runs, so only that one shows progress. */
  const [running, setRunning] = useState<Op | null>(null);

  const warn = (text: string) => {
    setWarning(text);
    announce(text);
  };

  const act = useAction(async (op: Op) => {
    if (!tab) throw new Error('There is no active tab.');
    setWarning(null);
    let spoken: string | null = null;
    switch (op) {
      case 'activate':
        await callBackground('tab.activate', { tabId: tab.id });
        spoken = 'Turned on for this tab.';
        break;
      case 'enable': {
        if (state.kind !== 'inactive' && state.kind !== 'active') return;
        // First await in the click: Chrome needs the user gesture for the permission prompt.
        const { granted, notRegistered } = await grantSiteAccess([state.pattern]);
        if (!granted) {
          warn(
            `Chrome said no, so nothing changed. ${
              state.kind === 'inactive'
                ? 'Turn on still works for this tab.'
                : 'StudyVault stays on for this tab only.'
            }`,
          );
          return;
        }
        if (notRegistered.length > 0) {
          warn(
            `Always on did not stick on ${state.host}. It is on for this tab; after a reload, choose Turn on again.`,
          );
        } else {
          spoken = `Always on for ${state.host}.`;
        }
        await callBackground('tab.activate', { tabId: tab.id });
        break;
      }
      case 'disable':
        if (state.kind === 'active') {
          await revokeSiteAccess([state.pattern]);
          spoken = `Always-on turned off for ${state.host}.`;
        }
        break;
      case 'allow':
        if (state.kind === 'denied') {
          const entries = state.entries;
          await editDenyList((list) => list.filter((e) => !entries.includes(e)));
          spoken = `Allowed StudyVault on ${state.host}.`;
        }
        break;
    }
    setConfirming('no');
    onChanged();
    if (spoken) announce(spoken);
    // The control that was clicked is replaced by the new state: keep focus on a stable element.
    focusAfter.current?.focus();
  });
  const run = (op: Op) => {
    if (act.busy) return; // one site action at a time
    setRunning(op);
    void act.run(op);
  };
  const busy = (op: Op) => act.busy && running === op;

  const failure = act.error ? (
    <Problem
      title="That did not work"
      message={act.error}
      retry={act.retryable ? act.retry : undefined}
    />
  ) : null;
  const warningNote = warning ? (
    <p className="pp-note">
      <TriangleAlert aria-hidden="true" strokeWidth={2.5} />
      <span>{warning}</span>
    </p>
  ) : null;

  switch (state.kind) {
    case 'unsupported':
      if (state.reason === 'pdf') {
        return (
          <SiteCard
            tile={<FileText />}
            name={pdfName(tab?.url)}
            sub="Chrome PDF viewer"
            badge={
              <Pill tone="primary" icon={FileText}>
                PDF
              </Pill>
            }
          >
            <PdfReader offer={state.reader} enabled={pdfReaderOn} />
          </SiteCard>
        );
      }
      return <Restricted tab={tab} state={state} />;

    case 'denied': {
      const entries = state.entries.join(', ');
      const starter = state.entries.some((e) => DEFAULT_DENY_HOSTS.includes(e));
      return (
        <SiteCard
          tile={<VaultBuddy pose="think" size={40} />}
          name={state.host}
          sub="On your deny list"
          wrap
          badge={
            <Pill tone="warning" icon={Ban}>
              Not allowed
            </Pill>
          }
        >
          {state.entries.length === 0 ? (
            <div className="pp-site__row">
              <Act busy={refreshing} onClick={onChanged}>
                Check again
              </Act>
              <InfoTip label="About this site" align="end">
                StudyVault says this site is off, but your deny list has no entry for it.
              </InfoTip>
            </div>
          ) : confirming === 'asking' ? (
            <div className="pp-ask">
              <p className="pp-ask__head">
                <strong>{`Allow ${state.host}?`}</strong>
                <InfoTip label="About this site" align="end">
                  It is on the starter list of sign-in, mail and payment sites.
                </InfoTip>
              </p>
              <p>Its scripts could see what you mark.</p>
              <div className="pp-site__row">
                <Act busy={busy('allow')} onClick={() => run('allow')}>
                  Yes, allow
                </Act>
                <Act autoFocus variant="primary" onClick={() => setConfirming('cancelled')}>
                  Keep it off
                </Act>
              </div>
            </div>
          ) : (
            <div className="pp-site__row">
              <Act
                autoFocus={confirming === 'cancelled'}
                busy={busy('allow')}
                icon={Check}
                onClick={() => (starter ? setConfirming('asking') : run('allow'))}
              >
                Allow this site
              </Act>
              <InfoTip label="About the deny list" align="end">
                {`${entries} is on your deny list, so StudyVault stays off here. Allowing removes it, and its subdomains. `}
                {starter ? DENY_LIST_SCOPE_NOTE : 'You can add it back in Settings.'}
              </InfoTip>
            </div>
          )}
          {failure}
        </SiteCard>
      );
    }

    case 'inactive':
      return (
        <SiteCard
          tile={<Globe />}
          name={state.host}
          sub={tab?.title}
          badge={<Pill icon={Power}>Off</Pill>}
        >
          <div className="pp-site__acts">
            <Act
              variant="primary"
              icon={Power}
              busy={busy('activate')}
              onClick={() => run('activate')}
            >
              Turn on
            </Act>
            {state.allSites ? null : (
              <Act
                busy={busy('enable')}
                aria-label={`Always on for ${state.host}`}
                onClick={() => run('enable')}
              >
                Always on
              </Act>
            )}
            <InfoTip label="About turning on" align="end">
              {state.allSites
                ? 'All-sites access is on, but this tab was opened before it. Reload the page, or turn on here now.'
                : `Turn on: this tab only, until you reload. Always on: every visit to ${state.host}; Chrome asks first. Nothing is read before you choose.`}
              <SiteAccessLink />
            </InfoTip>
          </div>
          {warningNote}
          {failure}
        </SiteCard>
      );

    case 'active':
      return (
        <SiteCard
          tile={<Globe />}
          name={state.host}
          sub={tab?.title}
          badge={
            <Pill tone="success" icon={Check}>
              On
            </Pill>
          }
        >
          <div className="pp-site__row">
            {tab ? <PageCounts tabId={tab.id} url={tab.url} /> : null}
            <span className="pp-spacer" />
            <span className="pp-inline">
              {state.allSites ? (
                <Pill tone="primary" icon={Globe}>
                  All sites
                </Pill>
              ) : (
                <SwitchButton
                  checked={state.persistent}
                  label="Always on"
                  busy={busy('enable') || busy('disable') || (running !== null && refreshing)}
                  onToggle={(on) => run(on ? 'enable' : 'disable')}
                />
              )}
              <InfoTip label="About always on" align="end">
                {state.allSites
                  ? 'Always on for all sites. Change this in Settings.'
                  : `Off: on for this tab only, until you reload. On: every visit to ${state.host}; Chrome asks first.`}
                <SiteAccessLink />
              </InfoTip>
            </span>
          </div>
          {warningNote}
          {failure}
        </SiteCard>
      );
  }
}

/** Browser pages, other address types, and no tab at all: the mascot says why, nothing pretends. */
function Restricted({
  tab,
  state,
}: {
  tab: ActiveTab | null;
  state: Extract<PopupState, { kind: 'unsupported'; reason: 'no-address' | 'scheme' }>;
}) {
  if (!tab) {
    return (
      <SiteCard
        tile={<VaultBuddy pose="sleep" size={40} />}
        name="No tab open"
        sub="Open a web page first."
      />
    );
  }
  // The reason in two words; the badge says "Not allowed" and (i) says what to do.
  const line =
    state.reason === 'no-address'
      ? 'Browser page'
      : state.scheme === 'file:'
        ? 'Local file'
        : 'Not a website';
  return (
    <SiteCard
      tile={<VaultBuddy pose="sleep" size={40} />}
      name="Can't run here"
      sub={line}
      wrap
      badge={
        <span className="pp-inline">
          <Pill icon={Ban}>Not allowed</Pill>
          <InfoTip label="Why not here" align="end">
            {'Open a regular website to save. '}
            {state.reason === 'no-address'
              ? "Chrome did not share this tab's address, as on chrome:// pages, the new tab page and the Web Store."
              : `This is a ${state.scheme ?? 'non-web'} page. StudyVault works on http and https pages only; local files (file://) are not supported.`}
          </InfoTip>
        </span>
      }
    />
  );
}

/** Highlights on this page and how many need a look, as count chips (the content script's answer). */
function PageCounts({ tabId, url }: { tabId: number; url: string | undefined }) {
  // Edits and re-checks from any context change what the page counts say: ask the page again.
  const epoch = useDataEpoch();
  const page = useAsync(() => callTab(tabId, 'content.pageStatus', {}), [tabId, url], [epoch]);
  if (page.error) {
    // Inline, so the Always on switch keeps its place: the message is behind (i).
    return (
      <span className="pp-inline" role="alert">
        <Pill tone="warning" icon={TriangleAlert}>
          Can&apos;t read page
          <InfoTip label="About: Can't read page" align="start">
            {page.error}
          </InfoTip>
        </Pill>
        {page.retryable ? (
          <IconButton
            icon={RotateCw}
            label="Retry"
            size="sm"
            aria-busy={page.refreshing || undefined}
            onClick={page.refresh}
          />
        ) : null}
      </span>
    );
  }
  if (!page.data) return <span className="pp-help">Counting…</span>;
  const { counts, paintingSupported } = page.data;
  const attention = counts.ambiguous + counts.orphaned;
  return (
    <>
      <span className="pp-pill pp-pill--primary" data-testid="popup-page-count">
        <Highlighter aria-hidden="true" strokeWidth={2.6} />
        {counts.total}
        <span className="sv-vh">{` ${counts.total === 1 ? 'highlight' : 'highlights'} on this page`}</span>
      </span>
      {attention > 0 ? (
        <span className="pp-pill pp-pill--warning" data-testid="popup-attention">
          <TriangleAlert aria-hidden="true" strokeWidth={2.6} />
          {attention}
          <span className="sv-vh">{` ${attention === 1 ? 'needs' : 'need'} a look`}</span>
        </span>
      ) : null}
      {paintingSupported ? null : (
        <span className="pp-pill pp-pill--warning">
          <TriangleAlert aria-hidden="true" strokeWidth={2.6} />
          No paint
          <InfoTip label="About painting" align="end">
            This browser cannot paint highlights on pages. Saved quotes are still listed in the side
            panel.
          </InfoTip>
        </span>
      )}
    </>
  );
}

/**
 * "Open in StudyVault" for a PDF tab. The reader asks for access to that one site itself (it needs
 * its own click); this only opens it. When the address cannot be fetched the reader is still
 * offered without it, so a downloaded copy can be chosen there, and the reason is behind (i).
 */
function PdfReader({ offer, enabled }: { offer: PdfReaderOffer; enabled: boolean }) {
  const open = useAction(async () => {
    const path = pdfReaderPath(offer.src ? { src: offer.src } : {});
    await browser.tabs.create({ url: browser.runtime.getURL(`/${path}` as never) });
    window.close();
  });
  if (!enabled) {
    return (
      <div className="pp-site__row">
        <span className="pp-help">PDF reader is off.</span>
        <span className="pp-spacer" />
        <OpenSettings section="capture" label="Open Settings" />
      </div>
    );
  }
  return (
    <>
      {offer.src ? null : <p className="pp-help">Choose the file in the reader.</p>}
      <div className="pp-site__acts pp-site__acts--one">
        <Act
          variant="primary"
          icon={BookOpen}
          block
          busy={open.busy}
          onClick={() => void open.run()}
        >
          {offer.src ? 'Open in StudyVault' : 'Open reader'}
        </Act>
        <InfoTip label="About PDFs" align="end">
          {offer.problem ??
            "PDFs open in Chrome's built-in viewer, which extensions cannot mark up. StudyVault's reader can: highlight, add notes and search."}
        </InfoTip>
      </div>
      {open.error ? (
        <Problem
          title="Can't open reader"
          message={open.error}
          retry={open.retryable ? open.retry : undefined}
        />
      ) : null}
    </>
  );
}

/** Inside an (i): the full site-access choices (this tab, one site, all sites) live in Settings. */
function SiteAccessLink() {
  return (
    <span className="pp-tiplink">
      <OpenSettings section="site-access" label="Site access" />
    </span>
  );
}

/** Opens one section of the settings page (options.html#section) in a tab. */
function OpenSettings({ section, label }: { section: SettingsSectionId; label: string }) {
  const open = useAction(async () => {
    await browser.tabs.create({
      url: browser.runtime.getURL(`/${settingsPath(section)}` as never),
    });
    window.close();
  });
  return (
    <>
      <Act size="sm" icon={Settings} busy={open.busy} onClick={() => void open.run()}>
        {label}
      </Act>
      {open.error ? (
        <Problem
          title="Can't open settings"
          message={open.error}
          retry={open.retryable ? open.retry : undefined}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Today, actions, toggles, recent
// ---------------------------------------------------------------------------------------------

/**
 * Today, in the header (ADR-022): goal ring with today's XP, streak flame and level when Game mode
 * is on; plain counts when it is off. While the ledger is built only real progress is shown, never
 * a partial number; a failure says so with a way to retry.
 */
function GameCluster({ game }: { game: GameView }) {
  const view = todayView(game.data);
  if (game.error && !game.data) {
    return (
      <span className="pp-game">
        <Pill tone="warning" icon={TriangleAlert}>
          No stats
          <InfoTip label="About stats" align="end">
            {`Today's stats could not be read: ${game.error}`}
          </InfoTip>
        </Pill>
        {game.retryable ? (
          <IconButton icon={RotateCw} label="Retry stats" size="sm" onClick={game.refresh} />
        ) : null}
      </span>
    );
  }
  switch (view.kind) {
    case 'loading':
      return null;
    case 'counting':
      return (
        <span className="pp-game pp-game--counting">
          <span className="pp-help">Counting XP</span>
          {view.total > 0 ? (
            <BarMeter
              value={view.done}
              max={view.total}
              label="Counting your XP"
              valueText={`${view.done} of ${view.total}`}
              tone="sun"
              size="sm"
              className="pp-game__bar"
            />
          ) : null}
        </span>
      );
    case 'count-failed':
      return (
        <span className="pp-game">
          <Pill tone="warning" icon={TriangleAlert}>
            No XP
            <InfoTip label="About XP" align="end">
              {`Your XP could not be counted: ${view.message}`}
            </InfoTip>
          </Pill>
          <IconButton
            icon={RotateCw}
            label="Count XP again"
            size="sm"
            onClick={() => void game.retryBackfill()}
          />
        </span>
      );
    case 'plain':
      return (
        <span className="pp-game pp-game--plain" role="group" aria-label="Today">
          <span>
            <strong>{view.reviews}</strong> reviewed
          </span>
          <span aria-hidden="true">·</span>
          <span>
            <strong>{view.saves}</strong> saved
          </span>
        </span>
      );
    case 'game':
      return (
        <span className="pp-game" role="group" aria-label="Today">
          <ProgressRing
            value={view.xp}
            max={view.goal}
            label="Daily goal"
            unit="XP"
            size={44}
            stroke={5}
            description={view.met ? 'Goal met today.' : `${view.toGo} XP to goal.`}
          >
            <span className="pp-ring__num">{view.xp}</span>
            <span className="pp-ring__of">/{view.goal}</span>
          </ProgressRing>
          <StatChip icon={Flame} value={view.streak} label="day streak" tone="flame" hideLabel />
          <LevelEmblem level={view.level} size={34} />
        </span>
      );
  }
}

/** Opens the side panel for this window. Offered in every state: the panel works without the page. */
function OpenPanel({
  tab,
  loading,
  shortcut,
}: {
  tab: ActiveTab | null;
  loading: boolean;
  shortcut: string | undefined;
}) {
  const open = useAction(async () => {
    if (!tab) throw new Error('There is no active tab.');
    // The click is the gesture sidePanel.open needs; nothing may be awaited before it.
    await browser.sidePanel.open({ windowId: tab.windowId });
    window.close();
  });
  return (
    <>
      <Act
        variant="primary"
        size="lg"
        block
        icon={PanelRight}
        busy={open.busy}
        disabledReason={
          tab
            ? undefined
            : loading
              ? 'Checking this tab…'
              : 'There is no active tab to open the panel for.'
        }
        aria-keyshortcuts={(tab && shortcut) || undefined}
        onClick={() => void open.run()}
      >
        Open side panel
        {shortcut && tab ? (
          <kbd className="pp-btnkey" aria-hidden="true">
            {shortcut}
          </kbd>
        ) : null}
      </Act>
      {open.error ? (
        <Problem
          title="Can't open panel"
          message={open.error}
          retry={open.retryable ? open.retry : undefined}
        />
      ) : null}
    </>
  );
}

/**
 * Review, live from the database (not from a counter kept elsewhere). With review turned off
 * nothing is queried and no button is shown.
 */
function WithReview({ onReminderDismissed }: { onReminderDismissed(): void }) {
  const due = useDueCount();
  const reminder = useReminderRaised();
  const view = studyView(due);
  if (due.error) {
    return (
      <Problem
        title="Can't count cards"
        message={due.error}
        retry={due.retryable ? due.refresh : undefined}
      />
    );
  }
  // The daily time came (Settings > Review): shown only while something is due, in the detail
  // line's place, so the popup keeps its height.
  const reminding = reminder.raised && due.count !== null && due.count > 0;
  return (
    <ReviewButton view={view}>
      {reminding ? (
        <Reminder
          count={due.count ?? 0}
          dismiss={reminder.dismiss}
          onDismissed={onReminderDismissed}
        />
      ) : null}
    </ReviewButton>
  );
}

/** `children`: the reminder; while it shows, the muted detail line under the button does not. */
function ReviewButton({ view, children }: { view: StudyView | null; children?: ReactNode }) {
  const open = useAction(async () => {
    if (view) await browser.tabs.create({ url: reviewPageUrl(view.action.link) });
    window.close();
  });
  if (!view) {
    return (
      <Act variant="sun" size="lg" block icon={Layers} disabledReason="Counting cards…">
        <span className="pp-actlabel">Review</span>{' '}
        <span className="pp-due pp-due--text">Counting…</span>
      </Act>
    );
  }
  return (
    <>
      <Act
        variant={view.action.primary ? 'sun' : 'secondary'}
        size="lg"
        block
        icon={Layers}
        busy={open.busy}
        data-testid="popup-review"
        onClick={() => void open.run()}
      >
        <span className="pp-actlabel">{view.action.label}</span>{' '}
        <span
          className={`pp-due${view.count === null ? ' pp-due--text' : ''}`}
          data-testid="popup-due"
        >
          {view.count === null ? (
            view.badge
          ) : (
            <>
              {view.count}
              <span className="sv-vh">{view.badge.slice(String(view.count).length)}</span>
            </>
          )}
        </span>
      </Act>
      {children ?? (view.detail ? <p className="pp-help pp-help--center">{view.detail}</p> : null)}
      {open.error ? (
        <Problem
          title="Can't open page"
          message={open.error}
          retry={open.retryable ? open.retry : undefined}
        />
      ) : null}
    </>
  );
}

/** "Time to review: N cards due" once the daily time came, until dismissed (any context). */
function Reminder({
  count,
  dismiss,
  onDismissed,
}: {
  count: number;
  dismiss(): Promise<void>;
  onDismissed(): void;
}) {
  const close = useAction(async () => {
    await dismiss();
    onDismissed();
  });
  return (
    <div className="pp-remind" role="status">
      <Bell aria-hidden="true" strokeWidth={2.5} className="pp-remind__icon" />
      <span className="pp-remind__text">
        {reminderText(count)}
        {close.error ? (
          <span className="pp-remind__error">{` Could not dismiss it: ${close.error}`}</span>
        ) : null}
      </span>
      <IconButton
        icon={X}
        label="Dismiss"
        size="sm"
        tipSide="left"
        aria-busy={close.busy || undefined}
        onClick={close.busy ? undefined : () => void close.run()}
      />
    </div>
  );
}

/** Paint highlights, the in-page toolbar and Game mode: one click each, saved at once. */
function QuickToggles({
  settings,
  update,
  game,
}: {
  settings: StoredSettings;
  update(mutate: (s: StoredSettings) => StoredSettings): Promise<StoredSettings>;
  game: GameView;
}) {
  const [error, setError] = useState<string | null>(null);
  const write = (fn: () => Promise<unknown>) =>
    fn().then(
      () => setError(null),
      (err: unknown) => {
        setError(errorMessage(err, 'Could not save that.'));
        throw err; // the chip rolls back
      },
    );
  const mode = game.data?.mode;
  return (
    <>
      <div className="pp-chips" role="group" aria-label="Quick toggles">
        <ToggleChip
          icon={Highlighter}
          label="Highlights"
          pressed={settings.paintHighlights}
          onToggle={(paintHighlights) => write(() => update((s) => ({ ...s, paintHighlights })))}
        />
        <ToggleChip
          icon={MousePointerClick}
          label="Toolbar"
          pressed={settings.toolbarEnabled}
          onToggle={(toolbarEnabled) => write(() => update((s) => ({ ...s, toolbarEnabled })))}
        />
        <ToggleChip
          icon={Gamepad2}
          label="Game mode"
          pressed={mode ?? false}
          disabledReason={
            mode !== undefined
              ? undefined
              : game.error
                ? 'Game mode is unavailable right now.'
                : 'Loading…'
          }
          onToggle={(on) => write(() => setGameMode(on))}
        />
      </div>
      {error ? <Problem title="Not saved" message={error} /> : null}
    </>
  );
}

function Recent({ lastBankId }: { lastBankId: string | null }) {
  const recent = useObserved(() => listRecentHighlights(RECENT_LIMIT), []);
  return (
    <section className="pp-recent" aria-labelledby="recent-heading">
      <div className="pp-recent__head">
        <h2 id="recent-heading" className="pp-eyebrow">
          Recent saves
        </h2>
        <span className="pp-spacer" />
        <SaveTarget lastBankId={lastBankId} />
      </div>
      {recent.error ? (
        <Problem
          title="Can't load saves"
          message={recent.error}
          retry={recent.retryable ? recent.refresh : undefined}
          busy={recent.refreshing}
        />
      ) : !recent.data ? (
        <p className="pp-help">Loading…</p>
      ) : recent.data.length === 0 ? (
        <div className="pp-empty">
          <VaultBuddy pose="sleep" size={44} />
          <p>
            <strong>Nothing saved yet</strong>
            <span className="pp-help">Select text, then use the toolbar.</span>
          </p>
        </div>
      ) : (
        <ul className="pp-saves">
          {recent.data.map(({ highlight, source }) => {
            const kind = KIND_LABELS[highlight.kind];
            return (
              <li
                key={highlight.id}
                className="pp-save"
                style={{ '--pp-strip': COLOR_SWATCH[highlight.color].solid } as CSSProperties}
              >
                <p className="pp-save__quote" dir="auto">
                  {truncate(highlight.exactQuote, 200)}
                </p>
                <p className="pp-save__meta">
                  <span aria-hidden="true">{kind.glyph}</span> {kind.label}
                  <span aria-hidden="true"> · </span>
                  <span dir="auto">
                    {source.title ? `${source.title} · ` : ''}
                    {source.host}
                  </span>
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Where a quick save goes: the last-used bank, else the Inbox. */
function SaveTarget({ lastBankId }: { lastBankId: string | null }) {
  const banks = useObserved(() => listBanks(), []);
  if (!banks.data) return null;
  const last = banks.data.find((b) => b.id === lastBankId);
  const target = last ?? banks.data.find((b) => b.isInbox);
  if (!target) return null;
  return (
    <span className="pp-pill pp-pill--neutral pp-bank">
      <Library aria-hidden="true" strokeWidth={2.6} />
      <span className="sv-vh">{last ? 'Last used bank: ' : 'Saving to: '}</span>
      <strong className="pp-bank__name" dir="auto">
        {target.name}
      </strong>
      {last ? null : <span className="sv-vh"> (default)</span>}
    </span>
  );
}
