import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { BackgroundRpc } from '@shared';
import { getSettings, serveRpc, updateSettings } from '@runtime';
import { repo } from '@storage';
import { createCommandHandlers, installContextMenu } from './commands';
import { createDeleteLedger } from './deleteLedger';
import { createHandlers } from './handlers';
import {
  browserCommandDeps,
  browserMenuPort,
  browserOpenSidePanel,
  browserSessionArea,
  browserSiteDeps,
} from './platform';
import { createSiteAccess } from './siteAccess';

const report = (err: unknown) => console.error('[StudyVault]', err);

// MV3 service worker: this body runs on every worker start and registers every listener
// synchronously. Nothing here may hold state that must outlive the worker.
export default defineBackground(() => {
  const site = createSiteAccess(browserSiteDeps());
  const commands = createCommandHandlers(browserCommandDeps(site));

  serveRpc(
    BackgroundRpc,
    createHandlers({
      repo,
      getSettings,
      updateSettings,
      site,
      ledger: createDeleteLedger(browserSessionArea()),
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
  browser.runtime.onInstalled.addListener(() => {
    installContextMenu(browserMenuPort()).catch(report);
    site.sync().catch(report);
  });
  browser.runtime.onStartup.addListener(() => {
    site.sync().catch(report);
  });
  browser.permissions.onRemoved.addListener(() => {
    site.sync().catch(report);
  });
});
