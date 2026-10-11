import { useState } from 'react';
import { browser } from 'wxt/browser';
import type { SiteStatus } from '@shared';
import { callBackground, callTab } from '@runtime';
import { listBanks, listRecentHighlights } from '@storage';
import {
  Button,
  InlineNotice,
  KindChip,
  editDenyList,
  grantSiteAccess,
  plural,
  revokeSiteAccess,
  truncate,
  useAction,
  useActiveTab,
  useApplyTheme,
  useAsync,
  useObserved,
  useSettings,
  type ActiveTab,
} from '@ui';
import { derivePopupState, type PopupState } from './model';

const RECENT_LIMIT = 5;

type Op = 'activate' | 'enable' | 'disable' | 'allow' | 'panel';

export function Popup() {
  const { settings, error: settingsError } = useSettings();
  useApplyTheme(settings?.theme);
  const { tab, loading: tabLoading, error: tabError } = useActiveTab();

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
      : derivePopupState({
          url,
          status: status.data ?? null,
          denyList: settings.denyList,
          persistentOrigins: settings.persistentOrigins,
        });

  return (
    <div className="popup">
      <header className="popup__head">
        <h1>StudyVault AI</h1>
        {state && 'host' in state && state.host ? (
          <p className="sv-muted sv-wrap">{state.host}</p>
        ) : null}
      </header>
      <main className="popup__main">
        {settingsError || tabError || status.error ? (
          <InlineNotice
            tone="error"
            title="StudyVault could not check this tab"
            action={
              <Button
                onClick={() => {
                  status.reload();
                }}
              >
                Retry
              </Button>
            }
          >
            {settingsError ?? tabError ?? status.error}
          </InlineNotice>
        ) : state === null || state.kind === 'loading' ? (
          <p role="status" className="sv-muted">
            Checking this tab…
          </p>
        ) : (
          <TabState
            tab={tab}
            state={state}
            lastBankId={settings?.lastBankId ?? null}
            onChanged={status.refresh}
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
}: {
  tab: ActiveTab | null;
  state: Exclude<PopupState, { kind: 'loading' }>;
  lastBankId: string | null;
  onChanged(): void;
}) {
  /** Why "Always enable" did not (fully) happen; shown as a warning in every state. */
  const [warning, setWarning] = useState<string | null>(null);

  const act = useAction(async (op: Op) => {
    if (!tab) throw new Error('There is no active tab.');
    setWarning(null);
    switch (op) {
      case 'activate':
        await callBackground('tab.activate', { tabId: tab.id });
        break;
      case 'enable': {
        if (state.kind !== 'inactive' && state.kind !== 'active') return;
        // First await in the click: Chrome needs the user gesture for the permission prompt.
        const { granted, notRegistered } = await grantSiteAccess([state.pattern]);
        if (!granted) {
          setWarning(
            `Chrome did not give StudyVault access to ${state.host}. Nothing was changed. You can still use "Activate on this tab".`,
          );
          return;
        }
        if (notRegistered.length > 0) {
          setWarning(
            `Chrome allowed StudyVault on ${state.host}, but StudyVault could not set it to start by itself on every visit. It is active on this tab now; after you reload or return, use "Activate on this tab" again.`,
          );
        }
        await callBackground('tab.activate', { tabId: tab.id });
        break;
      }
      case 'disable':
        if (state.kind === 'active') await revokeSiteAccess([state.pattern]);
        break;
      case 'allow':
        if (state.kind === 'denied') {
          const entries = state.entries;
          await editDenyList((list) => list.filter((e) => !entries.includes(e)));
        }
        break;
      case 'panel':
        // The click is the gesture sidePanel.open needs; nothing may be awaited before it.
        await browser.sidePanel.open({ windowId: tab.windowId });
        window.close();
        return;
    }
    onChanged();
  });

  const failure = act.error ? (
    <InlineNotice
      tone="error"
      title="That did not work"
      action={<Button onClick={act.retry}>Retry</Button>}
    >
      {act.error}
    </InlineNotice>
  ) : null;
  const warningNotice = warning ? (
    <InlineNotice tone="warning" live>
      {warning}
    </InlineNotice>
  ) : null;

  switch (state.kind) {
    case 'unsupported':
      return <Unsupported state={state} />;

    case 'denied':
      return (
        <div className="sv-stack">
          <InlineNotice tone="warning" title={`StudyVault is off on ${state.host}`}>
            <p>
              This site is on your deny list
              {state.entries.length > 0 ? ` (${state.entries.join(', ')})` : ''}, so the toolbar and
              highlights stay off here. Banks, mail, payment and sign-in sites are blocked by
              default.
            </p>
          </InlineNotice>
          {state.entries.length > 0 ? (
            <Button
              variant="primary"
              busy={act.busy}
              onClick={() => void act.run('allow')}
            >{`Allow StudyVault on ${state.host}`}</Button>
          ) : (
            <Button busy={act.busy} onClick={onChanged}>
              Check again
            </Button>
          )}
          {state.entries.length > 0 ? (
            <p className="sv-muted sv-small">
              This removes {state.entries.join(', ')} from the deny list, which also re-enables its
              subdomains. You can add it back in Settings.
            </p>
          ) : null}
          {failure}
        </div>
      );

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
        </div>
      );

    case 'active':
      return (
        <div className="sv-stack">
          {tab ? <PageSummary tabId={tab.id} url={tab.url} /> : null}
          <AccessLine state={state} busy={act.busy} run={act.run} />
          {warningNotice}
          {failure}
          <Button variant="primary" busy={act.busy} onClick={() => void act.run('panel')}>
            Open side panel
          </Button>
          <Banks lastBankId={lastBankId} />
          <Recent />
        </div>
      );
  }
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
          Extensions only run on http and https pages. Browser pages are blocked by Chrome, and
          local files (file://) are off by default and need a separate opt-in for each extension.
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
  const page = useAsync(() => callTab(tabId, 'content.pageStatus', {}), [tabId, url]);
  if (page.error) {
    return (
      <InlineNotice
        tone="error"
        title="Could not read this page"
        action={<Button onClick={page.reload}>Retry</Button>}
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
      <strong className="sv-wrap">{target.name}</strong>
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
          action={<Button onClick={recent.reload}>Retry</Button>}
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
              <p className="sv-quote popup__quote">{truncate(highlight.exactQuote, 200)}</p>
              <p className="sv-muted sv-small sv-wrap">
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
