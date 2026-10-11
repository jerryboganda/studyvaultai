import { useRef, useState, type RefObject } from 'react';
import { browser } from 'wxt/browser';
import { DEFAULT_DENY_HOSTS, DENY_LIST_SCOPE_NOTE, type SiteStatus } from '@shared';
import { callBackground, callTab } from '@runtime';
import { listBanks, listRecentHighlights } from '@storage';
import {
  Button,
  COMMAND,
  InlineNotice,
  KindChip,
  ShortcutHints,
  ToastProvider,
  editDenyList,
  grantSiteAccess,
  pickCommands,
  plural,
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
import { derivePopupState, type PopupState } from './model';

const RECENT_LIMIT = 5;

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
      <header className="popup__head">
        <h1 ref={heading} tabIndex={-1}>
          StudyVault AI
        </h1>
        {state && 'host' in state && state.host ? (
          <p className="sv-muted sv-wrap">{state.host}</p>
        ) : null}
      </header>
      <main className="popup__main">
        {failure ? (
          <InlineNotice
            tone="error"
            title="StudyVault could not check this tab"
            action={
              retryable ? (
                <Button busy={status.refreshing} onClick={retry}>
                  Retry
                </Button>
              ) : undefined
            }
          >
            {failure}
          </InlineNotice>
        ) : state === null || state.kind === 'loading' ? (
          <p className="sv-muted">Checking this tab…</p>
        ) : (
          <TabState
            tab={tab}
            state={state}
            lastBankId={settings?.lastBankId ?? null}
            onChanged={status.refresh}
            focusAfter={heading}
          />
        )}
      </main>
      <Footer />
    </div>
  );
}

function Footer() {
  const open = useAction(async () => {
    await browser.runtime.openOptionsPage();
    window.close();
  });
  return (
    <footer className="popup__foot">
      <Button variant="ghost" busy={open.busy} onClick={() => void open.run()}>
        Settings and privacy
      </Button>
      {open.error ? (
        <InlineNotice tone="error">Could not open settings: {open.error}</InlineNotice>
      ) : null}
    </footer>
  );
}

// ---------------------------------------------------------------------------------------------

function TabState({
  tab,
  state,
  lastBankId,
  onChanged,
  focusAfter,
}: {
  tab: ActiveTab | null;
  state: Exclude<PopupState, { kind: 'loading' }>;
  lastBankId: string | null;
  /** Quiet re-check: the current view stays until the new answer arrives. */
  onChanged(): void;
  focusAfter: RefObject<HTMLElement | null>;
}) {
  const { announce } = useToast();
  /** Why "Always enable" did not (fully) happen; shown as a warning in every state. */
  const [warning, setWarning] = useState<string | null>(null);
  /** Allowing a starter-list site needs a second, deliberate step. */
  const [confirming, setConfirming] = useState<'no' | 'asking' | 'cancelled'>('no');

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
        spoken = 'Activated on this tab.';
        break;
      case 'enable': {
        if (state.kind !== 'inactive' && state.kind !== 'active') return;
        // First await in the click: Chrome needs the user gesture for the permission prompt.
        const { granted, notRegistered } = await grantSiteAccess([state.pattern]);
        if (!granted) {
          warn(
            `Chrome did not give StudyVault access to ${state.host}. Nothing was changed. ${
              state.kind === 'inactive'
                ? 'You can still use "Activate on this tab".'
                : 'StudyVault stays on for this tab only.'
            }`,
          );
          return;
        }
        if (notRegistered.length > 0) {
          warn(
            `Chrome allowed StudyVault on ${state.host}, but StudyVault could not set it to start by itself on every visit. It is active on this tab now; after you reload or return, open this popup and choose "Activate on this tab" again.`,
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

  const failure = act.error ? (
    <InlineNotice
      tone="error"
      title="That did not work"
      action={act.retryable ? <Button onClick={act.retry}>Retry</Button> : undefined}
    >
      {act.error}
    </InlineNotice>
  ) : null;
  const warningNotice = warning ? <InlineNotice tone="warning">{warning}</InlineNotice> : null;

  switch (state.kind) {
    case 'unsupported':
      return (
        <div className="sv-stack">
          <Unsupported state={state} />
          <OpenPanel tab={tab} />
        </div>
      );

    case 'denied': {
      const entries = state.entries.join(', ');
      const starter = state.entries.some((e) => DEFAULT_DENY_HOSTS.includes(e));
      return (
        <div className="sv-stack">
          <InlineNotice tone="warning" title={`StudyVault is off on ${state.host}`}>
            <p>
              This site is on your deny list{entries ? ` (${entries})` : ''}, so the toolbar and
              highlights stay off here and nothing can be saved.
            </p>
            <p>{DENY_LIST_SCOPE_NOTE}</p>
          </InlineNotice>
          {state.entries.length === 0 ? (
            <Button busy={act.busy} onClick={onChanged}>
              Check again
            </Button>
          ) : confirming === 'asking' ? (
            <InlineNotice tone="warning" title={`Allow StudyVault on ${state.host}?`}>
              <p>
                {entries} is on StudyVault&apos;s starter deny list, which keeps it away from
                sign-in, mail, payment and similar sites. If you allow it, the toolbar and
                highlights run there, and scripts on that site can see which passages you mark.
              </p>
              <div className="sv-row">
                <Button busy={act.busy} onClick={() => void act.run('allow')}>
                  {`Yes, allow StudyVault on ${state.host}`}
                </Button>
                <Button autoFocus variant="ghost" onClick={() => setConfirming('cancelled')}>
                  Keep it off
                </Button>
              </div>
            </InlineNotice>
          ) : (
            <div className="sv-stack sv-stack--tight">
              <p>
                Allowing it removes {entries} from your deny list, which also re-enables its
                subdomains. You can add it back in Settings.
              </p>
              <div>
                <Button
                  autoFocus={confirming === 'cancelled'}
                  busy={act.busy}
                  onClick={() => (starter ? setConfirming('asking') : void act.run('allow'))}
                >{`Allow StudyVault on ${state.host}`}</Button>
              </div>
            </div>
          )}
          {failure}
          <OpenPanel tab={tab} />
        </div>
      );
    }

    case 'inactive':
      return (
        <div className="sv-stack">
          <InlineNotice tone="info" title="StudyVault is not running on this tab">
            {state.allSites ? (
              <p>
                All-sites access is on in Settings, but this tab was opened before it started.
                Reload the page, or activate StudyVault here now.
              </p>
            ) : (
              <p>
                Chrome only lets StudyVault read a page after you ask. Activating works for this tab
                until you navigate away or reload; nothing is read from the page before then.
              </p>
            )}
          </InlineNotice>
          <Button variant="primary" busy={act.busy} onClick={() => void act.run('activate')}>
            Activate on this tab
          </Button>
          {state.allSites ? null : (
            <div className="sv-stack sv-stack--tight">
              <Button busy={act.busy} onClick={() => void act.run('enable')}>
                {`Always enable on ${state.host}`}
              </Button>
              <p className="sv-muted sv-small">
                Asks Chrome for permission to run on {state.host} only, so your highlights come back
                every time you visit. You can turn it off again here or in Settings.
              </p>
            </div>
          )}
          {warningNotice}
          {failure}
          <OpenPanel tab={tab} />
        </div>
      );

    case 'active':
      return (
        <div className="sv-stack">
          {tab ? <PageSummary tabId={tab.id} url={tab.url} /> : null}
          <AccessLine state={state} busy={act.busy} run={act.run} />
          {warningNotice}
          {failure}
          <OpenPanel tab={tab} primary />
          <KeyHints />
          <Banks lastBankId={lastBankId} />
          <Recent />
        </div>
      );
  }
}

/** Opens the side panel for this window. Offered in every state: the panel works without the page. */
function OpenPanel({ tab, primary = false }: { tab: ActiveTab | null; primary?: boolean }) {
  const open = useAction(async () => {
    if (!tab) throw new Error('There is no active tab.');
    // The click is the gesture sidePanel.open needs; nothing may be awaited before it.
    await browser.sidePanel.open({ windowId: tab.windowId });
    window.close();
  });
  return (
    <div className="sv-stack sv-stack--tight">
      <div>
        <Button
          variant={primary ? 'primary' : 'secondary'}
          busy={open.busy}
          disabledReason={tab ? undefined : 'There is no active tab to open the panel for.'}
          onClick={() => void open.run()}
        >
          Open side panel
        </Button>
      </div>
      {open.error ? (
        <InlineNotice
          tone="error"
          title="Could not open the side panel"
          action={open.retryable ? <Button onClick={open.retry}>Retry</Button> : undefined}
        >
          {open.error}
        </InlineNotice>
      ) : null}
    </div>
  );
}

/** The keys that save and open the panel, read from Chrome (the user may have changed them). */
function KeyHints() {
  const { commands } = useShortcuts();
  if (!commands) return null;
  const shown = pickCommands(commands, [COMMAND.quickSave, COMMAND.openSidePanel]);
  return <ShortcutHints commands={shown} />;
}

function Unsupported({ state }: { state: Extract<PopupState, { kind: 'unsupported' }> }) {
  if (state.reason === 'pdf') {
    return (
      <InlineNotice tone="info" title="PDFs open in Chrome's built-in viewer">
        <p>
          Chrome does not let extensions read or mark up its built-in PDF viewer, so StudyVault
          cannot highlight here. A StudyVault PDF reader is planned for a later release.
        </p>
      </InlineNotice>
    );
  }
  return (
    <InlineNotice tone="info" title="StudyVault cannot run on this page">
      {state.reason === 'no-address' ? (
        <p>
          Chrome did not share this tab&apos;s address. That is normal for browser pages such as
          chrome:// pages, the new-tab page and the Chrome Web Store, which no extension can use.
        </p>
      ) : (
        <p>
          {state.scheme ? `This tab uses the "${state.scheme}" address type. ` : ''}
          StudyVault works on http and https pages only. Chrome blocks extensions on its own pages,
          and local files (file://) are not supported.
        </p>
      )}
      <p>Open a regular website to capture highlights.</p>
    </InlineNotice>
  );
}

function AccessLine({
  state,
  busy,
  run,
}: {
  state: Extract<PopupState, { kind: 'active' }>;
  busy: boolean;
  run(op: Op): Promise<void>;
}) {
  if (state.allSites) {
    return (
      <p className="sv-muted">
        <strong>Always on</strong> for all sites. Change this in Settings.
      </p>
    );
  }
  if (state.persistent) {
    return (
      <div className="sv-row">
        <p className="sv-grow">
          <strong>Always on</strong> for {state.host}.
        </p>
        <Button busy={busy} onClick={() => void run('disable')}>
          Disable always-on for this site
        </Button>
      </div>
    );
  }
  return (
    <div className="sv-stack sv-stack--tight">
      <p className="sv-muted">
        Active on this tab only. It stops when you navigate away or reload.
      </p>
      <Button busy={busy} onClick={() => void run('enable')}>
        {`Always enable on ${state.host}`}
      </Button>
    </div>
  );
}

function PageSummary({ tabId, url }: { tabId: number; url: string | undefined }) {
  // Edits and re-checks from any context change what the page counts say: ask the page again.
  const epoch = useDataEpoch();
  const page = useAsync(() => callTab(tabId, 'content.pageStatus', {}), [tabId, url], [epoch]);
  if (page.error) {
    return (
      <InlineNotice
        tone="error"
        title="Could not read this page"
        action={
          page.retryable ? (
            <Button busy={page.refreshing} onClick={page.refresh}>
              Retry
            </Button>
          ) : undefined
        }
      >
        {page.error}
      </InlineNotice>
    );
  }
  if (!page.data) return <p className="sv-muted">Counting highlights…</p>;
  const { counts, paintingSupported } = page.data;
  const attention = counts.ambiguous + counts.orphaned;
  return (
    <div className="sv-stack sv-stack--tight">
      <p>
        <strong>{plural(counts.total, 'highlight')}</strong> on this page
        {attention > 0 ? `, ${attention} need${attention === 1 ? 's' : ''} attention` : ''}.
      </p>
      {paintingSupported ? null : (
        <InlineNotice tone="warning">
          This browser cannot paint highlights on pages. Saved quotes are still listed in the side
          panel.
        </InlineNotice>
      )}
    </div>
  );
}

function Banks({ lastBankId }: { lastBankId: string | null }) {
  const banks = useObserved(() => listBanks(), []);
  if (!banks.data) return null;
  const last = banks.data.find((b) => b.id === lastBankId);
  const target = last ?? banks.data.find((b) => b.isInbox);
  if (!target) return null;
  return (
    <p>
      <span className="sv-muted">{last ? 'Last used bank: ' : 'Saving to: '}</span>
      <strong className="sv-wrap" dir="auto">
        {target.name}
      </strong>
      {last ? null : <span className="sv-muted"> (default)</span>}
    </p>
  );
}

function Recent() {
  const recent = useObserved(() => listRecentHighlights(RECENT_LIMIT), []);
  return (
    <section className="sv-stack sv-stack--tight" aria-labelledby="recent-heading">
      <h2 id="recent-heading">Recent saves</h2>
      {recent.error ? (
        <InlineNotice
          tone="error"
          action={
            recent.retryable ? (
              <Button busy={recent.refreshing} onClick={recent.refresh}>
                Retry
              </Button>
            ) : undefined
          }
        >{`Could not load recent saves: ${recent.error}`}</InlineNotice>
      ) : !recent.data ? (
        <p className="sv-muted">Loading…</p>
      ) : recent.data.length === 0 ? (
        <p className="sv-muted">
          Nothing saved yet. Select text on a page and use the StudyVault toolbar.
        </p>
      ) : (
        <ul className="popup__recent">
          {recent.data.map(({ highlight, source }) => (
            <li key={highlight.id} className="popup__item">
              <KindChip kind={highlight.kind} color={highlight.color} />
              <p className="sv-quote popup__quote" dir="auto">
                {truncate(highlight.exactQuote, 200)}
              </p>
              <p className="sv-muted sv-small sv-wrap" dir="auto">
                {source.title ? `${source.title} · ` : ''}
                {source.host}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
