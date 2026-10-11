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
