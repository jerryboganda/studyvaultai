// Sunny Vault mockup gallery: every screen framed at its real size, with a theme switch.
import '@fontsource-variable/nunito';
import './tokens.css';
import './components.css';
import './screens.css';
import './shell.css';
import { StrictMode, useEffect, useId, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Monitor, Moon, Sun } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { LogoMark } from './shared';
import { Switch } from './ui';
import { BadgesSheet } from './screens/BadgesSheet';
import { CreateBank } from './screens/CreateBank';
import { Dashboard } from './screens/Dashboard';
import { InPage } from './screens/InPage';
import { Onboarding } from './screens/Onboarding';
import { Popup, type PopupVariant } from './screens/Popup';
import { Review } from './screens/Review';
import { SidePanel } from './screens/SidePanel';
import { VaultBuddy, type BuddyPose } from './VaultBuddy';

const POSES: { pose: BuddyPose; label: string }[] = [
  { pose: 'wave', label: 'Wave' },
  { pose: 'cheer', label: 'Cheer' },
  { pose: 'think', label: 'Think' },
  { pose: 'sleep', label: 'Sleep' },
];

function MascotSheet() {
  return (
    <div className="sv-screen g-mascots">
      {POSES.map(({ pose, label }) => (
        <figure key={pose} className="g-mascot">
          <VaultBuddy pose={pose} size={140} label={`Vault buddy, ${label.toLowerCase()} pose`} />
          <span className="g-mascotSmall">
            <VaultBuddy pose={pose} size={32} />
            <VaultBuddy pose={pose} size={48} />
          </span>
          <figcaption>{label}</figcaption>
        </figure>
      ))}
    </div>
  );
}

type Theme = 'light' | 'dark' | 'system';
const KEY = 'sv-sunny-theme';

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

function Seg<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { id: T; label: string; icon?: LucideIcon }[];
}) {
  const name = useId();
  return (
    <fieldset className="g-seg">
      <legend className="sv-vh">{label}</legend>
      {options.map(({ id, label: l, icon: Icon }) => (
        <label key={id}>
          <input type="radio" name={name} checked={value === id} onChange={() => onChange(id)} />
          {Icon && <Icon aria-hidden="true" strokeWidth={2.5} />}
          {l}
        </label>
      ))}
    </fieldset>
  );
}

function Frame({
  n,
  title,
  w,
  h,
  tools,
  children,
}: {
  n: string;
  title: string;
  w: number;
  h: number;
  tools?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="g-frame" aria-labelledby={id} data-frame={n}>
      <div className="g-cap">
        <span className="g-num" aria-hidden="true">
          {n.replace(/\D.*/, '')}
        </span>
        <h2 id={id}>{title}</h2>
        <span className="g-size">
          {w} × {h}
        </span>
        {tools && <div className="g-tools">{tools}</div>}
      </div>
      <div className="g-scroll">
        <div className="g-box" style={{ width: w, height: h }}>
          {children}
        </div>
      </div>
    </section>
  );
}

function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [popup, setPopup] = useState<PopupVariant>('on');
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // Not persisted; the switch still works for this visit.
    }
  }, [theme]);

  return (
    <>
      <header className="g-head">
        <LogoMark size={36} />
        <div>
          <h1>Sunny Vault</h1>
          <p>Direction mockups · sample data</p>
        </div>
        <span className="sv-spacer" />
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
      <main className="g-main">
        <Frame
          n="1"
          title="Popup"
          w={400}
          h={560}
          tools={
            <Seg
              label="Popup state"
              value={popup}
              onChange={setPopup}
              options={[
                { id: 'on', label: 'On' },
                { id: 'off', label: 'Off' },
                { id: 'pdf', label: 'PDF' },
              ]}
            />
          }
        >
          <Popup variant={popup} />
        </Frame>
        <Frame
          n="2"
          title="Side panel"
          w={360}
          h={800}
          tools={
            <span className="g-switch">
              <Switch checked={empty} onChange={setEmpty} label="Empty state" />
            </span>
          }
        >
          <SidePanel empty={empty} />
        </Frame>
        <Frame n="2b" title="Side panel, narrow" w={320} h={800}>
          <SidePanel empty={empty} />
        </Frame>
        <Frame n="0" title="Vault buddy" w={760} h={280}>
          <MascotSheet />
        </Frame>
        <Frame n="8" title="Badges & level" w={440} h={700}>
          <BadgesSheet />
        </Frame>
        <Frame n="3" title="Dashboard home" w={1280} h={800}>
          <Dashboard />
        </Frame>
        <Frame n="4" title="Review session" w={1280} h={800}>
          <Review />
        </Frame>
        <Frame n="5" title="Welcome wizard" w={1280} h={800}>
          <Onboarding />
        </Frame>
        <Frame n="6" title="New bank wizard" w={640} h={640}>
          <CreateBank />
        </Frame>
        <Frame n="7" title="In-page toolbar" w={960} h={600}>
          <InPage theme={theme === 'system' ? undefined : theme} />
        </Frame>
      </main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
