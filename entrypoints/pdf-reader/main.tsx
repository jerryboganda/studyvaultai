// Nunito, bundled as extension files (font-src 'self'); the in-page overlay never loads it.
import '@fontsource-variable/nunito';
import '@ui/tokens.css';
import '@ui/components.css';
import './reader.css';
import { createRoot } from 'react-dom/client';
import { configurePdfRuntime, parseReaderParams } from '@pdf';
import { bundledRuntime } from '@pdf/assets';
import { setPdfWriteRestriction } from '@storage';
import { ErrorBoundary } from '@ui';
import { createOcrService } from './ocr';
import { onceWindowPrivacy, refusalFor } from './privacy';
import { Reader } from './Reader';
import { createStorageStore } from './store';

// Worker, cMaps, fonts and decoders are bundled extension assets (MV3: no remote code).
configurePdfRuntime(bundledRuntime);

const params = parseReaderParams(window.location.search);
const privacy = onceWindowPrivacy(params.incognito);

// Registered before anything can write: the storage layer then refuses every PDF write made from
// this page while the window is private (or cannot be told) and "Save from private windows" is off.
setPdfWriteRestriction(async () => refusalFor(await privacy()));

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary surface="PDF reader">
    <Reader
      store={createStorageStore()}
      ocr={createOcrService()}
      params={params}
      privacy={privacy}
    />
  </ErrorBoundary>,
);
