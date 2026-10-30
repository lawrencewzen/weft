import { useEffect, useState } from 'react';
import type { Lang } from '../data/lang';
import type { components } from '../../../src/v2/contract.gen';
import { t } from '../i18n';
import { StatusIcon } from './StatusIcon';

type RunState = components['schemas']['RunState'];

const TICK_MS = 15_000;

export function stallMinutes(stalledSince: number, now: number): number {
  return Math.max(1, Math.floor((now - stalledSince) / 60_000));
}

export function StallStrip({
  run,
  lang,
  onStop,
}: {
  run: RunState;
  lang: Lang;
  onStop: () => Promise<unknown> | unknown;
}) {
  const stalledSince = run.status === 'running' ? run.stalledSince : null;
  const [now, setNow] = useState(() => Date.now());
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    if (stalledSince == null) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, [stalledSince]);

  useEffect(() => {
    if (stalledSince == null) setStopping(false);
  }, [stalledSince]);

  if (stalledSince == null) return null;

  const minutes = stallMinutes(stalledSince, now);
  const tool = run.activeTool;

  return (
    <div className="stall-strip" data-testid="next-stall-strip" role="status">
      <StatusIcon status="stuck" size={14} lang={lang} aria-hidden="true" />
      <span className="stall-strip-text">
        <b>{t(lang, 'stall_title', { n: minutes })}</b>
        {tool ? (
          <span className="stall-strip-tool" data-testid="next-stall-tool">
            {' · '}
            {t(lang, 'stall_running_tool')}
            {' '}
            <code>{tool.summary || tool.name}</code>
          </span>
        ) : null}
      </span>
      {run.canStop ? (
        <button
          type="button"
          className="stall-strip-stop"
          data-testid="next-stall-stop"
          disabled={stopping}
          onClick={() => {
            setStopping(true);
            void Promise.resolve(onStop()).catch(() => setStopping(false));
          }}
        >
          {t(lang, 'stall_stop')}
        </button>
      ) : null}
    </div>
  );
}
