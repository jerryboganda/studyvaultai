import { useCallback, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  Button,
  InlineNotice,
  ToastProvider,
  errorMessage,
  useAction,
  useApplyTheme,
  useSettings,
} from '@ui';
import { settingsPath } from '@ui/shell/paths';
import {
  getOnboardingState,
  updateOnboardingState,
  type OnboardingState,
  type OnboardingStep,
} from '@ui/shell/onboardingState';
import { openDashboard } from '@ui/vault/dashboardLink';
import { STEP_COUNT, STEP_TITLES, nextStep, prevStep, startStep, stepIndex } from './model';
import { findPreset, pruneExcluded, type ApplyResult } from './presets';
import {
  AccessStep,
  BanksStep,
  DoneStep,
  KeysStep,
  LookStep,
  PrivacyStep,
  WelcomeStep,
} from './Steps';
import { TID } from './testids';

export function Onboarding() {
  return (
    <ToastProvider>
      <Tour />
    </ToastProvider>
  );
}

/**
 * The tour's persisted state. The in-memory copy is what the page shows; every change is written
 * through to storage right away (read-modify-write, so two tabs cannot clobber each other) and a
 * failed write is reported, never swallowed: the person would otherwise lose their place silently.
 */
function useTourState() {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    getOnboardingState().then(
      (s) => {
        if (live) setState(s);
      },
      (err: unknown) => {
        if (live) setError(errorMessage(err, 'Could not read where you left off.'));
      },
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  const commit = useCallback((patch: Partial<OnboardingState>) => {
    setState((cur) => (cur ? { ...cur, ...patch } : cur));
    updateOnboardingState((cur) => ({ ...cur, ...patch })).then(
      () => setSaveError(null),
      (err: unknown) => setSaveError(errorMessage(err, 'Your progress could not be saved.')),
    );
  }, []);

  const retry = useCallback(() => {
    setError(null);
    setAttempt((n) => n + 1);
  }, []);

  return { state, error, saveError, commit, retry };
}

function Tour() {
  const global = useSettings();
  useApplyTheme(global.settings?.theme);
  const tour = useTourState();
  const heading = useRef<HTMLHeadingElement>(null);
  const [moved, setMoved] = useState<OnboardingStep | null>(null);
  const [over, setOver] = useState<'skipped' | 'completed' | null>(null);

  // The stored step until a button moves on (a tour in progress resumes where it stopped).
  const step = moved ?? (tour.state ? startStep(tour.state) : null);

  // Each new step: the heading takes focus so the keyboard and screen readers start at its top.
  useEffect(() => {
    if (step !== null) heading.current?.focus();
  }, [step]);

  const go = (to: OnboardingStep) => {
    setMoved(to);
    tour.commit({ status: 'pending', step: to });
  };

  const skip = () => {
    tour.commit({ status: 'skipped' });
    setOver('skipped');
  };
  const finish = () => {
    tour.commit({ status: 'completed', step: 'done' });
    setOver('completed');
  };

  if (tour.error || global.error) {
    return (
      <div className="ob" data-testid={TID.root}>
        <InlineNotice
          tone="error"
          title="The welcome tour could not start"
          action={
            <Button
              onClick={() => {
                if (tour.error) tour.retry();
                if (global.error) global.retry();
              }}
            >
              Retry
            </Button>
          }
        >
          {tour.error ?? global.error}
        </InlineNotice>
      </div>
    );
  }
  if (!tour.state || !global.settings || step === null) {
    return (
      <div className="ob" data-testid={TID.root}>
        <p className="sv-muted">Loading…</p>
      </div>
    );
  }
  if (over) return <Over kind={over} />;

  const { settings, update } = global;
  const state = tour.state;
  const index = stepIndex(step);
  const preset = findPreset(state.preset.id);
  const flow = {
    onBack: index > 0 ? () => go(prevStep(step)) : undefined,
    onNext: () => go(nextStep(step)),
    heading,
  };

  return (
    <div className="ob" data-testid={TID.root}>
      <header className="ob__head">
        <div className="sv-grow">
          <h1>Welcome to StudyVault AI</h1>
          <p className="sv-muted sv-small" data-testid={TID.progress}>
            {STEP_TITLES[step]} · step {index + 1} of {STEP_COUNT}
          </p>
        </div>
        <Button variant="ghost" data-testid={TID.skip} onClick={skip}>
          Skip the tour
        </Button>
      </header>
      <div className="ob__bar" role="presentation">
        <span style={{ width: `${((index + 1) / STEP_COUNT) * 100}%` }} />
      </div>

      <main className="ob__main sv-stack">
        {tour.saveError ? (
          <InlineNotice tone="warning" title="Your place was not saved">
            {tour.saveError} The tour still works; if you close this tab you will start again.
          </InlineNotice>
        ) : null}
        {step === 'welcome' ? <WelcomeStep {...flow} /> : null}
        {step === 'privacy' ? <PrivacyStep {...flow} settings={settings} update={update} /> : null}
        {step === 'access' ? <AccessStep {...flow} /> : null}
        {step === 'banks' ? (
          <BanksStep
            {...flow}
            state={state}
            onPreset={(id) =>
              tour.commit({ preset: { id, excluded: [] }, status: 'pending', step })
            }
            onExcluded={(excluded) =>
              tour.commit({
                preset: {
                  id: state.preset.id,
                  excluded: preset ? pruneExcluded(preset, excluded) : [],
                },
                status: 'pending',
                step,
              })
            }
            onApplied={(r: ApplyResult) =>
              tour.commit({
                applied: {
                  presetId: state.preset.id,
                  bankName: r.bankName,
                  createdBank: r.createdBank,
                  createdFolders: r.createdFolders,
                  existingFolders: r.existingFolders,
                  at: new Date().toISOString(),
                },
                status: 'pending',
                step,
              })
            }
          />
        ) : null}
        {step === 'look' ? <LookStep {...flow} settings={settings} update={update} /> : null}
        {step === 'keys' ? <KeysStep {...flow} /> : null}
        {step === 'done' ? (
          <DoneStep
            heading={heading}
            state={state}
            onBack={() => go(prevStep(step))}
            onFinish={finish}
          />
        ) : null}
      </main>
    </div>
  );
}

/** The tour is over: finished or skipped. Says what happened and where everything is. */
function Over({ kind }: { kind: 'skipped' | 'completed' }) {
  const close = useAction(async () => {
    const tab = await browser.tabs.getCurrent();
    if (tab?.id === undefined) throw new Error('Chrome did not say which tab this is.');
    await browser.tabs.remove(tab.id);
  });
  const done = kind === 'completed';
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => title.current?.focus(), []);
  return (
    <div className="ob" data-testid={TID.root}>
      <main className="ob__main sv-stack" data-testid={done ? TID.finished : TID.skipped}>
        <h1 ref={title} tabIndex={-1} className="ob__heading">
          {done ? 'You are all set' : 'Tour skipped'}
        </h1>
        <p>
          {done
            ? 'StudyVault is ready. Select text on any page you have enabled to save your first highlight.'
            : 'Nothing else was changed. Any choice you already made in the tour is saved.'}
        </p>
        <p className="sv-muted">
          You can open this tour again any time from Settings, under Your data.
        </p>
        <div className="sv-row">
          <Button variant="primary" onClick={() => void openDashboard()}>
            Open the dashboard
          </Button>
          <a
            className="sv-btn sv-btn--secondary"
            href={settingsPath()}
            target="_blank"
            rel="noreferrer"
          >
            Open settings
          </a>
          <Button busy={close.busy} onClick={() => void close.run()}>
            Close this tab
          </Button>
        </div>
        {close.error ? (
          <InlineNotice tone="error" title="Could not close this tab">
            {close.error} You can close it yourself.
          </InlineNotice>
        ) : null}
      </main>
    </div>
  );
}
