import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { browser } from 'wxt/browser';
import { DEFAULT_DENY_HOSTS, DENY_LIST_SCOPE_NOTE, type Settings } from '@shared';
import {
  ALL_SITES_ORIGINS,
  Badge,
  Button,
  ConfirmDialog,
  InlineNotice,
  editDenyList,
  grantSiteAccess,
  revokeSiteAccess,
  useAction,
  useAsync,
  useToast,
} from '@ui';
import {
  addDenyEntry,
  missingDefaults,
  removeDenyEntry,
  sortedDeny,
  splitOrigins,
  type SiteEntry,
} from './model';

/** Chrome fires these when access is granted or revoked, including from chrome://extensions. */
function usePermissionChanges(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    const { onAdded, onRemoved } = browser.permissions;
    onAdded?.addListener(bump);
    onRemoved?.addListener(bump);
    return () => {
      onAdded?.removeListener(bump);
      onRemoved?.removeListener(bump);
    };
  }, []);
  return tick;
}

/** Above this many missing starter sites the list is summarised, not spelled out. */
const MAX_NAMED = 8;

export function SiteAccess({ settings }: { settings: Settings }) {
  const headingId = useId();
  const { announce } = useToast();
  const changes = usePermissionChanges();
  const { allSites: listedAll, sites } = splitOrigins(settings.persistentOrigins);
  const listKey = settings.persistentOrigins.join('\n');
  const [warning, setWarning] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  // Focus lands on these headings when the button that had it is replaced or removed.
  const allHeading = useRef<HTMLHeadingElement>(null);
  const sitesHeading = useRef<HTMLHeadingElement>(null);

  const grants = useAsync(
    async () => {
      const [all, each] = await Promise.all([
        browser.permissions.contains({ origins: [...ALL_SITES_ORIGINS] }),
        Promise.all(sites.map((s) => browser.permissions.contains({ origins: [s.pattern] }))),
      ]);
      return { all, each };
    },
    [listKey],
    [changes],
  );

  const allAct = useAction(async (op: 'enable' | 'revoke') => {
    setWarning(null);
    if (op === 'enable') {
      // First await in the click: Chrome needs the user gesture for the permission prompt.
      const { granted, notRegistered } = await grantSiteAccess(ALL_SITES_ORIGINS);
      if (!granted) {
        const text =
          'Chrome did not grant access to all sites. Nothing was changed; StudyVault keeps working on the tabs and sites you enable one by one.';
        setWarning(text);
        announce(text);
        return;
      }
      if (notRegistered.length > 0) {
        const text =
          'Chrome granted access to all sites, but StudyVault could not set itself to start there automatically. Reload the extension or try again.';
        setWarning(text);
        announce(text);
      } else {
        announce('StudyVault is now on for all sites.');
      }
    } else {
      await revokeSiteAccess(ALL_SITES_ORIGINS);
      announce('All-sites access revoked.');
    }
    grants.refresh();
    allHeading.current?.focus();
  });

  const siteAct = useAction(async (site: SiteEntry) => {
    await revokeSiteAccess([site.pattern]);
    grants.refresh();
    announce(`Revoked access for ${site.host}.`);
    sitesHeading.current?.focus();
  });

  const grantedAll = grants.data?.all ?? false;
  const allOn = grantedAll && listedAll;
  const stayOff = sortedDeny(settings.denyList);

  return (
    <section className="sv-stack" aria-labelledby={headingId}>
      <h2 id={headingId}>Site access</h2>
      <p>
        StudyVault reads a page only after you ask. There are three levels, from narrowest to
        widest:
      </p>
      <dl className="opt-modes">
        <div>
          <dt>This tab</dt>
          <dd>
            Click the StudyVault toolbar button on a page. It works in that tab until you navigate
            away or reload. No extra permission is needed.
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
            Below. StudyVault runs automatically on every http and https page except the sites on
            your deny list. Most people do not need this.
          </dd>
        </div>
      </dl>

      <div className="opt-card sv-stack sv-stack--tight">
        <h3 ref={allHeading} tabIndex={-1}>
          All sites
        </h3>
        <p>
          {grants.loading ? (
            'Checking Chrome…'
          ) : allOn ? (
            <>
              <Badge tone="success" glyph="✓">
                On
              </Badge>{' '}
              StudyVault runs on every site that is not on the deny list.
            </>
          ) : grantedAll ? (
            <>
              <Badge tone="warning" glyph="!">
                Allowed by Chrome, not in use
              </Badge>{' '}
              Chrome lets StudyVault run everywhere, but StudyVault is not set to use it yet.
            </>
          ) : (
            <>
              <Badge glyph="–">Off</Badge> StudyVault runs only where you enabled it.
            </>
          )}
        </p>
        <p className="sv-muted sv-small">
          Turning this on shows Chrome&apos;s permission prompt for reading and changing pages on
          all websites. Your highlights stay on this device either way, and you can revoke access
          here at any time.
        </p>
        {warning ? <InlineNotice tone="warning">{warning}</InlineNotice> : null}
        {allAct.error || grants.error ? (
          <InlineNotice
            tone="error"
            title="That did not work"
            action={
              (allAct.error ? allAct.retryable : grants.retryable) ? (
                <Button
                  busy={allAct.error ? allAct.busy : grants.refreshing}
                  onClick={allAct.error ? allAct.retry : grants.refresh}
                >
                  Retry
                </Button>
              ) : undefined
            }
          >
            {allAct.error ?? grants.error}
          </InlineNotice>
        ) : null}
        <div className="sv-row">
          {allOn ? null : (
            <Button variant="primary" busy={allAct.busy} onClick={() => setAsking(true)}>
              Enable on all sites
            </Button>
          )}
          {grantedAll || listedAll ? (
            <Button busy={allAct.busy} onClick={() => void allAct.run('revoke')}>
              Revoke all-sites access
            </Button>
          ) : null}
        </div>
      </div>

      {asking ? (
        <ConfirmDialog
          title="Turn StudyVault on for all sites?"
          confirmLabel="Continue to Chrome's prompt"
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            // This click is the user gesture permissions.request needs: it is the first await.
            setAsking(false);
            void allAct.run('enable');
          }}
        >
          <p>
            StudyVault will start by itself on every http and https page you open, except the sites
            on your deny list. It reads the page text to place your highlights; nothing leaves this
            device.
          </p>
          <p>{DENY_LIST_SCOPE_NOTE}</p>
          {stayOff.length === 0 ? (
            <p>
              <strong>Your deny list is empty</strong>, so StudyVault would also run on sign-in,
              mail and banking pages.
            </p>
          ) : (
            <>
              <p>
                <strong>StudyVault will stay off on these {stayOff.length} sites</strong> and their
                subdomains. Any site not listed is included.
              </p>
              <div
                className="sv-dialog__scroll"
                role="region"
                aria-label="Sites on your deny list"
                tabIndex={0}
              >
                <ul className="sv-stack sv-stack--tight">
                  {stayOff.map((host) => (
                    <li key={host} className="sv-wrap">
                      {host}
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
          <p>Add your own sites to the deny list before you continue if they are not shown.</p>
          <p className="sv-muted sv-small">Chrome then asks for its own confirmation.</p>
        </ConfirmDialog>
      ) : null}

      <div className="opt-card sv-stack sv-stack--tight">
        <h3 ref={sitesHeading} tabIndex={-1}>
          Sites enabled one by one
        </h3>
        {sites.length === 0 ? (
          <p className="sv-muted">
            None yet. Open a page, click the StudyVault button and choose &ldquo;Always enable
            on&hellip;&rdquo;.
          </p>
        ) : (
          <ul className="opt-list">
            {sites.map((site, i) => {
              const granted = grants.data?.each[i];
              return (
                <li key={site.pattern} className="opt-item">
                  <span className="sv-grow sv-wrap">{site.host}</span>
                  {granted === undefined ? null : granted ? (
                    <Badge tone="success" glyph="✓">
                      Allowed
                    </Badge>
                  ) : (
                    <Badge tone="warning" glyph="!">
                      Not allowed in Chrome
                    </Badge>
                  )}
                  <Button
                    busy={siteAct.busy}
                    aria-label={`Revoke access for ${site.host}`}
                    onClick={() => void siteAct.run(site)}
                  >
                    Revoke
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        {siteAct.error ? (
          <InlineNotice
            tone="error"
            title="That did not work"
            action={
              siteAct.retryable ? (
                <Button busy={siteAct.busy} onClick={siteAct.retry}>
                  Retry
                </Button>
              ) : undefined
            }
          >
            {siteAct.error}
          </InlineNotice>
        ) : null}
      </div>

      <DenyList settings={settings} />
    </section>
  );
}

function DenyList({ settings }: { settings: Settings }) {
  const uid = useId();
  const { announce } = useToast();
  const heading = useRef<HTMLHeadingElement>(null);
  const edit = useAction(
    async (change: (list: string[]) => string[], spoken: string, focusHeading: boolean) => {
      await editDenyList(change);
      announce(spoken);
      // A removed row takes its button (and focus) with it.
      if (focusHeading) heading.current?.focus();
    },
  );
  const defaults = [...DEFAULT_DENY_HOSTS];
  const lacking = missingDefaults(settings.denyList, defaults);

  return (
    <div className="opt-card sv-stack sv-stack--tight" role="group" aria-labelledby={`${uid}-h`}>
      <h3 id={`${uid}-h`} ref={heading} tabIndex={-1}>
        Deny list
      </h3>
      <p>
        StudyVault is switched off on these sites and all of their subdomains: no toolbar, no
        highlights, nothing saved.
      </p>
      <p>{DENY_LIST_SCOPE_NOTE}</p>
      <AddSite
        denyList={settings.denyList}
        busy={edit.busy}
        onAdd={(host) =>
          void edit.run(
            (list) => [...list.filter((h) => h !== host), host],
            `Added ${host} to the deny list.`,
            false,
          )
        }
      />
      {edit.error ? (
        <InlineNotice
          tone="error"
          title="Could not update the deny list"
          action={
            edit.retryable ? (
              <Button busy={edit.busy} onClick={edit.retry}>
                Retry
              </Button>
            ) : undefined
          }
        >
          {edit.error}
        </InlineNotice>
      ) : null}
      {settings.denyList.length === 0 ? (
        <p className="sv-muted">The deny list is empty: StudyVault may run on any enabled site.</p>
      ) : (
        <ul className="opt-list">
          {sortedDeny(settings.denyList).map((host) => (
            <li key={host} className="opt-item">
              <span className="sv-grow sv-wrap">{host}</span>
              {defaults.includes(host) ? <Badge>Default</Badge> : null}
              <Button
                busy={edit.busy}
                aria-label={`Remove ${host} from the deny list`}
                onClick={() =>
                  void edit.run(
                    (list) => removeDenyEntry(list, host),
                    `Removed ${host} from the deny list.`,
                    true,
                  )
                }
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="sv-stack sv-stack--tight">
        <Button
          busy={edit.busy}
          disabledReason={
            lacking.length === 0 ? 'All default sites are already on the list.' : undefined
          }
          onClick={() =>
            void edit.run(
              (list) => [...list, ...missingDefaults(list, defaults)],
              'Default sites restored to the deny list.',
              false,
            )
          }
        >
          Restore default sites
        </Button>
        {lacking.length === 0 ? (
          <p className="sv-muted sv-small" aria-hidden="true">
            All default sites are already on the list.
          </p>
        ) : (
          <p className="sv-muted sv-small">
            {lacking.length <= MAX_NAMED
              ? `Missing: ${lacking.join(', ')}.`
              : `${lacking.length} of the ${defaults.length} starter sites are not on your list yet (a list saved by an earlier version is shorter).`}{' '}
            Restoring adds the missing ones; the sites you added yourself stay.
          </p>
        )}
      </div>
    </div>
  );
}

/** Own component so typing re-renders this form, not the (long) list below it. */
function AddSite({
  denyList,
  busy,
  onAdd,
}: {
  denyList: readonly string[];
  busy: boolean;
  onAdd(host: string): void;
}) {
  const uid = useId();
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const result = addDenyEntry(denyList, text);
    if (!result.ok) {
      setProblem(result.error);
      return;
    }
    setProblem(null);
    setText('');
    onAdd(result.host);
  };

  return (
    <form className="sv-stack sv-stack--tight" onSubmit={submit} noValidate>
      <label className="sv-label" htmlFor={`${uid}-input`}>
        Add a site
      </label>
      <div className="sv-row">
        <input
          id={`${uid}-input`}
          className="sv-control opt-input"
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="example.com"
          value={text}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${uid}-err` : undefined}
          onChange={(e) => {
            setText(e.target.value);
            setProblem(null);
          }}
        />
        <Button type="submit" variant="primary" busy={busy}>
          Add to deny list
        </Button>
      </div>
      {problem ? (
        <p id={`${uid}-err`} role="alert" className="opt-error">
          {problem}
        </p>
      ) : null}
    </form>
  );
}
