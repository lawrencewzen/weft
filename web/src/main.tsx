import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installClientLog } from './data/clientLog';
import { getPreferredLang } from './data/lang';
import { applyDocumentPrefs } from './data/prefs';
import './styles/themes.css';
import './styles/app.css';
import './styles/settings.css';
import './styles/schedules.css';

applyDocumentPrefs({ lang: getPreferredLang() });
installClientLog();

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
