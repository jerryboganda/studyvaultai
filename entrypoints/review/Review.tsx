import { Suspense, lazy, useCallback, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  ChartColumn,
  Flame,
  GalleryVerticalEnd,
  Layers,
  Settings,
  Settings2,
  SquarePlus,
  Timer,
} from 'lucide-react';
import {
  BarMeter,
  Button,
  IconButton,
  IconTabBar,
  InlineNotice,
  ProgressRing,
  StatChip,
  ToastProvider,
  VaultBuddy,
  useAction,
  useApplyTheme,
  useFocusRescue,
  useSettings,
  type IconTab,
} from '@ui';
import { useGame, type GameView } from '@ui/game';
import {
  ReviewSettingsSection,
  TID,
  parseReviewSearch,
  reviewSearch,
  useDueCount,
  useStudySettings,
  type ExamTarget,
  type ReviewView,
} from '@ui/review';
import { Analytics } from './Analytics';
import { Author } from './Author';
import { CardBrowser } from './CardBrowser';
import { Loading, StudyView } from './StudyView';

// The exam view and its storage helpers are only needed on the Exam tab: a chunk of their own.
const ExamView = lazy(() => import('./Exam').then((m) => ({ default: m.ExamView })));

/** Where focus goes when a toast that held it closes: the panel content, never <body>. */
const content = () => document.querySelector<HTMLElement>('[role="tabpanel"], main');

const TABS: IconTab<ReviewView>[] = [
  { id: 'study', label: 'Study', icon: Layers },
  { id: 'exam', label: 'Exam', icon: Timer },
  { id: 'create', label: 'Create', icon: SquarePlus },
  { id: 'cards', label: 'Cards', icon: GalleryVerticalEnd },
  { id: 'analytics', label: 'Stats', icon: ChartColumn },
  { id: 'settings', label: 'Settings', icon: Settings2 },
];

export function Review() {
  return (
    <ToastProvider returnFocus={content}>
      <Page />
    </ToastProvider>
  );
}

/**
 * Today's goal ring and streak (Game mode on). While the ledger is still being built it shows the
 * real backfill progress and no number; with Game mode off it shows nothing (ADR-022).
 */
function GameHeader({ game }: { game: GameView }) {
  const g = game.data;
  if (!g || !g.mode) return null;
  if (!g.ready) {
    if (g.backfill.status === 'failed') {
      return (
        <Button variant="ghost" onClick={() => void game.retryBackfill()}>
          Retry XP count
        </Button>
      );
    }
    return (
      <div className="rv-head__counting">
        <span className="sv-small">Counting XP</span>
        <BarMeter
          value={g.backfill.done}
          max={Math.max(1, g.backfill.total)}
          label="Counting your XP"
          valueText={`${g.backfill.done} of ${g.backfill.total}`}
          size="sm"
        />
      </div>
    );
  }
  return (
    <div className="rv-head__game">
      <ProgressRing
        value={g.today.xp}
        max={g.goal.value}
        label="Daily goal"
        unit="XP"
        size={48}
        stroke={6}
      >
        <span className="rv-head__xp">{g.today.xp}</span>
      </ProgressRing>
      <StatChip icon={Flame} tone="flame" value={g.streak.current} label="day streak" hideLabel />
    </div>
  );
}

function Page() {
  const global = useSettings();
  useApplyTheme(global.settings?.theme);
  const study = useStudySettings();
  const game = useGame();
  const [link] = useState(() => parseReviewSearch(window.location.search));
  const [view, setView] = useState<ReviewView>(
    link.view ?? (link.highlightId ? 'create' : 'study'),
  );
  // An exam setup that opens with a syllabus (and topic) chosen: from the address, or from the
  // "Exam on this topic" button of the coverage table.
  const [examTarget, setExamTarget] = useState<ExamTarget | null>(() =>
    link.view === 'exam' && link.syllabusId
      ? { syllabusId: link.syllabusId, topicId: link.topicId ?? null }
      : null,
  );
  const [focusMode, setFocusMode] = useState(false);
  const due = useDueCount();
  // Edit, Delete and Cancel buttons leave the page with their own action: focus stays on the panel.
  const rescueRef = useFocusRescue();

  const select = useCallback((next: ReviewView) => {
    setView(next);
    setExamTarget(null);
    const q = reviewSearch({ view: next });
    window.history.replaceState(null, '', `${window.location.pathname}?${q}`);
  }, []);
  const openExamOn = useCallback((target: ExamTarget) => {
    setExamTarget(target);
    setView('exam');
    const q = reviewSearch({
      view: 'exam',
      syllabusId: target.syllabusId,
      ...(target.topicId === null ? {} : { topicId: target.topicId }),
    });
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
        <Loading />
      </div>
    );
  }

  // One tree for every state: a running session hides the navigation with CSS instead of
  // swapping the tree, because swapping would remount the study view and drop the session on screen.
  const focused = focusMode && (view === 'study' || view === 'exam');

  return (
    <div
      ref={rescueRef}
      className={`rv-page${focused ? ' rv-page--focus' : ''}`}
      data-testid={TID.page}
    >
      <header className="rv-head">
        <VaultBuddy pose="wave" size={56} className="rv-head__buddy" />
        <div className="rv-head__text">
          <h1>Review</h1>
          <p className="rv-head__sub" aria-live="polite">
            {due.count === null
              ? ''
              : due.count === 0
                ? 'Nothing due right now'
                : `${due.count} due now`}
          </p>
        </div>
        <GameHeader game={game} />
        <IconButton
          icon={Settings}
          label="StudyVault settings"
          tipSide="left"
          aria-busy={openSettings.busy || undefined}
          onClick={() => void openSettings.run()}
        />
      </header>
      {openSettings.error ? (
        <InlineNotice tone="error">Could not open settings: {openSettings.error}</InlineNotice>
      ) : null}
      <IconTabBar
        label="Review sections"
        tabs={TABS}
        active={view}
        onChange={select}
        className="rv-tabs"
      >
        <div className="rv-panel">
          {view === 'study' ? (
            <StudyView
              settings={settings}
              game={game}
              start={link.start === true}
              deckId={link.deckId ?? null}
              onFocusMode={setFocusMode}
              onNavigate={select}
            />
          ) : null}
          {view === 'exam' ? (
            <Suspense fallback={<Loading />}>
              <ExamView
                settings={settings}
                onFocusMode={setFocusMode}
                target={examTarget}
                onCreateCards={() => select('create')}
              />
            </Suspense>
          ) : null}
          {view === 'create' ? <Author initialHighlightId={link.highlightId ?? null} /> : null}
          {view === 'cards' ? <CardBrowser settings={settings} /> : null}
          {view === 'analytics' ? (
            <Analytics settings={settings} onExamOnTopic={openExamOn} />
          ) : null}
          {view === 'settings' ? <ReviewSettingsSection /> : null}
        </div>
      </IconTabBar>
    </div>
  );
}
