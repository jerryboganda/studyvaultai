import { useEffect, useRef, useState, type RefObject } from 'react';
import { createRoot } from 'react-dom/client';
import { catalog, type CatalogState, type CatalogSurface } from './catalog';

/**
 * Gallery overview: every real page in frames at its real viewport size (full pages scaled to
 * half), with a scenario and a theme switch for all of them and a state picker per page.
 * The choice is kept in this page's address so a view can be shared.
 */

type Theme = 'light' | 'dark';
const MOCKUPS = ['sunny', 'design'] as const;
/** Pages wider than this are shown at half size. */
const SCALE_ABOVE = 600;

const initial = new URLSearchParams(location.search);

function frameUrl(surface: CatalogSurface, state: CatalogState, scenario: string, theme: Theme) {
  const q = new URLSearchParams({ scenario, theme });
  if (state.id !== 'default') q.set('state', state.id);
  return `./pages/${surface.id}.html?${q}`;
}

/**
 * Frames load one at a time: same-origin frames share this page's thread, so eight pages seeding
 * at once all appear after a minute, while in turn the first appears in seconds.
 */
let turns: Promise<void> = Promise.resolve();
const FRAME_TIMEOUT = 45_000;

function useTurn(src: string, frame: RefObject<HTMLIFrameElement | null>): string | undefined {
  const [shown, setShown] = useState<string>();
  useEffect(() => {
    let live = true;
    const turn = async () => {
      if (!live) return;
      setShown(src);
      const until = performance.now() + FRAME_TIMEOUT;
      while (live && frame.current && performance.now() < until) {
        const state = frame.current.contentDocument?.documentElement.dataset.gallery;
        if (state === 'mounted' || state === 'error') return;
        await new Promise((r) => setTimeout(r, 200));
      }
    };
    turns = turns.then(turn, turn);
    return () => {
      live = false;
    };
  }, [src, frame]);
  return shown;
}

function Frame({ src, width, height }: { src: string; width: number; height: number }) {
  const scale = width > SCALE_ABOVE ? 0.5 : 1;
  const ref = useRef<HTMLIFrameElement>(null);
  const shown = useTurn(src, ref);
  return (
    <figure className="frame">
      <div className="frame__box" style={{ width: width * scale, height: height * scale }}>
        <iframe
          ref={ref}
          src={shown}
          title={`${src} at ${width} by ${height}`}
          width={width}
          height={height}
          style={{ transform: `scale(${scale})` }}
        />
      </div>
      <figcaption>
        {width} × {height}
        {scale < 1 ? ' (shown at half size)' : ''}
        {shown ? '' : ' (waiting for its turn)'} ·{' '}
        <a href={src} target="_blank" rel="noreferrer">
          Open full size
        </a>
      </figcaption>
    </figure>
  );
}

function SurfaceSection({
  surface,
  scenario,
  theme,
}: {
  surface: CatalogSurface;
  scenario: string;
  theme: Theme;
}) {
  const [stateId, setStateId] = useState('default');
  const state = surface.states.find((s) => s.id === stateId) ?? surface.states[0]!;
  const scenarios = state.scenarios ?? surface.scenarios;
  // A state that is not shown with this scenario falls back to its first one, and says so.
  const shown = scenarios.includes(scenario) ? scenario : scenarios[0]!;
  const viewport = state.viewport ?? surface.viewport;
  const widths = state.viewport ? [viewport.width] : [viewport.width, ...(surface.widths ?? [])];
  const pickerId = `state-${surface.id}`;
  return (
    <section className="surface" aria-labelledby={`h-${surface.id}`}>
      <div className="surface__head">
        <h2 id={`h-${surface.id}`}>{surface.title}</h2>
        <label htmlFor={pickerId}>State</label>
        <select id={pickerId} value={state.id} onChange={(e) => setStateId(e.target.value)}>
          {surface.states.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        {shown !== scenario ? (
          <p className="note">
            Not shown with “{scenario}”: this is the “{shown}” scenario.
          </p>
        ) : null}
        {state.query?.fault ? (
          <p className="note">
            Injected failure (gallery only): <code>{state.query.fault}</code>
          </p>
        ) : null}
      </div>
      <div className="frames">
        {widths.map((w) => (
          <Frame
            key={`${w}-${state.id}-${shown}-${theme}`}
            src={frameUrl(surface, state, shown, theme)}
            width={w}
            height={viewport.height}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * Pages move focus and scroll sections into view as they mount, and inside a frame that scrolls
 * this page too. Only scrolling the person started (wheel, keys, pointer, touch) is kept.
 */
function useScrollGuard() {
  useEffect(() => {
    let lastY = window.scrollY;
    let userAt = 0;
    const mark = () => {
      userAt = performance.now();
    };
    const onScroll = () => {
      if (performance.now() - userAt < 1500) lastY = window.scrollY;
      else window.scrollTo(0, lastY);
    };
    const inputs = ['wheel', 'keydown', 'pointerdown', 'touchmove'] as const;
    for (const t of inputs) window.addEventListener(t, mark, { capture: true, passive: true });
    window.addEventListener('scroll', onScroll);
    return () => {
      for (const t of inputs) window.removeEventListener(t, mark, { capture: true });
      window.removeEventListener('scroll', onScroll);
    };
  }, []);
}

function Overview() {
  useScrollGuard();
  const [scenario, setScenario] = useState(initial.get('scenario') ?? 'student');
  const [theme, setTheme] = useState<Theme>(initial.get('theme') === 'dark' ? 'dark' : 'light');
  const remember = (next: { scenario?: string; theme?: Theme }) => {
    const q = new URLSearchParams({ scenario, theme, ...next });
    history.replaceState(null, '', `?${q}`);
  };
  return (
    <>
      <header className="top">
        <h1>StudyVault screen gallery</h1>
        <p className="note">
          The real extension pages on localhost, with a fake <code>chrome</code> and seeded data. A
          design-review tool, not proof of extension behaviour.
        </p>
        <div className="controls">
          <label>
            Scenario{' '}
            <select
              value={scenario}
              onChange={(e) => {
                setScenario(e.target.value);
                remember({ scenario: e.target.value });
              }}
            >
              {catalog.scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id}: {s.title}
                </option>
              ))}
            </select>
          </label>
          <fieldset>
            <legend>Theme</legend>
            {(['light', 'dark'] as const).map((t) => (
              <label key={t}>
                <input
                  type="radio"
                  name="theme"
                  checked={theme === t}
                  onChange={() => {
                    setTheme(t);
                    remember({ theme: t });
                  }}
                />{' '}
                {t}
              </label>
            ))}
          </fieldset>
        </div>
        <nav aria-label="Gallery pages" className="links">
          {MOCKUPS.map((m) => (
            <a key={m} href={`./mockups/${m}/`}>
              Mockup: {m}
            </a>
          ))}
        </nav>
      </header>
      <main>
        {catalog.surfaces.map((surface) => (
          <SurfaceSection key={surface.id} surface={surface} scenario={scenario} theme={theme} />
        ))}
        <section className="surface" aria-labelledby="h-mockups">
          <h2 id="h-mockups">Mockups</h2>
          <p className="note">The chosen Sunny Vault direction and the component preview.</p>
          <ul>
            {MOCKUPS.map((m) => (
              <li key={m}>
                <a href={`./mockups/${m}/`}>{m}</a>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Overview />);
