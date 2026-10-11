import '@ui/tokens.css';
import '@ui/components.css';
import './reader.css';
import { createRoot } from 'react-dom/client';
import { configurePdfRuntime, parseReaderParams } from '@pdf';
import { bundledRuntime } from '@pdf/assets';
import { ErrorBoundary } from '@ui';
import { createOcrService } from './ocr';
import { Reader } from './Reader';
import { createStorageStore } from './store';

// Worker, cMaps, fonts and decoders are bundled extension assets (MV3: no remote code).
configurePdfRuntime(bundledRuntime);

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary surface="PDF reader">
    <Reader
      store={createStorageStore()}
      ocr={createOcrService()}
      params={parseReaderParams(window.location.search)}
    />
  </ErrorBoundary>,
);
