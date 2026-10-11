import { useCallback, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  Button,
  InlineNotice,
  Tabs,
  ToastProvider,
  useAction,
  useApplyTheme,
  useSettings,
} from '@ui';
import {
  ReviewSettingsSection,
  TID,
  parseReviewSearch,
  reviewSearch,
  useDueCount,
  useStudySettings,
  type ReviewView,
} from '@ui/review';
import { Analytics } from './Analytics';
import { Author } from './Author';
import { CardBrowser } from './CardBrowser';
import { StudyView } from './StudyView';

/** Where focus goes when a toast that held it closes: the panel content, never <body>. */
const content = () => document.querySelector<HTMLElement>('[role="tabpanel"], main');

export function Review() {
  return (
    <ToastProvider returnFocus={content}>
      <Page />
    </ToastProvider>
  );
}

function Page() {
  const global = useSettings();
  useApplyTheme(global.settings?.theme);
  const study = useStudySettings();
  const [link] = useState(() => parseReviewSearch(window.location.search));
  const [view, setView] = useState<ReviewView>(
    link.view ?? (link.highlightId ? 'create' : 'study'),
  );
  const [focusMode, setFocusMode] = useState(false);
  const due = useDueCount();

  const select = useCallback((next: ReviewView) => {
    setView(next);
    const q = reviewSearch({ view: next });
    window.history.replaceState(null, '', `${window.location.pathname}?${q}`);
  }, []);

  const openSettings = useAction(async () => {
    await browser.runtime.openOptionsPage();
  });

  if (study.error) {
    return (
      <div className="rv-page" data-testid={TID.page}>
        <InlineNotice
          tone="error"
          title="Review could not start"
          action={<Button onClick={study.retry}>Retry</Button>}
        >
          <span data-testid={TID.loadError}>{study.error}</span>
        </InlineNotice>
      </div>
    );
  }
  const settings = study.settings;
  if (!settings) {
    return (
      <div className="rv-page" data-testid={TID.page}>
        <p className="sv-muted">Loading…</p>
      </div>
    );
  }

  // One tree for every state: a running session hides the navigation with CSS instead of
  // swapping the tree, because swapping would remount the study view and drop the session on screen.
  const focused = focusMode && view === 'study';

  return (
    <div className={`rv-page${focused ? ' rv-page--focus' : ''}`} data-testid={TID.page}>
      <header className="rv-head">
        <h1>Review</h1>
        <p className="sv-muted" aria-live="polite">
          {due.count === null
            ? ''
            : due.count === 0
              ? 'Nothing due right now'
              : `${due.count} due now`}
        </p>
        <Button variant="ghost" busy={openSettings.busy} onClick={() => void openSettings.run()}>
          StudyVault settings
        </Button>
      </header>
      {openSettings.error ? (
        <InlineNotice tone="error">Could not open settings: {openSettings.error}</InlineNotice>
      ) : null}
      <Tabs
        label="Review sections"
        tabs={[
          { id: 'study', label: 'Study' },
          { id: 'create', label: 'Create cards' },
          { id: 'cards', label: 'Cards' },
          { id: 'analytics', label: 'Analytics' },
          { id: 'settings', label: 'Settings' },
        ]}
        value={view}
        onChange={(id) => select(id as ReviewView)}
      >
        <div className="rv-panel">
          {view === 'study' ? (
            <StudyView
              settings={settings}
              start={link.start === true}
              deckId={link.deckId ?? null}
              onFocusMode={setFocusMode}
              onNavigate={select}
            />
          ) : null}
          {view === 'create' ? <Author initialHighlightId={link.highlightId ?? null} /> : null}
          {view === 'cards' ? <CardBrowser settings={settings} /> : null}
          {view === 'analytics' ? <Analytics settings={settings} /> : null}
          {view === 'settings' ? <ReviewSettingsSection /> : null}
        </div>
      </Tabs>
    </div>
  );
}
