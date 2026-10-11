import '@ui/tokens.css';
import '@ui/components.css';
import '@ui/vault/vault.css';
import './dashboard.css';
import './rules.css';
import { createRoot } from 'react-dom/client';
import { Dashboard } from './Dashboard';

createRoot(document.getElementById('root')!).render(<Dashboard />);
