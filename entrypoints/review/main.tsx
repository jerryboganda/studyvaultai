// Nunito, bundled as extension files (font-src 'self'); the in-page overlay never loads it.
import '@fontsource-variable/nunito';
import '@ui/tokens.css';
import '@ui/components.css';
import '@ui/review/review.css';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from '@ui';
import { Review } from './Review';

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary surface="review page">
    <Review />
  </ErrorBoundary>,
);
