import { browser } from 'wxt/browser';
import { ExternalLink, Keyboard, MousePointerClick } from 'lucide-react';
import { Button, IN_PAGE_KEYS, InlineNotice, shortcutsPageUrl, useAction, useShortcuts } from '@ui';
import { Act, Card, Keys } from './ui';

/**
 * Every keyboard command with the key it has right now. The list is Chrome's own answer
 * (`commands.getAll`): the user can clear or change any of them on the extensions shortcuts page,
 * and an unset command is shown as "Not set", not hidden.
 */
export function KeyboardShortcuts() {
  const { commands, error, retry } = useShortcuts();
  const open = useAction(async () => {
    // chrome:// pages cannot be linked from an extension page; they can be opened as a new tab.
    await browser.tabs.create({ url: shortcutsPageUrl(navigator.userAgent) });
  });

  return (
    <div className="opt-stack">
      <Card
        title="In any tab"
        icon={Keyboard}
        tone="neutral"
        info="Chrome decides which keys an extension may use, so a key can be unset when another extension or Chrome itself already uses it."
        aside={
          <Act size="sm" icon={ExternalLink} busy={open.busy} onClick={() => void open.run()}>
            Change in Chrome
          </Act>
        }
      >
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
          <ul className="opt-rows" aria-label="Browser shortcuts">
            {commands.map((c) => (
              <li key={c.name} className="opt-rowitem">
                <span className="opt-rowitem__text">{c.description || c.name}</span>
                <Keys shortcut={c.shortcut} />
              </li>
            ))}
          </ul>
        )}
        {commands?.some((c) => c.shortcut === '') ? (
          <p className="sv-muted sv-small" data-testid="shortcuts-unset-note">
            Chrome lets an extension suggest only four keys. Pick the rest with Change in Chrome.
          </p>
        ) : null}
        {open.error ? (
          <InlineNotice tone="error" title="Could not open the shortcuts page">
            {open.error}
          </InlineNotice>
        ) : null}
      </Card>

      <Card
        title="Inside a page"
        icon={MousePointerClick}
        tone="primary"
        info="These are fixed. They work while the page itself has focus and StudyVault is running on it."
      >
        <ul className="opt-rows" aria-label="In-page shortcuts">
          {IN_PAGE_KEYS.map((k) => (
            <li key={k.keys} className="opt-rowitem">
              <span className="opt-rowitem__text">{k.action}</span>
              <Keys shortcut={k.keys} />
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
