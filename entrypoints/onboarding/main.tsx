// Nunito, bundled as extension files (font-src 'self'); the in-page overlay never loads it.
import '@fontsource-variable/nunito';
import '@ui/tokens.css';
import '@ui/components.css';
import './onboarding.css';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from '@ui';
import { Onboarding } from './Onboarding';

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary surface="welcome tour">
    <Onboarding />
  </ErrorBoundary>,
);
