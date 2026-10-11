import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { TabRpc } from '@shared';
import { callBackground, getSettings, serveRpc, watchDataEpoch, watchSettings } from '@runtime';
import { bootOnce } from './boot';
import { startController } from './controller';
import { createCaptureUi } from './ui';

// Injected at runtime via chrome.scripting (activeTab or user-granted optional host access).
// `matches` is a type requirement only: the build hook strips the resulting host_permissions.
export default defineContentScript({
  matches: ['https://*/*', 'http://*/*'],
  registration: 'runtime',
  // CSS is inlined by ui/index.tsx; 'manual' keeps WXT from adding a web_accessible_resources entry.
  cssInjectionMode: 'manual',
  // Without this WXT also window.postMessage()s '<extension id>:highlighter:wxt:content-script-started'
  // to the page on every start: any page script would learn the extension id (a stable fingerprint).
  // The supersede handshake itself runs on a document CustomEvent and is unaffected.
  noScriptStartedPostMessage: true,
  main(ctx) {
    // Isolated worlds persist across executions, so the guard lives on globalThis (boot.ts).
    bootOnce(globalThis, ctx, () =>
      startController({
        ctx,
        win: window,
        version: browser.runtime.getManifest().version,
        call: callBackground,
        serve: (handlers) => serveRpc(TabRpc, handlers),
        getSettings,
        watchSettings,
        watchDataEpoch,
        createUi: createCaptureUi,
      }),
    );
  },
});
