// Candy Garden mockup gallery: every screen framed at its real size, with a theme switch.
import '@fontsource-variable/nunito';
import './tokens.css';
import './components.css';
import './screens.css';
import './shell.css';
import { StrictMode, useCallback, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Monitor, Moon, RotateCcw, Sun, Trophy } from 'lucide-react';
import { VaultBuddy } from './VaultBuddy';
import { Btn, GO_EVENT, GoContext, Seg, Switch, type ScreenId } from './ui';
import { Badges } from './screens/Badges';
import { CreateBank } from './screens/CreateBank';
import { Dashboard } from './screens/Dashboard';
import { InPage } from './screens/InPage';
import { Onboarding } from './screens/Onboarding';
import { Popup, type PopupVariant } from './screens/Popup';
import { Review } from './screens/Review';
import { SidePanel } from './screens/SidePanel';

type Theme = 'light' | 'dark' | 'system';
const KEY = 'sv-candy-theme';

function initialTheme(): Theme {
  const q = new URLSearchParams(location.search).get('theme');
  if (q === 'light' || q === 'dark' || q === 'system') return q;
  try {
    const s = localStorage.getItem(KEY);
    if (s === 'light' || s === 'dark' || s === 'system') return s;
  } catch {
    // Storage can be blocked; follow the system.
  }
  return 'system';
}

const SCREENS: { id: ScreenId; label: string }[] = [
  { id: 'popup', label: 'Popup' },
  { id: 'sidepanel', label: 'Side panel' },
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'review', label: 'Review' },
  { id: 'onboarding', label: 'Onboarding' },
  { id: 'create-bank', label: 'New bank' },
  { id: 'badges', label: 'Badges' },
  { id: 'inpage', label: 'In-page' },
];

function Section({
  id,
  n,
  title,
  size,
  controls,
  children,
}: {
  id: ScreenId;
  n: number;
  title: string;
  size: string;
  controls?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="g-sec" id={`screen-${id}`} aria-labelledby={`h-${id}`}>
      <div className="g-cap">
        <h2 id={`h-${id}`} tabIndex={-1}>
          <span className="g-num" aria-hidden="true">
            {n}
          </span>
          {title}
        </h2>
        <span className="g-size">{size}</span>
        {controls && <div className="g-ctl">{controls}</div>}
      </div>
      <div className="g-frames">{children}</div>
    </section>
  );
}

function Frame({
  w,
  h,
  label,
  children,
  kind,
}: {
  w: number;
  h: number;
  label?: string;
  children: ReactNode;
  kind?: string;
}) {
  return (
    <figure className="g-fig">
      <div className="g-frame" data-kind={kind} style={{ width: w, height: h }}>
        {children}
      </div>
      {label && <figcaption className="g-figcap">{label}</figcaption>}
    </figure>
  );
}

function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [popup, setPopup] = useState<PopupVariant>('active');
  const [empty, setEmpty] = useState(false);
  const [review, setReview] = useState({ key: 0, done: false });
  const [inpageKey, setInpageKey] = useState(0);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // Not persisted; the switch still works for this visit.
    }
  }, [theme]);

  const go = useCallback((id: ScreenId) => {
    const sec = document.getElementById(`screen-${id}`);
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    sec?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    document.getElementById(`h-${id}`)?.focus({ preventScroll: true });
    window.dispatchEvent(new CustomEvent(GO_EVENT, { detail: id }));
  }, []);

  return (
    <GoContext.Provider value={go}>
      <div className="sv-app g-page">
        <header className="g-top">
          <VaultBuddy pose="wave" size={52} />
          <div className="g-title">
            <h1>Candy Garden</h1>
            <p>StudyVault redesign · clickable mockups</p>
          </div>
          <nav className="g-nav" aria-label="Screens">
            {SCREENS.map((s) => (
              <a key={s.id} href={`#screen-${s.id}`} className="g-navlink">
                {s.label}
              </a>
            ))}
          </nav>
          <Seg
            label="Theme"
            value={theme}
            onChange={setTheme}
            options={[
              { id: 'light', label: 'Light', icon: Sun },
              { id: 'dark', label: 'Dark', icon: Moon },
              { id: 'system', label: 'System', icon: Monitor },
            ]}
          />
        </header>

        <main className="g-grid">
          <Section
            id="popup"
            n={1}
            title="Popup"
            size="400 × 560"
            controls={
              <Seg
                label="Popup state"
                value={popup}
                onChange={setPopup}
                options={[
                  { id: 'active', label: 'On' },
                  { id: 'off', label: 'Off' },
                  { id: 'pdf', label: 'PDF' },
                  { id: 'blocked', label: 'Blocked' },
                ]}
              />
            }
          >
            <Frame w={400} h={560} kind="popup">
              <Popup variant={popup} onVariant={setPopup} />
            </Frame>
          </Section>

          <Section
            id="sidepanel"
            n={2}
            title="Side panel"
            size="360 & 320 × 800"
            controls={<Switch label="Empty state" checked={empty} onChange={setEmpty} />}
          >
            <Frame w={360} h={800} label="360 px" kind="panel">
              <SidePanel empty={empty} />
            </Frame>
            <Frame w={320} h={800} label="320 px" kind="panel">
              <SidePanel empty={empty} />
            </Frame>
          </Section>

          <Section id="dashboard" n={3} title="Dashboard home" size="1280 × 800">
            <Frame w={1280} h={800} kind="page">
              <Dashboard />
            </Frame>
          </Section>

          <Section
            id="review"
            n={4}
            title="Review session"
            size="1280 × 800"
            controls={
              <>
                <Btn
                  size="sm"
                  variant="soft"
                  icon={Trophy}
                  onClick={() => setReview((r) => ({ key: r.key + 1, done: true }))}
                >
                  Show finish
                </Btn>
                <Btn
                  size="sm"
                  variant="ghost"
                  icon={RotateCcw}
                  onClick={() => setReview((r) => ({ key: r.key + 1, done: false }))}
                >
                  Restart
                </Btn>
              </>
            }
          >
            <Frame w={1280} h={800} kind="page">
              <Review key={review.key} startDone={review.done} />
            </Frame>
          </Section>

          <Section id="onboarding" n={5} title="Onboarding" size="1280 × 800">
            <Frame w={1280} h={800} kind="page">
              <Onboarding />
            </Frame>
          </Section>

          <Section id="create-bank" n={6} title="New bank wizard" size="820 × 640 modal">
            <Frame w={820} h={640} kind="page">
              <CreateBank />
            </Frame>
          </Section>

          <Section id="badges" n={7} title="Badges & level" size="440 × 760 sheet">
            <Frame w={440} h={760} kind="panel">
              <Badges />
            </Frame>
          </Section>

          <Section
            id="inpage"
            n={8}
            title="In-page toolbar"
            size="1280 × 640 · shadow root"
            controls={
              <Btn
                size="sm"
                variant="ghost"
                icon={RotateCcw}
                onClick={() => setInpageKey((k) => k + 1)}
              >
                Reset demo
              </Btn>
            }
          >
            <Frame w={1280} h={640} kind="page">
              <InPage key={inpageKey} theme={theme} />
            </Frame>
          </Section>
        </main>
        <footer className="g-foot">
          <p>Sample data only · Nunito Variable · lucide-react · in-house SVG</p>
        </footer>
      </div>
    </GoContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
