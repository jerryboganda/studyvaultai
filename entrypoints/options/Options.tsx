import { type Settings } from '@shared';
import { Button, InlineNotice, useAction, useApplyTheme, useSettings } from '@ui';
import { Appearance, Capture } from './Preferences';
import { About, Privacy } from './Privacy';
import { SiteAccess } from './SiteAccess';

export function Options() {
  const { settings, error, update } = useSettings();
  useApplyTheme(settings?.theme);

  // Every preference write goes through updateSettings; failures stay visible with a retry.
  const save = useAction(async (mutate: (s: Settings) => Settings) => {
    await update(mutate);
  });

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
              <a href="#privacy">Privacy</a>
            </li>
          </ul>
        </nav>
      </header>

      <main className="opt__main">
        {error ? (
          <InlineNotice tone="error" title="Could not read your settings">
            {error}
          </InlineNotice>
        ) : settings === null ? (
          <p className="sv-muted" role="status">
            Loading settings…
          </p>
        ) : (
          <>
            {save.error ? (
              <InlineNotice
                tone="error"
                title="Your change was not saved"
                action={<Button onClick={save.retry}>Retry</Button>}
              >
                {save.error}
              </InlineNotice>
            ) : null}
            <div id="site-access">
              <SiteAccess settings={settings} />
            </div>
            <div id="appearance">
              <Appearance settings={settings} write={(m) => void save.run(m)} />
            </div>
            <div id="capture">
              <Capture settings={settings} write={(m) => void save.run(m)} />
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
