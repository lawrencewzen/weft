import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { getPreferredLang } from './data/lang';
import { applyDocumentPrefs } from './data/prefs';
import './styles/themes.css';
import './styles/app.css';
import './styles/settings.css';

applyDocumentPrefs({ lang: getPreferredLang() });

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
