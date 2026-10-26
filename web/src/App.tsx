import { useEffect, useState } from 'react';
import { getPreferredLang } from './data/lang';
import { SessionProvider } from './data/session';
import { t } from './i18n';
import { parseRoute, type AppRoute } from './route';
import { AppShell } from './components/AppShell';

const UNAUTH = '请用 weft open 打开新版网页端';

function usePathname(): string {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return path;
}

export function App() {
  const pathname = usePathname();
  const parsed = parseRoute(pathname);
  const [background, setBackground] = useState<AppRoute>({ name: 'home' });
  useEffect(() => {
    const next = parseRoute(pathname);
    if (next.name !== 'settings') setBackground(next);
  }, [pathname]);
  const route = parsed.name === 'settings' ? background : parsed;
  const settingsPage = parsed.name === 'settings' ? parsed.page : null;
  const lang = getPreferredLang();
  const [ready, setReady] = useState(false);
  const [unauth, setUnauth] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [demo, setDemo] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const res = await fetch('/api/v2/service', { signal: ac.signal, credentials: 'same-origin' });
        if (res.status === 401) {
          setUnauth(true);
          setError(UNAUTH);
          return;
        }
        if (!res.ok) {
          setError(`${res.status} ${res.statusText}`.trim());
          return;
        }
        try {
          const body = await res.json() as { demo?: unknown };
          setDemo(body.demo === true);
        } catch {
          setDemo(false);
        }
        setReady(true);
      } catch (err) {
        if (ac.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => ac.abort();
  }, []);

  if (unauth) {
    return (
      <div data-testid="next-app">
        <div className="next-home">
          <h1>{t(lang, 'home_title')}</h1>
          <p className="next-error" data-testid="next-error">{error || UNAUTH}</p>
        </div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div data-testid="next-app">
        <div className="next-home">
          <h1>{t(lang, 'home_title')}</h1>
          {error ? <p className="next-error" data-testid="next-error">{error}</p> : <p>{t(lang, 'loading')}</p>}
        </div>
      </div>
    );
  }

  const conversationId = route.name === 'conversation'
    ? route.id
    : route.name === 'subagent'
      ? route.conversationId
      : null;
  const subagent = route.name === 'subagent'
    ? { conversationId: route.conversationId, agentId: route.agentId }
    : null;

  return (
    <SessionProvider conversationId={conversationId} subagent={subagent} lang={lang}>
      <AppShell route={route} lang={lang} demo={demo} settingsPage={settingsPage} />
    </SessionProvider>
  );
}
