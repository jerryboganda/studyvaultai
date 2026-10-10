import '@ui/tokens.css';
import '@ui/components.css';
import './popup.css';
import { createRoot } from 'react-dom/client';
import { Popup } from './Popup';

createRoot(document.getElementById('root')!).render(<Popup />);
