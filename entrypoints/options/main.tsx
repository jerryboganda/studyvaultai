import '@ui/tokens.css';
import '@ui/components.css';
import './options.css';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from '@ui';
import { Options } from './Options';

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary surface="settings page">
    <Options />
  </ErrorBoundary>,
);
