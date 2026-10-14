// Night Arcade mockup gallery: every screen framed at its real size, with a theme switch.
import '@fontsource-variable/nunito';
import './tokens.css';
import './components.css';
import './screens.css';
import './shell.css';
import { StrictMode, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import type { Theme } from './data';
import { Switch } from './ui';
import { VaultBuddy, type BuddyPose } from './VaultBuddy';
import { BadgesSheet } from './screens/BadgesSheet';
import { CreateBank } from './screens/CreateBank';
import { Dashboard } from './screens/Dashboard';
import { InPage } from './screens/InPage';
import { Onboarding } from './screens/Onboarding';
import { Popup, type PopupVariant } from './screens/Popup';
import { Review } from './screens/Review';
import { SidePanel } from './screens/SidePanel';

const KEY = 'sv-arcade-theme';

function initialTheme(): Theme {
  const q = new URLSearchParams(location.search).get('theme');
  if (q === 'light' || q === 'dark' || q === 'system') return q;
  try {
    const s = localStorage.getItem(KEY);
    if (s === 'light' || s === 'dark') return s;
  } catch {
    // Storage can be blocked; the system theme is a fine default.
  }
  return 'system';
}

const THEMES: { id: Theme; label: string; icon: LucideIcon }[] = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'system', label: 'System', icon: Monitor },
];

function Segmented<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
}: {
  legend: string;
  name: string;
  value: T;
  options: { id: T; label: string; icon?: LucideIcon }[];
  onChange: (v: T) => void;
}) {
  return (
    <fieldset className="g-seg">
      <legend>{legend}</legend>
      {options.map(({ id, label, icon: Icon }) => (
        <label key={id}>
          <input
            type="radio"
            name={name}
            value={id}
            checked={value === id}
            onChange={() => onChange(id)}
          />
          {Icon && <Icon aria-hidden size={16} strokeWidth={2.6} />}
          {label}
        </label>
      ))}
    </fieldset>
  );
}

function Frame({
  id,
  w,
  h,
  caption,
  controls,
  children,
}: {
  id: string;
  w: number;
  h: number;
  caption: string;
  controls?: ReactNode;
  children: ReactNode;
}) {
  return (
    <figure className="g-frame" data-shot={id}>
      <div className="g-scroll">
        <div className="g-screen sv-app sv-screen" style={{ width: w, height: h }}>
          {children}
        </div>
      </div>
      <figcaption>
        <b>{caption}</b>
        <span>
          {w}×{h}
        </span>
        {controls}
      </figcaption>
    </figure>
  );
}

function Section({
  n,
  id,
  title,
  children,
}: {
  n: number | string;
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="g-section" id={id} aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>
        <span className="g-n" aria-hidden>
          {n}
        </span>
        {title}
      </h2>
      <div className="g-row">{children}</div>
    </section>
  );
}

const POSES: { pose: BuddyPose; label: string }[] = [
  { pose: 'wave', label: 'Wave' },
  { pose: 'cheer', label: 'Cheer' },
  { pose: 'think', label: 'Think' },
  { pose: 'sleep', label: 'Sleep' },
];

const SWATCHES = [
  'bg',
  'surface',
  'surface-raised',
  'text',
  'text-muted',
  'lime',
  'accent-text',
  'pink',
  'pink-text',
  'cyan-text',
  'streak-text',
  'xp-text',
  'violet',
  'focus',
];

function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [popup, setPopup] = useState<PopupVariant>('on');
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      if (theme === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, theme);
    } catch {
      // Not remembering the choice is fine.
    }
  }, [theme]);

  return (
    <div className="sv-app g-page">
      <header className="g-top">
        <div className="g-brand">
          <VaultBuddy pose="wave" size={44} />
          <div>
            <h1>Night Arcade</h1>
            <p>StudyVault redesign · direction C · clickable mockups</p>
          </div>
        </div>
        <Segmented
          legend="Theme"
          name="g-theme"
          value={theme}
          options={THEMES}
          onChange={setTheme}
        />
      </header>
      <main>
        <Section n="★" id="g-buddy" title="Vault buddy">
          <Frame id="mascot" w={920} h={300} caption="Poses at 140, 48 and 32 px">
            <div className="g-mascots">
              {POSES.map(({ pose, label }) => (
                <figure key={pose} className="g-mascot">
                  <VaultBuddy
                    pose={pose}
                    size={140}
                    label={`Vault buddy, ${label.toLowerCase()} pose`}
                  />
                  <span className="g-mascot__small">
                    <VaultBuddy pose={pose} size={48} />
                    <VaultBuddy pose={pose} size={32} />
                  </span>
                  <figcaption>{label}</figcaption>
                </figure>
              ))}
            </div>
          </Frame>
          <Frame id="palette" w={560} h={300} caption="Core tokens (current theme)">
            <div className="g-swatches">
              {SWATCHES.map((s) => (
                <div key={s} className="g-swatch">
                  <span style={{ background: `var(--sv-${s})` }} />
                  <span>--sv-{s}</span>
                </div>
              ))}
            </div>
          </Frame>
        </Section>

        <Section n={1} id="screen-popup" title="Popup">
          <Frame
            id="popup"
            w={400}
            h={560}
            caption="Toolbar popup"
            controls={
              <Segmented
                legend="Popup state"
                name="g-popup"
                value={popup}
                onChange={setPopup}
                options={[
                  { id: 'on', label: 'On here' },
                  { id: 'off', label: 'Off here' },
                  { id: 'pdf', label: 'PDF' },
                ]}
              />
            }
          >
            <Popup key={popup} variant={popup} />
          </Frame>
        </Section>

        <Section n={2} id="screen-sidepanel" title="Side panel">
          <Frame
            id="sidepanel"
            w={360}
            h={800}
            caption="Side panel"
            controls={<Switch checked={empty} onChange={setEmpty} label="Empty state" />}
          >
            <SidePanel empty={empty} />
          </Frame>
          <Frame id="sidepanel-320" w={320} h={800} caption="Narrowest width">
            <SidePanel empty={empty} />
          </Frame>
        </Section>

        <Section n={3} id="screen-dashboard" title="Dashboard home">
          <Frame id="dashboard" w={1280} h={800} caption="Home">
            <Dashboard />
          </Frame>
        </Section>

        <Section n={4} id="screen-review" title="Review session">
          <Frame id="review" w={1280} h={800} caption="Card · keys 1–4, Space">
            <Review />
          </Frame>
          <Frame id="review-done" w={1280} h={800} caption="Session complete">
            <Review initial="complete" />
          </Frame>
        </Section>

        <Section n={5} id="screen-onboarding" title="Onboarding wizard">
          <Frame id="onboarding" w={1280} h={800} caption="Welcome tour">
            <Onboarding />
          </Frame>
        </Section>

        <Section n={6} id="screen-createbank" title="Create-bank wizard">
          <Frame id="createbank" w={960} h={680} caption="Modal over the dashboard">
            <CreateBank />
          </Frame>
        </Section>

        <Section n={7} id="screen-inpage" title="In-page toolbar">
          <Frame id="inpage" w={960} h={600} caption="On a website · shadow root · system font">
            <InPage theme={theme} />
          </Frame>
        </Section>

        <Section n={8} id="screen-badges" title="Badges & level">
          <Frame id="badges" w={400} h={780} caption="Level sheet">
            <BadgesSheet />
          </Frame>
        </Section>
      </main>
    </div>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
