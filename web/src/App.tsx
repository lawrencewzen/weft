import { useEffect, useRef, useState } from 'react';
import { getPreferredLang } from './data/lang';
import { peekSettingsBehind, readAddressPath, subscribeAddress } from './data/nav';
import { applyDocumentPrefs, subscribePrefs, watchSystemAppearance } from './data/prefs';
import { SessionProvider } from './data/session';
import { t } from './i18n';
import { parseRoute, viewRouteWhileSettings, type AppRoute } from './route';
import { AppShell } from './components/AppShell';
import type { AboutService } from './components/settings/AboutPage';

const UNAUTH = '请用 weft open 打开新版网页端';

function usePathname(): string {
  const [path, setPath] = useState(() => readAddressPath());
  useEffect(() => subscribeAddress(() => setPath(readAddressPath())), []);
  return path;
}

export function App() {
  const pathname = usePathname();
  const parsed = parseRoute(pathname);
  const backgroundRef = useRef<AppRoute | null>(parsed.name === 'settings' ? null : parsed);
  if (parsed.name !== 'settings') backgroundRef.current = parsed;
  const route = parsed.name === 'settings'
    ? viewRouteWhileSettings(backgroundRef.current, peekSettingsBehind())
    : parsed;
  const settingsPage = parsed.name === 'settings' ? parsed.page : null;
  const [lang, setLang] = useState(getPreferredLang);
  const [ready, setReady] = useState(false);
  const [unauth, setUnauth] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [service, setService] = useState<AboutService>({
    serviceVersion: '',
    protocolVersion: '',
    demo: false,
  });

  useEffect(() => subscribePrefs(() => setLang(getPreferredLang())), []);
  useEffect(() => watchSystemAppearance(), []);
  useEffect(() => {
    applyDocumentPrefs({ lang });
  }, [lang]);

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
          const body = await res.json() as {
            demo?: unknown;
            serviceVersion?: unknown;
            protocolVersion?: unknown;
          };
          setService({
            serviceVersion: typeof body.serviceVersion === 'string' ? body.serviceVersion : '',
            protocolVersion: typeof body.protocolVersion === 'string' ? body.protocolVersion : '',
            demo: body.demo === true,
          });
        } catch {
          setService({ serviceVersion: '', protocolVersion: '', demo: false });
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
          <h1>{t(lang, 'app_name')}</h1>
          <p className="next-error" data-testid="next-error">{error || UNAUTH}</p>
        </div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div data-testid="next-app">
        <div className="next-home">
          <h1>{t(lang, 'app_name')}</h1>
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
      <AppShell route={route} lang={lang} demo={service.demo} service={service} settingsPage={settingsPage} />
    </SessionProvider>
  );
}
