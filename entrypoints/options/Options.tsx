import {
  Suspense,
  lazy,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { browser } from 'wxt/browser';
import { ArrowLeft } from 'lucide-react';
import type { Settings } from '@shared';
import {
  Button,
  ErrorBoundary,
  InlineNotice,
  ToastProvider,
  VaultBuddy,
  useApplyTheme,
  useFocusRescue,
  useSettings,
} from '@ui';
import { AiSettingsSection } from '@ui/ai';
import { BackupReminder, BackupSection } from '@ui/backup';
import { SyncSection } from '@ui/sync';
import { YourData } from './Data';
import { Game } from './Game';
import { Home } from './Home';
import { SectionNav, useHashSection } from './Nav';
import { Appearance, Capture, type Update } from './Preferences';
import { About, Privacy } from './Privacy';
import { ReviewSection } from './ReviewSection';
import { KeyboardShortcuts } from './Shortcuts';
import { SiteAccess } from './SiteAccess';
import { Storage } from './Storage';
import { sectionById, type OptionSectionId } from './model';
import { ArtTile, LogoMark, SECTION_LOOK } from './ui';

// Only read when the reminders section is open (docs/adr/019-reminders.md).
const Reminders = lazy(() => import('./Reminders').then((m) => ({ default: m.Reminders })));

/** Where focus goes when a toast that held it closes: the settings, never <body>. */
const content = () => document.querySelector<HTMLElement>('.opt__main');

export function Options() {
  return (
    <ToastProvider returnFocus={content}>
      <OptionsBody />
    </ToastProvider>
  );
}

/**
 * False until one task after the first render of a section. The sections that read the database
 * or ask the worker (game, review, AI, sync, backup, storage) mount then, so the settings-only
 * ones (site access above all) are on screen without waiting for IndexedDB, and a slow or failing
 * data section can never hold up the shell.
 */
function useDataSections(ready: boolean): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!ready) return undefined;
    const timer = window.setTimeout(() => setLate(true), 0);
    return () => window.clearTimeout(timer);
  }, [ready]);
  return late;
}

/** A section that reads the database: mounts one task late, inside its own error boundary. */
function DataSection({
  ready,
  surface,
  children,
}: {
  ready: boolean;
  surface: string;
  children: ReactNode;
}) {
  return ready ? <ErrorBoundary surface={surface}>{children}</ErrorBoundary> : null;
}

function SectionBody({
  id,
  settings,
  update,
  dataReady,
}: {
  id: OptionSectionId;
  settings: Settings;
  update: Update;
  dataReady: boolean;
}) {
  const syncOn = settings.features.sync;
  switch (id) {
    case 'game':
      return (
        <DataSection ready={dataReady} surface="game settings">
          <Game />
        </DataSection>
      );
    case 'site-access':
      return <SiteAccess settings={settings} />;
    case 'capture':
      return <Capture settings={settings} update={update} />;
    case 'appearance':
      return <Appearance settings={settings} update={update} />;
    case 'shortcuts':
      return <KeyboardShortcuts />;
    case 'review':
      return (
        <DataSection ready={dataReady} surface="review settings">
          <ReviewSection settings={settings} update={update} />
        </DataSection>
      );
    case 'reminders':
      return (
        <ErrorBoundary surface="reminder settings">
          <Suspense fallback={<p className="sv-muted">Loading reminders…</p>}>
            <Reminders settings={settings} update={update} />
          </Suspense>
        </ErrorBoundary>
      );
    case 'backup':
      return (
        <DataSection ready={dataReady} surface="backup settings">
          <BackupSection appVersion={browser.runtime.getManifest().version} />
        </DataSection>
      );
    case 'storage':
      return (
        <DataSection ready={dataReady} surface="storage figures">
          <Storage syncOn={syncOn} />
        </DataSection>
      );
    case 'privacy':
      return <Privacy syncOn={syncOn} />;
    case 'data':
      return <YourData syncOn={syncOn} />;
    case 'ai':
      return (
        <DataSection ready={dataReady} surface="AI settings">
          <AiSettingsSection />
        </DataSection>
      );
    case 'sync':
      return (
        <DataSection ready={dataReady} surface="sync settings">
          <SyncSection />
        </DataSection>
      );
    case 'about':
      return <About />;
  }
}

/** Sections whose shared component shows its own icon title, status and switch (ai, sync, backup). */
const OWN_TITLE = new Set<OptionSectionId>(['ai', 'sync', 'backup']);

/** The section's title block: art tile, the page heading (h1) and one line. */
function SectionHero({
  id,
  titleRef,
}: {
  id: OptionSectionId;
  titleRef: RefObject<HTMLHeadingElement | null>;
}) {
  const { label, line } = sectionById(id);
  return (
    <div className="opt-hero">
      <a href="#" className="opt-back">
        <ArrowLeft aria-hidden="true" strokeWidth={2.6} />
        All settings
      </a>
      {/* These sections draw their own title card: the page heading stays, for focus and names. */}
      <div className={`opt-hero__row${OWN_TITLE.has(id) ? ' sv-vh' : ''}`}>
        <ArtTile {...SECTION_LOOK[id]} size="lg" />
        <div className="opt-hero__text">
          <h1 ref={titleRef} tabIndex={-1}>
            {label}
          </h1>
          <p className="opt-hero__line">{line}</p>
        </div>
      </div>
    </div>
  );
}

function OptionsBody() {
  const { settings, error, retry, update } = useSettings();
  useApplyTheme(settings?.theme);
  // A row or a notice that goes away with its own button must not leave focus on <body>.
  const rescueRef = useFocusRescue();
  const view = useHashSection();
  const dataReady = useDataSections(settings !== null);
  const title = useRef<HTMLHeadingElement>(null);

  // A new view starts at its top with focus on its title (WCAG 2.4.3); the first one keeps the
  // browser's own start, so opening the page never moves focus by itself.
  const shown = useRef(view);
  useEffect(() => {
    document.title = view
      ? `${sectionById(view).label} · StudyVault AI settings`
      : 'StudyVault AI settings';
    if (shown.current === view) return;
    shown.current = view;
    document.scrollingElement?.scrollTo?.(0, 0);
    title.current?.focus();
  }, [view]);

  // The backup reminder's button scrolls to the backup section on this page; it only exists in
  // its own view, so the click opens that view first (the reminder's own scroll then finds it).
  const toBackup = (e: MouseEvent) => {
    if ((e.target as Element).closest('[data-testid="backup-reminder-go"]') && view !== 'backup') {
      window.location.hash = 'backup';
    }
  };

  return (
    <div ref={rescueRef} className="opt">
      <header className="opt__bar">
        <LogoMark />
        <span className="opt__brand">
          StudyVault <span className="opt__brand-sub">Settings</span>
        </span>
      </header>

      <div className="opt__layout">
        {settings ? <SectionNav current={view} /> : null}
        <main className="opt__main" tabIndex={-1}>
          {error ? (
            <>
              <h1 className="opt__plain-title">Settings</h1>
              <InlineNotice
                tone="error"
                title="Could not read your settings"
                action={<Button onClick={retry}>Retry</Button>}
              >
                {error}
              </InlineNotice>
            </>
          ) : settings === null ? (
            <div className="opt-loading">
              <VaultBuddy pose="think" size={72} />
              <h1 className="opt__plain-title">Settings</h1>
              <p className="sv-muted">Loading settings…</p>
            </div>
          ) : (
            <>
              {dataReady ? (
                <div onClickCapture={toBackup}>
                  <BackupReminder />
                </div>
              ) : null}
              {view === null ? (
                <Home settings={settings} titleRef={title} />
              ) : (
                <>
                  <SectionHero id={view} titleRef={title} />
                  <div id={view} className="opt-section" key={view}>
                    <SectionBody
                      id={view}
                      settings={settings}
                      update={update}
                      dataReady={dataReady}
                    />
                  </div>
                </>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
