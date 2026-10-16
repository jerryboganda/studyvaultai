import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { BackgroundRpc } from '@shared';
import { getTrustedSettings, serveRpc, updateSettings } from '@runtime';
import {
  acceptFiling,
  dismissFiling,
  filingAfterCapture,
  isGameModeOn,
  repo,
  runGameBackfill,
  undoFiling,
  withDb,
} from '@storage';
import { onboardingPath } from '@ui/shell/paths';
import { createCommandHandlers, installContextMenu } from './commands';
import { registerE2eHooks } from './e2e';
import { createHandlers } from './handlers';
import {
  browserCommandDeps,
  browserMenuPort,
  browserOpenSidePanel,
  browserSessionArea,
  browserSiteDeps,
} from './platform';
import { registerPdfReaderMenu } from './pdf';
import { registerReminders } from './reminders';
import { createSiteAccess } from './siteAccess';
import { registerSync } from './sync';

const report = (err: unknown) => console.error('[StudyVault]', err);
/**
 * Derive the game ledger from existing history (ADR-022). Resumable and idempotent: when it is done
 * this costs one read, so every install, update and browser start may ask.
 */
const backfillGame = () =>
  runGameBackfill().then((r) => {
    if (r.status === 'failed') report(new Error(`game backfill: ${r.error ?? 'failed'}`));
  }, report);

// MV3 service worker: this body runs on every worker start and registers every listener
// synchronously. Nothing here may hold state that must outlive the worker.
declare const __SV_E2E__: boolean | undefined;

export default defineBackground(() => {
  // The old data is kept as a restorable archive before an update raises the schema (Settings >
  // Backup). The storage layer installs that for every context that loads it, so it no longer
  // depends on which one opens the database first; the `update` branch below makes that the worker.
  const site = createSiteAccess(browserSiteDeps());
  const commands = createCommandHandlers(browserCommandDeps(site));

  serveRpc(
    BackgroundRpc,
    createHandlers({
      repo,
      filing: {
        afterCapture: (input) => filingAfterCapture(input),
        accept: (id) => acceptFiling(id),
        dismiss: (id) => dismissFiling(id),
        undo: (id) => undoFiling(id),
      },
      // The authoritative copy: a content script can write chrome.storage.local, not the database.
      getSettings: getTrustedSettings,
      updateSettings,
      site,
      extensionBaseUrl: browser.runtime.getURL('/'),
      openSidePanel: browserOpenSidePanel,
      session: browserSessionArea(),
      isGameModeOn,
    }),
  );

  browser.commands.onCommand.addListener((command, tab) => {
    commands.onCommand(command, tab).catch(report);
  });
  browser.contextMenus.onClicked.addListener((info, tab) => {
    commands.onMenuClick(info.menuItemId, tab).catch(report);
  });

  // Opt-in toolbar count and daily notice (see ./reminders.ts). With the feature off, a start reads
  // one key of chrome.storage.local and nothing else.
  const reminders = registerReminders(undefined, report);

  // Registrations may not survive an update and permissions can change outside the UI.
  browser.runtime.onInstalled.addListener((details) => {
    // An update may raise the schema. Upgrade now, here, with the pre-update copy, rather than
    // whenever a page or the sync run first touches the database.
    if (details.reason === 'update') withDb(async () => {}).catch(report);
    backfillGame();
    installContextMenu(browserMenuPort()).catch(report);
    site.sync().catch(report);
    // The welcome tour opens once, on the first install: never for an update, a browser update or
    // a reload. It is skippable and can be reopened from the popup and the settings page.
    // The e2e build skips it: Playwright launches a fresh profile per test and would otherwise
    // get an extra page in every spec (the tour page itself is covered by its own e2e and unit test).
    if (details.reason === 'install' && !(typeof __SV_E2E__ !== 'undefined' && __SV_E2E__)) {
      browser.tabs
        .create({ url: browser.runtime.getURL(`/${onboardingPath}` as never) })
        .catch(report);
    }
  });
  browser.runtime.onStartup.addListener(() => {
    site.sync().catch(report);
    backfillGame();
  });
  // Chrome's grants are the truth and can change outside our UI (chrome://extensions, enterprise
  // policy): reconcile the registration in both directions.
  browser.permissions.onAdded.addListener(() => {
    site.sync().catch(report);
    reminders.onPermissionsChanged().catch(report);
  });
  browser.permissions.onRemoved.addListener(() => {
    site.sync().catch(report);
    reminders.onPermissionsChanged().catch(report);
  });

  // "Open in StudyVault reader" on links/pages/frames that look like PDFs (see ./pdf.ts).
  registerPdfReaderMenu(report);

  // E2E build only (see ./e2e.ts): the Playwright helpers change settings through the same function
  // an extension page uses. The production bundle contains none of it (scripts/check-build.mjs).
  if (typeof __SV_E2E__ !== 'undefined' && __SV_E2E__) {
    registerE2eHooks(browser.runtime.getURL('/'));
  }

  // Optional sync (see ./sync.ts): listeners only. Nothing reads, fetches or schedules unless
  // Settings.features.sync is on.
  registerSync(browser.runtime.getURL('/'));
});
