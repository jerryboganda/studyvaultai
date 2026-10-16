// Sunny Vault component preview: every component and state, in light and dark side by side
// (?theme=light|dark shows one theme on the whole page). Dev-only; never part of the build.
import '@fontsource-variable/nunito';
import '@ui/design/tokens.css';
import '@ui/design/components.css';
import './preview.css';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Columns2, Moon, Sun } from 'lucide-react';
import { ChunkyButton, VaultBuddy } from '@ui/design';
import { Showcase } from './Showcase';

type View = 'both' | 'light' | 'dark';

function initialView(): View {
  const q = new URLSearchParams(location.search).get('theme');
  return q === 'light' || q === 'dark' ? q : 'both';
}

function Preview() {
  const [view, setView] = useState<View>(initialView);
  useEffect(() => {
    const root = document.documentElement;
    if (view === 'both') delete root.dataset.theme;
    else root.dataset.theme = view;
    const url = new URL(location.href);
    url.searchParams.set('theme', view);
    history.replaceState(null, '', url);
  }, [view]);

  const themes: View[] = view === 'both' ? ['light', 'dark'] : [view];
  return (
    <div className="sv-ui dz-page">
      <header className="dz-top">
        <VaultBuddy pose="wave" size={40} />
        <div>
          <h1>Sunny Vault components</h1>
          <span className="dz-top__sub">packages/ui/src/design</span>
        </div>
        <span className="dz-spacer" />
        <div className="dz-themes" role="group" aria-label="Theme">
          {(
            [
              ['both', 'Both', Columns2],
              ['light', 'Light', Sun],
              ['dark', 'Dark', Moon],
            ] as const
          ).map(([id, label, icon]) => (
            <ChunkyButton
              key={id}
              size="sm"
              icon={icon}
              variant={view === id ? 'primary' : 'secondary'}
              aria-pressed={view === id}
              onClick={() => setView(id)}
            >
              {label}
            </ChunkyButton>
          ))}
        </div>
      </header>
      <main className="dz-cols">
        {themes.map((theme) => (
          <div key={theme} className="sv-ui dz-col" data-theme={theme}>
            {view === 'both' && <p className="dz-col__label">{theme}</p>}
            <Showcase />
          </div>
        ))}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
