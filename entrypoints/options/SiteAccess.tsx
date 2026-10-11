import { useEffect, useId, useState, type FormEvent } from 'react';
import { browser } from 'wxt/browser';
import { DEFAULT_DENY_HOSTS, type Settings } from '@shared';
import {
  ALL_SITES_ORIGINS,
  Badge,
  Button,
  InlineNotice,
  editDenyList,
  grantSiteAccess,
  revokeSiteAccess,
  useAction,
  useAsync,
} from '@ui';
import { addDenyEntry, missingDefaults, removeDenyEntry, sortedDeny, splitOrigins } from './model';

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

type Op = { t: 'enable-all' } | { t: 'revoke-all' } | { t: 'revoke-site'; pattern: string };

export function SiteAccess({ settings }: { settings: Settings }) {
  const headingId = useId();
  const changes = usePermissionChanges();
  const { allSites: listedAll, sites } = splitOrigins(settings.persistentOrigins);
  const listKey = settings.persistentOrigins.join('\n');
  const [warning, setWarning] = useState<string | null>(null);

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

  const act = useAction(async (op: Op) => {
    setWarning(null);
    switch (op.t) {
      case 'enable-all': {
        // First await in the click: Chrome needs the user gesture for the permission prompt.
        const { granted, notRegistered } = await grantSiteAccess(ALL_SITES_ORIGINS);
        if (!granted) {
          setWarning(
            'Chrome did not grant access to all sites. Nothing was changed; StudyVault keeps working on the tabs and sites you enable one by one.',
          );
        } else if (notRegistered.length > 0) {
          setWarning(
            'Chrome granted access to all sites, but StudyVault could not set itself to start there automatically. Reload the extension or try again.',
          );
        }
        break;
      }
      case 'revoke-all':
        await revokeSiteAccess(ALL_SITES_ORIGINS);
        break;
      case 'revoke-site':
        await revokeSiteAccess([op.pattern]);
        break;
    }
    grants.refresh();
  });

  const grantedAll = grants.data?.all ?? false;
  const allOn = grantedAll && listedAll;

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

      {warning ? (
        <InlineNotice tone="warning" live>
          {warning}
        </InlineNotice>
      ) : null}
      {act.error || grants.error ? (
        <InlineNotice
          tone="error"
          title="That did not work"
          action={<Button onClick={act.error ? act.retry : grants.reload}>Retry</Button>}
        >
          {act.error ?? grants.error}
        </InlineNotice>
      ) : null}

      <div className="opt-card sv-stack sv-stack--tight">
        <h3>All sites</h3>
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
        <div className="sv-row">
          {allOn ? null : (
            <Button
              variant="primary"
              busy={act.busy}
              onClick={() => void act.run({ t: 'enable-all' })}
            >
              Enable on all sites
            </Button>
          )}
          {grantedAll || listedAll ? (
            <Button busy={act.busy} onClick={() => void act.run({ t: 'revoke-all' })}>
              Revoke all-sites access
            </Button>
          ) : null}
        </div>
      </div>

      <div className="opt-card sv-stack sv-stack--tight">
        <h3>Sites enabled one by one</h3>
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
                    busy={act.busy}
                    aria-label={`Revoke access for ${site.host}`}
                    onClick={() => void act.run({ t: 'revoke-site', pattern: site.pattern })}
                  >
                    Revoke
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <DenyList settings={settings} />
    </section>
  );
}

function DenyList({ settings }: { settings: Settings }) {
  const uid = useId();
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const edit = useAction(async (change: (list: string[]) => string[]) => {
    await editDenyList(change);
  });
  const defaults = [...DEFAULT_DENY_HOSTS];
  const lacking = missingDefaults(settings.denyList, defaults);

  const onAdd = (e: FormEvent) => {
    e.preventDefault();
    const result = addDenyEntry(settings.denyList, text);
    if (!result.ok) {
      setProblem(result.error);
      return;
    }
    setProblem(null);
    setText('');
    void edit.run((list) => [...list.filter((h) => h !== result.host), result.host]);
  };

  return (
    <div className="opt-card sv-stack sv-stack--tight" role="group" aria-labelledby={`${uid}-h`}>
      <h3 id={`${uid}-h`}>Deny list</h3>
      <p>
        StudyVault is switched off on these sites and all of their subdomains: no toolbar, no
        highlights, nothing saved. Banks, payment, mail and sign-in sites are listed by default.
      </p>
      <form className="sv-stack sv-stack--tight" onSubmit={onAdd} noValidate>
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
          <Button type="submit" variant="primary" busy={edit.busy}>
            Add to deny list
          </Button>
        </div>
        {problem ? (
          <p id={`${uid}-err`} role="alert" className="opt-error">
            {problem}
          </p>
        ) : null}
      </form>
      {edit.error ? (
        <InlineNotice
          tone="error"
          title="Could not update the deny list"
          action={<Button onClick={edit.retry}>Retry</Button>}
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
                onClick={() => void edit.run((list) => removeDenyEntry(list, host))}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button
          busy={edit.busy}
          disabledReason={
            lacking.length === 0 ? 'All default sites are already on the list.' : undefined
          }
          onClick={() => void edit.run((list) => [...list, ...missingDefaults(list, defaults)])}
        >
          Restore default sites
        </Button>
        {lacking.length === 0 ? (
          <p className="sv-muted sv-small" aria-hidden="true">
            All default sites are already on the list.
          </p>
        ) : (
          <p className="sv-muted sv-small">Missing: {lacking.join(', ')}.</p>
        )}
      </div>
    </div>
  );
}
