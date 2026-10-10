import '@ui/tokens.css';
import '@ui/components.css';
import './sidepanel.css';
import { createRoot } from 'react-dom/client';
import { SidePanel } from './SidePanel';

createRoot(document.getElementById('root')!).render(<SidePanel />);
