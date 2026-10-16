import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { browser } from 'wxt/browser';
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Bookmark,
  CircleAlert,
  Gamepad2,
  Globe,
  Layers,
  Library,
  RefreshCw,
  Settings as Gear,
  Sparkles,
  Trash2,
  Workflow,
  X,
} from 'lucide-react';
import { callBackground } from '@runtime';
import { getStorageUsage, getWipeState, wipeAllData, type WipeState } from '@storage';
import {
  Button,
  ChunkyButton,
  IconButton,
  InfoTip,
  InlineNotice,
  Stepper,
  VaultBuddy,
  clearLocalPrefs,
  trapTab,
  useAction,
  useModalDialog,
  useToast,
} from '@ui';
import { DELETE_WORD, isDeleteWord } from './model';
import { Card } from './ui';

/**
 * "Delete all StudyVault data". `wipeAllData` removes the database and every other store, the
 * settings, session state and the site access Chrome granted; the worker is then asked to re-sync,
 * which can only unregister the always-on content script once nothing asks for it any more. Two
 * things are not reachable from the storage layer and are removed here, once the wipe is over: the
 * `localStorage` display preferences of the extension origin (`clearLocalPrefs`) and the optional
 * `identity` and `alarms` permissions. Both are best effort, and a failure is named in the report.
 *
 * The delete of the database cannot be taken back once requested, and another StudyVault window
 * (a dashboard, a side panel, a second settings tab) can hold it up. So the page shows the three
 * states `wipeAllData` reports, says what is waiting and what to do about it, and "Stop waiting"
 * only stops waiting: the deletion itself finishes by itself when that window closes.
 *
 * It is a guarded three-step flow (UX_DESIGN 10): what goes, type the word, done.
 */

/** A failure that is "not finished yet", not "went wrong" (`WipePendingError`, @storage). */
const isPending = (err: unknown): boolean =>
  err instanceof Error && err.name === 'WipePendingError';

const STOP_NOTE =
  "Stopping does not cancel the deletion: it still finishes when that window closes, and StudyVault here can't read or save until then.";

/** The optional API permissions sync asks for (`optional_permissions` in the manifest). */
const OPTIONAL_API_PERMISSIONS = ['identity', 'alarms'] as const;

/** What goes, at a glance (the full list is one click below it). */
const GOES = [
  { icon: Bookmark, label: 'Highlights' },
  { icon: Library, label: 'Banks and tags' },
  { icon: Layers, label: 'Cards and reviews' },
  { icon: Workflow, label: 'Rules and syllabi' },
  { icon: BookOpen, label: 'PDFs' },
  { icon: Sparkles, label: 'AI settings' },
  { icon: RefreshCw, label: 'Sync settings' },
  { icon: Gamepad2, label: 'Game progress' },
  { icon: Gear, label: 'Settings' },
  { icon: Globe, label: 'Site access' },
] as const;

/** What could not be removed, as sentences for the report; empty when everything went. */
async function removeLeftovers(): Promise<string[]> {
  const problems: string[] = [];
  try {
    clearLocalPrefs();
  } catch {
    problems.push(
      "The display preferences StudyVault keeps in this browser (such as high contrast) could not be cleared; Chrome lists them under the extension's site data.",
    );
  }
  try {
    const { permissions = [] } = (await browser.permissions.getAll?.()) ?? {};
    const held = OPTIONAL_API_PERMISSIONS.filter((p) => permissions.includes(p));
    if (held.length > 0) {
      // Sync's timers go with the permission: an alarm left behind could not be cleared afterwards.
      await Promise.resolve(browser.alarms?.clearAll?.()).catch(() => undefined);
      if (!(await browser.permissions.remove({ permissions: held }))) throw new Error('refused');
    }
  } catch {
    problems.push(
      'Chrome did not let StudyVault give up its optional sign-in and timer permissions (identity, alarms); you can remove them on the extension details page.',
    );
  }
  return problems;
}

/** Everything the deletion removes, and what it does not. Kept in full for the people who look. */
function FullList({ syncOn }: { syncOn: boolean }) {
  return (
    <details className="opt-more">
      <summary className="opt-more__summary">Full list</summary>
      <div className="opt-more__body">
        <p>This permanently removes everything StudyVault keeps on this device:</p>
        <ul className="opt-bullets">
          <li>
            every saved highlight with its note, including the ones in the trash, and your banks,
            folders and tags;
          </li>
          <li>
            your auto-filing rules, your syllabi with their coverage thresholds, and the links you
            drew between items;
          </li>
          <li>
            the pages and PDFs they came from, any text recognised from scans, and kept PDF copies;
          </li>
          <li>
            flashcards and review history, a review session or exam in progress, and your exam
            history;
          </li>
          <li>your XP, streak and badges, your daily goal and the Game mode setting;</li>
          <li>
            AI drafts, your provider settings and your API key, with any fallback providers you
            added and their keys;
          </li>
          <li>
            sync settings, the sign-in and the records of what was sent, and the automatic copy
            StudyVault made before its last update;
          </li>
          <li>
            your settings (theme, colours, deny list, study reminder) and the access Chrome gave
            StudyVault to websites, so it stops starting on them;
          </li>
          <li>
            the reference to the backup folder you chose and its last-backup status (the backup
            files already in that folder stay), and any auto-filing suggestions still waiting;
          </li>
          <li>
            the optional sign-in and timer permissions (identity, alarms) and the display
            preferences StudyVault pages keep in this browser, such as high contrast.
          </li>
        </ul>
        <p>
          <strong>This cannot be undone.</strong> It does not remove files you exported or backed
          up, anything on your other devices, or{' '}
          {syncOn
            ? 'the copy on your sync server. That one is separate, and StudyVault will no longer be signed in to remove it afterwards: use "Delete my data from the server" in the Sync section first if you want it gone.'
            : 'a copy on a sync server, if you ever used sync: that is separate.'}
        </p>
        <p>
          Afterwards Chrome&apos;s own page for this extension&apos;s stored data shows no
          highlights, notes, settings or preferences: the database it still lists is empty apart
          from one marker that holds no study data.
        </p>
        <p className="sv-muted sv-small">
          If another StudyVault window is open it can hold the deletion up. This page then tells
          you, and the deletion finishes by itself when that window is closed.
        </p>
      </div>
    </details>
  );
}

type Step = 'what' | 'confirm' | 'done';
const STEPS: Step[] = ['what', 'confirm', 'done'];
const STEP_TITLES = ['What goes', 'Type to confirm', 'Done'];

export function DeleteData({ syncOn }: { syncOn: boolean }) {
  const { announce } = useToast();
  const heading = useRef<HTMLHeadingElement>(null);
  const flowTitle = useRef<HTMLHeadingElement>(null);
  const [step, setStep] = useState<Step | null>(null);
  const flowOpen = useRef(false);
  useEffect(() => {
    // The dialog gives focus back to its opener; while a wipe ran, the opener button was drawn
    // again (busy, then not), so the card's title takes focus instead of <body>.
    const active = document.activeElement;
    if (step === null && flowOpen.current && (active === null || active === document.body)) {
      heading.current?.focus();
    }
    flowOpen.current = step !== null;
  }, [step]);
  /** What could not be removed or reached, one short note each; null until a wipe finished. */
  const [done, setDone] = useState<string[] | null>(null);
  /** What the running wipe is doing; a wipe already running when this page mounted shows too. */
  const [state, setState] = useState<WipeState | null>(() => getWipeState());
  /** The person stopped waiting: the wipe is still queued. A warning, not a failure. */
  const [stopped, setStopped] = useState(false);
  const controller = useRef<AbortController | null>(null);
  /** Whether sync was on when the wipe started (the settings are gone when it ends). */
  const hadSync = useRef(syncOn);

  /** The result is read where the person is: the flow's title, or the card's once it is closed. */
  const focusResult = () => (flowOpen.current ? flowTitle : heading).current?.focus();

  const finished = async () => {
    setState(null);
    setStopped(false);
    const left = await removeLeftovers();
    // Required host permissions (developer builds) cannot be removed: do not claim otherwise.
    const { origins = [] } = (await browser.permissions.getAll?.()) ?? {};
    setDone([
      ...(origins.length > 0
        ? [
            'Chrome still lists some site access for StudyVault that it does not let the extension remove; review it on the extension details page.',
          ]
        : []),
      ...left,
      ...(hadSync.current
        ? [
            'The copy on your sync server was not touched: it is separate, and StudyVault is no longer signed in to remove it.',
          ]
        : []),
    ]);
    announce('All StudyVault data was deleted.');
    focusResult();
  };

  /** Wait for the (new or already running) wipe; the outcome is reported either way. */
  const wait = async () => {
    const mine = new AbortController();
    controller.current = mine;
    setStopped(false);
    try {
      await wipeAllData({ onState: setState, signal: mine.signal });
    } catch (err) {
      if (isPending(err)) {
        setStopped(true);
        setState(null);
        return;
      }
      setState(null);
      throw err;
    } finally {
      if (controller.current === mine) controller.current = null;
    }
    await callBackground('site.sync', {});
    await finished();
  };

  const wipe = useAction(async () => {
    setDone(null);
    hadSync.current = syncOn;
    await wait();
  });

  /**
   * Look again without starting anything new: a delete is only joined while it is still running.
   * Once it is not, the data itself says whether it finished (starting another wipe here could
   * delete what was saved since).
   */
  const check = useAction(async () => {
    if (getWipeState() !== null) {
      await wait();
      return;
    }
    const usage = await getStorageUsage();
    // One bookkeeping row (the search-index marker) is written into the new, empty database.
    const left = Object.entries(usage.rows).reduce(
      (n, [table, rows]) => n + (table === 'meta' ? 0 : rows),
      0,
    );
    if (left === 0) {
      await callBackground('site.sync', {});
      await finished();
    } else {
      setStopped(false);
      throw new Error(
        `The deletion is no longer running, but ${left} items are still stored. Press Delete again to finish it.`,
      );
    }
  });

  const stopWaiting = () => controller.current?.abort();
  const busy = wipe.busy || check.busy;
  const waiting = state !== null || stopped;

  // These notices appear long after the click that started the wipe, and they are the only way to
  // learn that something outside this page is holding it up (WCAG 4.1.3).
  useEffect(() => {
    if (state === 'blocked') announce('Deleting is held up: another StudyVault window is open.');
  }, [state, announce]);
  useEffect(() => {
    if (stopped) announce('Deleting is still queued. It finishes when the other window closes.');
  }, [stopped, announce]);

  const status = (
    <div className="opt-stack opt-stack--tight">
      {state === 'deleting' ? <p className="opt-working">Deleting…</p> : null}
      {state === 'cleaning' ? (
        <p className="opt-working">
          The database is gone. Removing the pre-update copy, your settings and the site access
          Chrome granted…
        </p>
      ) : null}
      {state === 'blocked' ? (
        <InlineNotice
          tone="warning"
          title="Waiting for another StudyVault window"
          action={
            <div className="sv-row">
              <Button onClick={stopWaiting}>Stop waiting</Button>
              <Button busy={check.busy} onClick={() => void check.run()}>
                Check again
              </Button>
            </div>
          }
        >
          <p className="opt-line">
            Close other StudyVault tabs and side panels. It then finishes by itself.
            <InfoTip label="About stop waiting" align="end">
              {STOP_NOTE}
            </InfoTip>
          </p>
        </InlineNotice>
      ) : null}
      {stopped ? (
        <InlineNotice
          tone="warning"
          title="Deleting is not finished"
          action={
            <Button busy={check.busy} onClick={() => void check.run()}>
              Check again
            </Button>
          }
        >
          <p>{STOP_NOTE}</p>
        </InlineNotice>
      ) : null}
      {done ? (
        <InlineNotice tone="success">
          {/* One element holds the result and its notes, so the whole report is read together. */}
          <div className="opt-donemsg">
            All StudyVault data was deleted from this device and settings are back to their
            defaults.
            {done.length > 0 ? (
              <ul className="opt-bullets">
                {done.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </InlineNotice>
      ) : null}
      {wipe.error ? (
        <InlineNotice
          tone="error"
          title="Deleting your data did not finish"
          action={
            wipe.retryable ? (
              <Button busy={busy} onClick={wipe.retry}>
                Retry
              </Button>
            ) : undefined
          }
        >
          {wipe.error}
        </InlineNotice>
      ) : null}
      {check.error ? (
        <InlineNotice tone="error" title="Could not confirm that deleting finished">
          {check.error}
        </InlineNotice>
      ) : null}
    </div>
  );

  return (
    <Card
      title="Start over"
      icon={Trash2}
      tone="danger"
      headingRef={heading}
      className="opt-card--danger"
    >
      <p className="opt-line">Removes everything StudyVault keeps here.</p>
      <div>
        <ChunkyButton
          variant="danger"
          icon={Trash2}
          aria-busy={wipe.busy || undefined}
          {...(waiting ? { disabledReason: 'Deleting is already under way.' } : {})}
          onClick={() => {
            if (wipe.busy) return;
            wipe.clear();
            check.clear();
            setDone(null);
            setStep('what');
          }}
        >
          Delete all data
        </ChunkyButton>
      </div>
      {step === null ? status : null}
      {step !== null ? (
        <DeleteFlow
          step={step}
          syncOn={syncOn}
          titleRef={flowTitle}
          working={state !== null || wipe.busy || check.busy}
          failed={Boolean(wipe.error || check.error || stopped)}
          finished={done !== null}
          status={status}
          onStep={setStep}
          onConfirm={() => {
            setStep('done');
            void wipe.run();
          }}
          onBackup={() => {
            setStep(null);
            window.location.hash = 'backup';
          }}
          onClose={() => setStep(null)}
        />
      ) : null}
    </Card>
  );
}

/**
 * The flow in a modal dialog, built on the wizard's look (the shared Wizard has no danger finish):
 * focus on the step title at every step, Tab kept inside, Escape closes, focus back to the opener.
 * Closing while the deletion runs only closes the dialog; the card goes on showing the status.
 */
function DeleteFlow({
  step,
  syncOn,
  titleRef,
  working,
  failed,
  finished,
  status,
  onStep,
  onConfirm,
  onBackup,
  onClose,
}: {
  step: Step;
  syncOn: boolean;
  titleRef: RefObject<HTMLHeadingElement | null>;
  working: boolean;
  failed: boolean;
  finished: boolean;
  status: ReactNode;
  onStep(step: Step): void;
  onConfirm(): void;
  onBackup(): void;
  onClose(): void;
}) {
  const uid = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [word, setWord] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  useModalDialog(dialog);
  const index = STEPS.indexOf(step);

  useEffect(() => {
    titleRef.current?.focus();
  }, [step, titleRef]);

  const confirm = () => {
    if (!isDeleteWord(word)) {
      setProblem(`Type ${DELETE_WORD} to go on.`);
      input.current?.focus();
      return;
    }
    onConfirm();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDialogElement>) => {
    trapTab(e, e.currentTarget);
    if (e.key !== 'Escape') return;
    e.preventDefault();
    onClose();
  };

  const title =
    step === 'what'
      ? 'What goes'
      : step === 'confirm'
        ? 'Type to confirm'
        : finished
          ? 'Fresh start'
          : failed
            ? 'Not finished'
            : 'Deleting';

  return (
    <dialog
      ref={dialog}
      className="sv-wiz sv-wiz--dialog opt-delete"
      aria-label="Delete all StudyVault data"
      onKeyDown={onKeyDown}
      onCancel={(e) => e.preventDefault()}
    >
      <div className="sv-wiz__head">
        <span className="sv-wiz__eyebrow">Delete all data</span>
        <IconButton icon={X} label="Close" tipSide="left" onClick={onClose} />
      </div>
      <Stepper steps={STEP_TITLES} current={index} label="Delete all data" />
      <h2 className="sv-wiz__title" ref={titleRef} tabIndex={-1}>
        {title}
      </h2>
      <div className="sv-wiz__body">
        {step === 'what' ? (
          <>
            <ul className="opt-goes" aria-label="What is deleted">
              {GOES.map(({ icon: Icon, label }) => (
                <li key={label} className="opt-goes__item">
                  <Icon aria-hidden="true" strokeWidth={2.4} />
                  {label}
                </li>
              ))}
            </ul>
            <p className="opt-line">
              Kept: your backup files and other devices
              {syncOn ? '. The copy on your sync server stays too.' : '.'}
            </p>
            <FullList syncOn={syncOn} />
          </>
        ) : step === 'confirm' ? (
          <>
            <p className="opt-warnline">
              <CircleAlert aria-hidden="true" strokeWidth={2.4} />
              This cannot be undone.
            </p>
            {syncOn ? (
              <p className="opt-line">
                Sync is on: to remove the server copy too, use &ldquo;Delete my data from the
                server&rdquo; in Sync first.
              </p>
            ) : null}
            <div className="sv-textfield">
              <label htmlFor={`${uid}-word`}>Type &ldquo;{DELETE_WORD}&rdquo;</label>
              <input
                ref={input}
                id={`${uid}-word`}
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={word}
                aria-invalid={problem ? true : undefined}
                aria-describedby={problem ? `${uid}-err` : undefined}
                onChange={(e) => {
                  setWord(e.target.value);
                  setProblem(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    confirm();
                  }
                }}
              />
            </div>
            {problem ? (
              <p id={`${uid}-err`} className="sv-wiz__error" role="alert">
                <CircleAlert aria-hidden="true" strokeWidth={2.6} />
                {problem}
              </p>
            ) : null}
          </>
        ) : (
          <>
            {finished ? (
              <div className="opt-fresh">
                <VaultBuddy pose="wave" size={96} />
              </div>
            ) : working ? (
              <div className="opt-fresh">
                <VaultBuddy pose="think" size={72} />
              </div>
            ) : null}
            {status}
          </>
        )}
      </div>
      <div className="sv-wiz__nav">
        {step === 'what' ? (
          <>
            <ChunkyButton variant="ghost" icon={Archive} onClick={onBackup}>
              Back up first
            </ChunkyButton>
            <span className="sv-wiz__spacer" />
            <ChunkyButton variant="primary" iconEnd={ArrowRight} onClick={() => onStep('confirm')}>
              Next
            </ChunkyButton>
          </>
        ) : step === 'confirm' ? (
          <>
            <ChunkyButton icon={ArrowLeft} onClick={() => onStep('what')}>
              Back
            </ChunkyButton>
            <span className="sv-wiz__spacer" />
            <ChunkyButton variant="danger" icon={Trash2} onClick={confirm}>
              Delete everything
            </ChunkyButton>
          </>
        ) : (
          <>
            <span className="sv-wiz__spacer" />
            {/* Until it is over the close button above is the way out; it never cancels anything. */}
            {finished ? (
              <ChunkyButton variant="primary" onClick={onClose}>
                Done
              </ChunkyButton>
            ) : null}
          </>
        )}
      </div>
    </dialog>
  );
}
