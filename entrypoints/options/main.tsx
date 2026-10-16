// Nunito, bundled as extension files (font-src 'self'); the in-page overlay never loads it.
import '@fontsource-variable/nunito';
import '@ui/tokens.css';
import '@ui/components.css';
import '@ui/sync/sync.css';
import './options.css';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from '@ui';
import { Options } from './Options';

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary surface="settings page">
    <Options />
  </ErrorBoundary>,
);
