import { Button, InlineNotice, ToastProvider, useApplyTheme, useSettings } from '@ui';
import { Appearance, Capture } from './Preferences';
import { About, Privacy } from './Privacy';
import { KeyboardShortcuts } from './Shortcuts';
import { SiteAccess } from './SiteAccess';

export function Options() {
  return (
    <ToastProvider>
      <OptionsBody />
    </ToastProvider>
  );
}

function OptionsBody() {
  const { settings, error, retry, update } = useSettings();
  useApplyTheme(settings?.theme);

  return (
    <div className="opt">
      <header className="opt__head">
        <h1>StudyVault settings</h1>
        <nav aria-label="Sections">
          <ul className="sv-row opt__nav">
            <li>
              <a href="#site-access">Site access</a>
            </li>
            <li>
              <a href="#appearance">Appearance</a>
            </li>
            <li>
              <a href="#capture">Capture</a>
            </li>
            <li>
              <a href="#shortcuts">Keyboard shortcuts</a>
            </li>
            <li>
              <a href="#privacy">Privacy</a>
            </li>
          </ul>
        </nav>
      </header>

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
            <div id="shortcuts">
              <KeyboardShortcuts />
            </div>
            <div id="privacy" className="sv-stack">
              <Privacy />
              <About />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
