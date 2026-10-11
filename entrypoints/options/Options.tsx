import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { Button, InlineNotice, ToastProvider, useAction, useApplyTheme, useSettings } from '@ui';
import { AiSettingsSection } from '@ui/ai';
import { BackupSection } from '@ui/backup';
import { reviewPageUrl } from '@ui/review/links';
import { SyncSection } from '@ui/sync';
import { openOnboarding } from '@ui/shell/open';
import {
  getOnboardingState,
  watchOnboardingState,
  type OnboardingState,
} from '@ui/shell/onboardingState';
import { openDashboard } from '@ui/vault/dashboardLink';
import { YourData } from './Data';
import { SectionNav } from './Nav';
import { Appearance, Capture } from './Preferences';
import { About, Privacy } from './Privacy';
import { ReviewSection } from './ReviewSection';
import { KeyboardShortcuts } from './Shortcuts';
import { SiteAccess } from './SiteAccess';
import { Storage } from './Storage';
import { sectionFromHash } from './model';

export function Options() {
  return (
    <ToastProvider>
      <OptionsBody />
    </ToastProvider>
  );
}

/** Where the welcome tour stands, so the button can say "Resume" instead of "Show". */
function useTourState(): OnboardingState | null {
  const [state, setState] = useState<OnboardingState | null>(null);
  useEffect(() => {
    let live = true;
    getOnboardingState().then(
      (s) => {
        if (live) setState((cur) => cur ?? s);
      },
      () => undefined, // The button then just offers the tour; nothing else depends on this.
    );
    const stop = watchOnboardingState((s) => setState(s));
    return () => {
      live = false;
      stop();
    };
  }, []);
  return state;
}

function QuickActions({ reviewOn }: { reviewOn: boolean }) {
  const tour = useTourState();
  const dashboard = useAction(() => openDashboard());
  const review = useAction(async () => {
    await browser.tabs.create({ url: reviewPageUrl({ view: 'study' }) });
  });
  const welcome = useAction(() => openOnboarding());
  const resume = tour?.status === 'pending' && tour.step !== 'welcome';
  const failure = dashboard.error ?? review.error ?? welcome.error;
  return (
    <div className="sv-stack sv-stack--tight">
      <div className="sv-row" role="group" aria-label="Open StudyVault">
        <Button busy={dashboard.busy} onClick={() => void dashboard.run()}>
          Open dashboard
        </Button>
        <Button
          busy={review.busy}
          {...(reviewOn ? {} : { disabledReason: 'Review is turned off in the Review section.' })}
          onClick={() => void review.run()}
        >
          Open review
        </Button>
        <Button busy={welcome.busy} onClick={() => void welcome.run()}>
          {resume ? 'Resume the welcome tour' : 'Show the welcome tour'}
        </Button>
      </div>
      {failure ? (
        <InlineNotice tone="error" title="Could not open that page">
          {failure}
        </InlineNotice>
      ) : null}
    </div>
  );
}

function OptionsBody() {
  const { settings, error, retry, update } = useSettings();
  useApplyTheme(settings?.theme);
  const ready = settings !== null;

  // The sections render after the settings are read, so the browser cannot scroll to a deep link
  // (options.html#ai) by itself: do it once they exist.
  useEffect(() => {
    if (!ready) return;
    const id = sectionFromHash(window.location.hash);
    if (id) document.getElementById(id)?.scrollIntoView?.();
  }, [ready]);

  return (
    <div className="opt">
      <header className="opt__head">
        <h1>StudyVault settings</h1>
        {settings ? <QuickActions reviewOn={settings.features.review} /> : null}
      </header>

      <div className="opt__layout">
        {settings ? <SectionNav /> : null}
        <main className="opt__main">
          {error ? (
            <InlineNotice
              tone="error"
              title="Could not read your settings"
              action={<Button onClick={retry}>Retry</Button>}
            >
              {error}
            </InlineNotice>
          ) : settings === null ? (
            <p className="sv-muted">Loading settings…</p>
          ) : (
            <>
              <div id="site-access">
                <SiteAccess settings={settings} />
              </div>
              <div id="appearance">
                <Appearance settings={settings} update={update} />
              </div>
              <div id="capture">
                <Capture settings={settings} update={update} />
              </div>
              <div id="review">
                <ReviewSection settings={settings} update={update} />
              </div>
              <div id="ai">
                <AiSettingsSection />
              </div>
              <div id="sync">
                <SyncSection />
              </div>
              <div id="backup">
                <BackupSection appVersion={browser.runtime.getManifest().version} />
              </div>
              <div id="storage">
                <Storage />
              </div>
              <div id="shortcuts">
                <KeyboardShortcuts />
              </div>
              <div id="privacy" className="sv-stack">
                <Privacy />
                <About />
              </div>
              <div id="data">
                <YourData />
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
