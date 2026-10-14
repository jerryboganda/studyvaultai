// Nunito, bundled as extension files (font-src 'self'); the in-page overlay never loads it.
import '@fontsource-variable/nunito';
import '@ui/tokens.css';
import '@ui/components.css';
import '@ui/vault/vault.css';
import './sidepanel.css';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from '@ui';
import { SidePanel } from './SidePanel';

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary surface="side panel">
    <SidePanel />
  </ErrorBoundary>,
);
