import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { BackgroundRpc } from '@shared';
import { getSettings, serveRpc, updateSettings } from '@runtime';
import { installPreMigrationSnapshot, repo } from '@storage';
import { onboardingPath } from '@ui/shell/paths';
import { createCommandHandlers, installContextMenu } from './commands';
import { createHandlers } from './handlers';
import {
  browserCommandDeps,
  browserMenuPort,
  browserOpenSidePanel,
  browserSessionArea,
  browserSiteDeps,
} from './platform';
import { registerPdfReaderMenu } from './pdf';
import { createSiteAccess } from './siteAccess';
import { registerSync } from './sync';

const report = (err: unknown) => console.error('[StudyVault]', err);

// MV3 service worker: this body runs on every worker start and registers every listener
// synchronously. Nothing here may hold state that must outlive the worker.
export default defineBackground(() => {
  // Before anything can open the database: when an update raises its schema, the old data is first
  // kept as a restorable archive (Settings > Backup). Only here: this is the context that meets the
  // upgrade, and a page that also installed it would track the hook in its own liveQuery.
  installPreMigrationSnapshot({ appVersion: browser.runtime.getManifest().version });

  const site = createSiteAccess(browserSiteDeps());
  const commands = createCommandHandlers(browserCommandDeps(site));

  serveRpc(
    BackgroundRpc,
    createHandlers({
      repo,
      getSettings,
      updateSettings,
      site,
      extensionBaseUrl: browser.runtime.getURL('/'),
      openSidePanel: browserOpenSidePanel,
      session: browserSessionArea(),
    }),
  );

  browser.commands.onCommand.addListener((command, tab) => {
    commands.onCommand(command, tab).catch(report);
  });
  browser.contextMenus.onClicked.addListener((info, tab) => {
    commands.onMenuClick(info.menuItemId, tab).catch(report);
  });

  // Registrations may not survive an update and permissions can change outside the UI.
  browser.runtime.onInstalled.addListener((details) => {
    installContextMenu(browserMenuPort()).catch(report);
    site.sync().catch(report);
    // The welcome tour opens once, on the first install: never for an update, a browser update or
    // a reload. It is skippable and can be reopened from the popup and the settings page.
    if (details.reason === 'install') {
      browser.tabs
        .create({ url: browser.runtime.getURL(`/${onboardingPath}` as never) })
        .catch(report);
    }
  });
  browser.runtime.onStartup.addListener(() => {
    site.sync().catch(report);
  });
  // Chrome's grants are the truth and can change outside our UI (chrome://extensions, enterprise
  // policy): reconcile the registration in both directions.
  browser.permissions.onAdded.addListener(() => {
    site.sync().catch(report);
  });
  browser.permissions.onRemoved.addListener(() => {
    site.sync().catch(report);
  });

  // "Open in StudyVault reader" on links/pages/frames that look like PDFs (see ./pdf.ts).
  registerPdfReaderMenu(report);

  // Optional sync (see ./sync.ts): listeners only. Nothing reads, fetches or schedules unless
  // Settings.features.sync is on.
  registerSync(browser.runtime.getURL('/'));
});
