import { useId } from 'react';
import { browser } from 'wxt/browser';
import {
  Button,
  IN_PAGE_KEYS,
  InlineNotice,
  Kbd,
  shortcutsPageUrl,
  useAction,
  useShortcuts,
} from '@ui';

/**
 * Every keyboard command with the key it has right now. The list is Chrome's own answer
 * (`commands.getAll`): the user can clear or change any of them on the extensions shortcuts page,
 * and an unset command is shown as "Not set", not hidden.
 */
export function KeyboardShortcuts() {
  const uid = useId();
  const { commands, error, retry } = useShortcuts();
  const open = useAction(async () => {
    // chrome:// pages cannot be linked from an extension page; they can be opened as a new tab.
    await browser.tabs.create({ url: shortcutsPageUrl(navigator.userAgent) });
  });

  return (
    <section className="sv-stack" aria-labelledby={`${uid}-h`}>
      <h2 id={`${uid}-h`}>Keyboard shortcuts</h2>
      <p>
        These keys work from any tab. Chrome decides which keys an extension may use, so a key can
        be unset when another extension or Chrome itself already uses it.
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
        <ul className="opt-list" aria-label="Browser shortcuts">
          {commands.map((c) => (
            <li key={c.name} className="opt-item">
              <span className="sv-grow">{c.description || c.name}</span>
              <Kbd shortcut={c.shortcut} />
            </li>
          ))}
        </ul>
      )}
      {commands?.some((c) => c.shortcut === '') ? (
        <p className="sv-muted sv-small" data-testid="shortcuts-unset-note">
          Chrome lets an extension suggest only four keys, so some commands start as “Not set”, for
          example the one that opens the side panel on the search box. Choose a key for them with
          the button below.
        </p>
      ) : null}

      <div className="sv-stack sv-stack--tight">
        <h3>Inside a page</h3>
        <p className="sv-muted">
          These two are fixed and only work while the page itself has focus and StudyVault is
          running on it.
        </p>
        <ul className="opt-list" aria-label="In-page shortcuts">
          {IN_PAGE_KEYS.map((k) => (
            <li key={k.keys} className="opt-item">
              <span className="sv-grow">{k.action}</span>
              <Kbd shortcut={k.keys} />
            </li>
          ))}
        </ul>
      </div>

      <div className="sv-stack sv-stack--tight">
        <div>
          <Button busy={open.busy} onClick={() => void open.run()}>
            Change shortcuts in Chrome
          </Button>
        </div>
        <p className="sv-muted sv-small">
          Opens {shortcutsPageUrl(navigator.userAgent)} in a new tab, where Chrome lets you assign
          or clear each key.
        </p>
        {open.error ? (
          <InlineNotice tone="error" title="Could not open the shortcuts page">
            {open.error}
          </InlineNotice>
        ) : null}
      </div>
    </section>
  );
}
