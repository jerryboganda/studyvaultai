// Nunito, bundled as extension files (font-src 'self'); the in-page overlay never loads it.
import '@fontsource-variable/nunito';
import '@ui/tokens.css';
import '@ui/components.css';
import './popup.css';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from '@ui';
import { Popup } from './Popup';

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary surface="popup">
    <Popup />
  </ErrorBoundary>,
);
