import { z } from 'zod';
import { StudyVaultError, parseSettings } from '@shared';
import { serveRpc, updateSettings } from '@runtime';

/**
 * E2E BUILD ONLY (`__SV_E2E__`, registered from ./index.ts). The production bundle contains none of
 * this: the call is behind a build-time constant and everything below sits inside one function, so
 * the minifier drops it, and `scripts/check-build.mjs` fails the build when the hook name shows up
 * in a production file.
 *
 * Why it exists: the worker enforces the authoritative settings copy and ignores what is written
 * straight into `chrome.storage.local` (a content script can do that; see
 * docs/adr/010-module-seams.md, "Privileged configuration"). A Playwright helper that wants to
 * change a setting the way the options page does therefore asks the worker to run `updateSettings`,
 * the same function every extension page calls. Extension pages only; a content script is refused.
 */
declare const __SV_E2E__: boolean | undefined;

export function registerE2eHooks(extensionBaseUrl: string): void {
  // Belt and braces: even if a bundler kept this function, the build-time constant makes everything
  // below unreachable in the production bundle, and the minifier drops it.
  if (typeof __SV_E2E__ === 'undefined' || !__SV_E2E__) return;
  const E2eRpc = {
    /** `json`: a JSON string of the fields to merge (extension messaging drops `null` properties). */
    'e2e.settings.patch': {
      payload: z.object({ json: z.string().max(100_000) }),
      response: z.object({ ok: z.literal(true) }),
    },
  };
  serveRpc(E2eRpc, {
    'e2e.settings.patch': async ({ json }, sender) => {
      if (sender.tab !== undefined && !sender.url?.startsWith(extensionBaseUrl)) {
        throw new StudyVaultError('forbidden', 'E2E hooks answer extension pages only.');
      }
      const patch: unknown = JSON.parse(json);
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
        throw new StudyVaultError('invalid_request', 'The patch must be an object.');
      }
      await updateSettings((current) => parseSettings({ ...current, ...patch }));
      return { ok: true as const };
    },
  });
}
