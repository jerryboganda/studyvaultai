// Order matters: the in-memory IndexedDB and the fake chrome must exist before Dexie or any module
// that imports `wxt/browser` is evaluated. Everything else is imported dynamically below.
import 'fake-indexeddb/auto';
import { gallery } from './shim/chrome';
import { findState } from './catalog';

/** The real entrypoints: importing one mounts the page exactly as the extension does. */
const SURFACES = {
  popup: () => import('../entrypoints/popup/main'),
  sidepanel: () => import('../entrypoints/sidepanel/main'),
  dashboard: () => import('../entrypoints/dashboard/main'),
  review: () => import('../entrypoints/review/main'),
  options: () => import('../entrypoints/options/main'),
  onboarding: () => import('../entrypoints/onboarding/main'),
  'pdf-reader': () => import('../entrypoints/pdf-reader/main'),
} as const;
export type Surface = keyof typeof SURFACES;

type Theme = 'light' | 'dark';

/**
 * Gallery page bootstrap. Query parameters:
 *  - scenario: fresh | student (default) | heavy | edge
 *  - theme: light | dark (default: the scenario's setting, which follows the system)
 *  - tab: active tab preset (scenarios/tabs.ts) or an address; default per scenario
 *  - state: a state from catalog.json; its address parameters are added (the page's own wins) and
 *    its script (states.ts) runs before and after the page mounts
 * `<html data-gallery>` reads seeding -> mounted, or error (the message is shown in the page).
 * `window.__gallery.setTheme('dark')` switches the theme in place, as the Settings page does.
 */
export async function boot(surface: Surface): Promise<void> {
  const html = document.documentElement;
  html.dataset.gallery = 'seeding';
  // Extension popups close themselves after opening a page; a gallery tab must stay.
  window.close = () => console.info('[gallery] window.close()');
  try {
    const stateId = new URLSearchParams(location.search).get('state') ?? 'default';
    const state = findState(surface, stateId);
    const url = new URL(location.href);
    for (const [name, value] of Object.entries(state.query ?? {})) {
      if (!url.searchParams.has(name)) url.searchParams.set(name, value);
    }
    if (state.hash && !url.hash) url.hash = state.hash;
    const setParam = (name: string, value: string) => {
      if (!url.searchParams.has(name)) url.searchParams.set(name, value);
    };
    history.replaceState(null, '', url);

    const params = url.searchParams;
    const theme = params.get('theme');
    if (theme === 'light' || theme === 'dark') html.dataset.theme = theme;
    const started = performance.now();
    const [{ loadScenario }, { startBackend }, { openActiveTab }, { updateSettings }, { SCRIPTS }] =
      await Promise.all([
        import('./scenarios'),
        import('./backend'),
        import('./scenarios/tabs'),
        import('@runtime'),
        import('./states'),
      ]);
    const setTheme = async (next: Theme) => {
      html.dataset.theme = next;
      await updateSettings((s) => ({ ...s, theme: next }));
    };
    Object.assign(gallery, { setTheme });
    const scenario = await loadScenario(params.get('scenario') ?? 'student');
    const { site } = startBackend();
    openActiveTab(params.get('tab') ?? scenario.tab);
    await scenario.seed({ params, site });
    if (theme === 'light' || theme === 'dark') await setTheme(theme);
    const script = SCRIPTS[surface]?.[stateId];
    await script?.prepare?.(setParam);
    history.replaceState(null, '', url);
    console.info(
      `[gallery] ${surface}/${stateId}: scenario "${scenario.id}" seeded in ${Math.round(performance.now() - started)} ms`,
    );
    await SURFACES[surface]();
    await script?.run?.();
    html.dataset.gallery = 'mounted';
  } catch (err) {
    html.dataset.gallery = 'error';
    const box = document.createElement('pre');
    box.setAttribute('role', 'alert');
    box.style.cssText = 'margin:16px;padding:12px;border:2px solid #b91c1c;white-space:pre-wrap';
    box.textContent = `Gallery could not start ${surface}:\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
    document.body.prepend(box);
    throw err;
  }
}
