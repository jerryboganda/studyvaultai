import { useId, type Ref } from 'react';
import { browser } from 'wxt/browser';
import { House, Layers } from 'lucide-react';
import type { Settings } from '@shared';
import { InlineNotice, VaultBuddy, plural, useAction } from '@ui';
import { useGame } from '@ui/game';
import { reviewPageUrl } from '@ui/review/links';
import { openDashboard } from '@ui/vault/dashboardLink';
import { sectionGroups, splitOrigins, type OptionSectionId } from './model';
import { Act, ArtTile, SECTION_LOOK } from './ui';

const THEME_NAMES = { system: 'System theme', light: 'Light theme', dark: 'Dark theme' } as const;

/** A short, true status for a section tile, from the stored settings (null: none to show). */
function tileStatus(
  id: OptionSectionId,
  s: Settings,
  game: { mode: boolean; goal: number | null } | null,
): string | null {
  switch (id) {
    case 'game':
      if (!game) return null;
      return game.mode ? (game.goal ? `${game.goal} XP a day` : 'On') : 'Off';
    case 'site-access': {
      const { allSites, sites } = splitOrigins(s.persistentOrigins);
      return allSites ? 'All sites' : sites.length > 0 ? plural(sites.length, 'site') : 'This tab';
    }
    case 'capture':
      return s.toolbarEnabled ? 'Toolbar on' : 'Toolbar off';
    case 'appearance':
      return THEME_NAMES[s.theme];
    case 'review':
      return s.features.review ? 'On' : 'Off';
    case 'reminders':
      return s.reminders.on ? (s.reminders.dailyAt ?? 'Badge on') : 'Off';
    case 'ai':
      return s.features.ai ? 'On' : 'Off';
    case 'sync':
      return s.features.sync ? 'On' : 'Off';
    case 'about':
      return `Version ${browser.runtime.getManifest().version}`;
    default:
      return null;
  }
}

function QuickActions({ reviewOn }: { reviewOn: boolean }) {
  const dashboard = useAction(() => openDashboard());
  const review = useAction(async () => {
    await browser.tabs.create({ url: reviewPageUrl({ view: 'study' }) });
  });
  const failure = dashboard.error ?? review.error;
  return (
    <div className="opt-welcome__actions">
      <div className="sv-row" role="group" aria-label="Open StudyVault">
        <Act
          variant="primary"
          icon={House}
          busy={dashboard.busy}
          onClick={() => void dashboard.run()}
        >
          Open dashboard
        </Act>
        <Act
          icon={Layers}
          busy={review.busy}
          {...(reviewOn ? {} : { disabledReason: 'Review is off. Turn it on in Review.' })}
          onClick={() => void review.run()}
        >
          Open review
        </Act>
      </div>
      {failure ? (
        <InlineNotice tone="error" title="Could not open that page">
          {failure}
        </InlineNotice>
      ) : null}
    </div>
  );
}

/** The settings home: a greeting with the two pages people come for, then one tile per section. */
export function Home({
  settings,
  titleRef,
}: {
  settings: Settings;
  titleRef: Ref<HTMLHeadingElement>;
}) {
  const uid = useId();
  const { data } = useGame();
  const game = data ? { mode: data.mode, goal: data.ready ? data.goal.value : null } : null;
  return (
    <div className="opt-home">
      <section className="opt-welcome" aria-labelledby={`${uid}-h`}>
        <VaultBuddy pose="wave" size={96} className="opt-welcome__buddy" />
        <div className="opt-welcome__text">
          <h1 id={`${uid}-h`} ref={titleRef} tabIndex={-1}>
            Settings
          </h1>
          <p className="opt-welcome__line">Make StudyVault work your way.</p>
        </div>
        <QuickActions reviewOn={settings.features.review} />
      </section>

      {sectionGroups().map(({ group, sections }, g) => (
        <section key={group} className="opt-group" aria-labelledby={`${uid}-g${g}`}>
          <h2 id={`${uid}-g${g}`} className="opt-group__title">
            {group}
          </h2>
          <ul className="opt-tiles">
            {sections.map((s) => {
              const status = tileStatus(s.id, settings, game);
              return (
                <li key={s.id}>
                  <a
                    href={`#${s.id}`}
                    className="opt-tile"
                    // One name in every engine: the visible label, then its status.
                    aria-label={status ? `${s.label}, ${status}` : undefined}
                  >
                    <ArtTile {...SECTION_LOOK[s.id]} size="lg" />
                    <span className="opt-tile__label">{s.label}</span>
                    {status ? <span className="opt-tile__status">{status}</span> : null}
                  </a>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
