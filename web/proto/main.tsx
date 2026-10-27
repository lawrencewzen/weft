import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../src/App';
import { getPreferredLang } from '../src/data/lang';
import { setAddressMode } from '../src/data/nav';
import { applyDocumentPrefs } from '../src/data/prefs';
import { installBrandIcons } from './brand-icons';
import { installMockBackend } from './mock';
import '../src/styles/themes.css';
import '../src/styles/app.css';
import '../src/styles/settings.css';

// Order matters: routing and the fake backend are in place before the first render.
setAddressMode('hash');
installBrandIcons();
installMockBackend();
applyDocumentPrefs({ lang: getPreferredLang() });

document.documentElement.setAttribute('data-proto', '1');

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
