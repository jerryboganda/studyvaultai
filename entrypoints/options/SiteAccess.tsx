import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { Check, Earth, Globe, KeyRound, MousePointerClick, Plus, X } from 'lucide-react';
import type { Settings } from '@shared';
import { getAiEndpointPatterns } from '@storage';
import {
  ALL_SITES_ORIGINS,
  Badge,
  BuddyEmptyState,
  Button,
  IconButton,
  InlineNotice,
  VaultBuddy,
  grantSiteAccess,
  plural,
  revokeSiteAccess,
  useAction,
  useAsync,
  useToast,
} from '@ui';
import { useSyncApi } from '@ui/sync';
import { DenyList } from './DenyList';
import { SiteWizard, type SitePlan } from './SiteWizard';
import { originKey, otherGrants, splitOrigins, type SiteEntry } from './model';
import { Act, Card } from './ui';

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

const LEVELS_INFO =
  'This tab: turn it on from the popup; it works there until you leave. One site: Chrome asks about that site, and it stays on there. All sites: StudyVault runs everywhere except your deny list.';

export function SiteAccess({ settings }: { settings: Settings }) {
  const { announce } = useToast();
  const changes = usePermissionChanges();
  const { allSites: listedAll, sites } = splitOrigins(settings.persistentOrigins);
  const listKey = settings.persistentOrigins.join('\n');
  const [warning, setWarning] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  // Focus lands on these headings when the button that had it is replaced or removed.
  const whereHeading = useRef<HTMLHeadingElement>(null);
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

  const tell = (text: string, ok: boolean) => {
    if (ok) setDone(text);
    else setWarning(text);
    announce(text);
  };

  const allAct = useAction(async (op: 'enable' | 'revoke') => {
    setWarning(null);
    setDone(null);
    if (op === 'enable') {
      // First await in the click: Chrome needs the user gesture for the permission prompt.
      const { granted, notRegistered } = await grantSiteAccess(ALL_SITES_ORIGINS);
      if (!granted) tell('Chrome did not grant access to all sites. Nothing changed.', false);
      else if (notRegistered.length > 0) {
        tell(
          'Chrome granted access to all sites, but StudyVault could not set itself to start there. Reload the extension or try again.',
          false,
        );
      } else tell('StudyVault is now on for all sites.', true);
    } else {
      await revokeSiteAccess(ALL_SITES_ORIGINS);
      announce('All-sites access revoked.');
    }
    grants.refresh();
    whereHeading.current?.focus();
  });

  const sitesAct = useAction(async (picks: Array<{ pattern: string; host: string }>) => {
    setWarning(null);
    setDone(null);
    const names = picks.map((p) => p.host).join(', ');
    // First await in the click, as above.
    const { granted, notRegistered } = await grantSiteAccess(picks.map((p) => p.pattern));
    if (!granted) tell(`Chrome did not grant access to ${names}. Nothing changed.`, false);
    else if (notRegistered.length > 0) {
      tell(
        `Chrome granted access, but StudyVault could not set itself to start on ${names}.`,
        false,
      );
    } else tell(`StudyVault is now on for ${names}.`, true);
    grants.refresh();
    sitesHeading.current?.focus();
  });

  const siteAct = useAction(async (site: SiteEntry) => {
    await revokeSiteAccess([site.pattern]);
    grants.refresh();
    announce(`Revoked access for ${site.host}.`);
    sitesHeading.current?.focus();
  });

  const grantedAll = grants.data?.all ?? false;
  const allOn = grantedAll && listedAll;
  const allState = grants.loading
    ? { text: 'Checking…', tone: 'neutral' as const }
    : allOn
      ? { text: 'On', tone: 'success' as const }
      : grantedAll
        ? { text: 'Not in use', tone: 'warning' as const }
        : { text: 'Off', tone: 'neutral' as const };
  const busy = allAct.busy || sitesAct.busy;
  const failure = allAct.error ?? sitesAct.error ?? grants.error;

  const finish = (plan: SitePlan) => {
    setAsking(false);
    // Still inside the wizard's last click: the request below is its first await.
    if (plan.scope === 'all') void allAct.run('enable');
    else void sitesAct.run(plan.picks);
  };

  return (
    <div className="opt-stack">
      <Card title="Where it runs" icon={Globe} headingRef={whereHeading} info={LEVELS_INFO}>
        <ul className="opt-levels" aria-label="Where StudyVault runs">
          <li className="opt-level-tile">
            <span className="opt-art sv-art--neutral" aria-hidden="true">
              <MousePointerClick strokeWidth={2.4} />
            </span>
            <span className="opt-level-tile__label">This tab</span>
            <span className="opt-level-tile__state">From the popup</span>
          </li>
          <li className="opt-level-tile">
            <span className="opt-art sv-art--primary" aria-hidden="true">
              <Globe strokeWidth={2.4} />
            </span>
            <span className="opt-level-tile__label">Your sites</span>
            <span className="opt-level-tile__state">
              {sites.length > 0 ? plural(sites.length, 'site') : 'None yet'}
            </span>
          </li>
          <li className="opt-level-tile">
            <span className="opt-art sv-art--warning" aria-hidden="true">
              <Earth strokeWidth={2.4} />
            </span>
            <span className="opt-level-tile__label">All sites</span>
            <Badge tone={allState.tone} glyph={allOn ? '✓' : undefined}>
              {allState.text}
            </Badge>
          </li>
        </ul>
        {grantedAll && !listedAll && !grants.loading ? (
          <p className="opt-line">Chrome allows all sites, but StudyVault is not set to use it.</p>
        ) : null}
        {warning ? <InlineNotice tone="warning">{warning}</InlineNotice> : null}
        {done ? (
          <div className="opt-done" role="group" aria-label="Done">
            <VaultBuddy pose="cheer" size={56} />
            <p>
              <strong>All set!</strong> {done}
            </p>
          </div>
        ) : null}
        {failure ? (
          <InlineNotice
            tone="error"
            title="That did not work"
            action={
              (
                allAct.error
                  ? allAct.retryable
                  : sitesAct.error
                    ? sitesAct.retryable
                    : grants.retryable
              ) ? (
                <Button
                  busy={
                    allAct.error ? allAct.busy : sitesAct.error ? sitesAct.busy : grants.refreshing
                  }
                  onClick={
                    allAct.error ? allAct.retry : sitesAct.error ? sitesAct.retry : grants.refresh
                  }
                >
                  Retry
                </Button>
              ) : undefined
            }
          >
            {failure}
          </InlineNotice>
        ) : null}
        <div className="sv-row">
          <Act variant="primary" icon={Plus} busy={busy} onClick={() => setAsking(true)}>
            Choose sites
          </Act>
          {grantedAll || listedAll ? (
            <Button busy={allAct.busy} onClick={() => void allAct.run('revoke')}>
              Revoke all sites
            </Button>
          ) : null}
        </div>
      </Card>

      {asking ? (
        <SiteWizard settings={settings} onClose={() => setAsking(false)} onFinish={finish} />
      ) : null}

      <Card
        title="Your sites"
        icon={Check}
        tone="success"
        headingRef={sitesHeading}
        aside={
          sites.length > 0 ? (
            <span className="opt-count">{plural(sites.length, 'site')}</span>
          ) : null
        }
      >
        {sites.length === 0 ? (
          <BuddyEmptyState
            pose="sleep"
            mascotSize={72}
            title="No sites yet"
            text="Add one with Choose sites, or from the popup."
          />
        ) : (
          <ul className="opt-rows">
            {sites.map((site, i) => {
              const granted = grants.data?.each[i];
              return (
                <li key={site.pattern} className="opt-rowitem">
                  <Globe aria-hidden="true" strokeWidth={2.4} className="opt-rowitem__icon" />
                  <span className="opt-rowitem__text" dir="ltr">
                    {site.host}
                  </span>
                  {granted === undefined ? null : granted ? (
                    <Badge tone="success" glyph="✓">
                      Allowed
                    </Badge>
                  ) : (
                    <Badge tone="warning" glyph="!">
                      Not allowed in Chrome
                    </Badge>
                  )}
                  <IconButton
                    icon={X}
                    tipSide="left"
                    label={`Revoke access for ${site.host}`}
                    aria-disabled={siteAct.busy || undefined}
                    onClick={() => {
                      if (!siteAct.busy) void siteAct.run(site);
                    }}
                  />
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
      </Card>

      <DenyList settings={settings} />

      <OtherAccess settings={settings} changes={changes} />
    </div>
  );
}

/**
 * Access Chrome holds for one address at a time that no card above lists: the AI provider, the
 * sync server and its sign-in provider, and whatever else was granted from a click (a PDF's site
 * while its download runs). Chrome's own page is the only other place to see it.
 */
function OtherAccess({ settings, changes }: { settings: Settings; changes: number }) {
  const { announce } = useToast();
  const syncApi = useSyncApi();
  const heading = useRef<HTMLHeadingElement>(null);
  const listKey = settings.persistentOrigins.join('\n');

  const grants = useAsync(
    async () => (await browser.permissions.getAll?.())?.origins ?? [],
    [listKey],
    [changes],
  );
  // What an address is for is a best-effort lookup of its own, so a slow or failing worker never
  // holds the list back: until it answers, an address reads "Other".
  const known = useAsync(
    async () => {
      const [ai, status] = await Promise.all([
        getAiEndpointPatterns().catch((): string[] => []),
        syncApi.status().catch(() => null),
      ]);
      const key = (address: string | null | undefined) => (address ? originKey(address) : null);
      return {
        ai: ai.flatMap((address) => key(address) ?? []),
        syncServer: key(status?.config?.serverUrl),
        syncIssuer: key(status?.config?.issuer),
      };
    },
    [],
    [changes],
  );

  const revoke = useAction(async (grant: { pattern: string; origin: string }) => {
    // `remove` also answers false when there was nothing to remove: Chrome's own list decides.
    await browser.permissions.remove({ origins: [grant.pattern] });
    const { origins = [] } = (await browser.permissions.getAll?.()) ?? {};
    grants.refresh();
    if (origins.includes(grant.pattern)) {
      throw new Error(
        `Chrome still holds access for ${grant.origin}. It may be part of how this copy of StudyVault was installed; the extension details page lists it.`,
      );
    }
    announce(`Revoked access for ${grant.origin}.`);
    heading.current?.focus();
  });

  const list = otherGrants(
    grants.data ?? [],
    {
      persistentOrigins: settings.persistentOrigins,
      manifestHosts: browser.runtime.getManifest().host_permissions ?? [],
    },
    known.data ?? { ai: null, syncServer: null, syncIssuer: null },
  );
  return (
    <Card
      title="Other access"
      icon={KeyRound}
      tone="neutral"
      headingRef={heading}
      testId="other-access"
      info="Addresses Chrome allowed one at a time: the AI provider, the sync server and its sign-in, or a site you allowed from a prompt. Revoke one and its feature asks again next time."
    >
      {grants.loading ? (
        <p className="sv-muted">Checking Chrome…</p>
      ) : grants.error ? null : list.length === 0 ? (
        <p className="sv-muted">Nothing else is allowed.</p>
      ) : (
        <ul className="opt-rows" aria-label="Other access Chrome holds for StudyVault">
          {list.map((grant) => (
            <li key={grant.pattern} className="opt-rowitem">
              <span className="opt-rowitem__text" dir="ltr">
                {grant.origin}
              </span>
              <Badge>{grant.purpose}</Badge>
              <IconButton
                icon={X}
                tipSide="left"
                label={`Revoke access for ${grant.origin}`}
                aria-disabled={revoke.busy || undefined}
                onClick={() => {
                  if (!revoke.busy) void revoke.run(grant);
                }}
              />
            </li>
          ))}
        </ul>
      )}
      {revoke.error || grants.error ? (
        <InlineNotice
          tone="error"
          title="That did not work"
          action={
            (revoke.error ? revoke.retryable : grants.retryable) ? (
              <Button
                busy={revoke.error ? revoke.busy : grants.refreshing}
                onClick={revoke.error ? revoke.retry : grants.refresh}
              >
                Retry
              </Button>
            ) : undefined
          }
        >
          {revoke.error ?? grants.error}
        </InlineNotice>
      ) : null}
    </Card>
  );
}
