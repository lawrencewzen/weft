import type { ReactNode } from 'react';
import type { Lang } from '../data/lang';
import { getPreferredLang } from '../data/lang';
import { t } from '../i18n';
import { ArchiveIcon, type ArchiveIconProps } from './ArchiveIcon';

export type StatusIconType = 'running' | 'waiting' | 'failed' | 'stuck' | 'stopped' | 'queued' | 'done';

export type StatusTone = 'hot' | 'mid' | 'calm';

export interface StatusIconProps {
  status: StatusIconType;
  size?: number;
  title?: string;
  lang?: Lang;
  className?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
  'aria-label'?: string;
}

export function statusTone(status: StatusIconType): StatusTone {
  switch (status) {
    case 'waiting':
    case 'failed':
    case 'stuck':
      return 'hot';
    case 'running':
      return 'mid';
    case 'stopped':
    case 'queued':
    case 'done':
      return 'calm';
  }
}

export function statusToneClass(status: StatusIconType): string {
  return `is-${statusTone(status)}`;
}

export function statusIconFor(status: string | null | undefined): StatusIconType | null {
  if (!status || status === 'idle') return null;
  switch (status) {
    case 'running':
    case 'uploading':
      return 'running';
    case 'waiting':
      return 'waiting';
    case 'failed':
    case 'error':
      return 'failed';
    case 'stuck':
      return 'stuck';
    case 'stopped':
    case 'interrupted':
      return 'stopped';
    case 'queued':
      return 'queued';
    case 'done':
    case 'success':
      return 'done';
    default:
      return null;
  }
}

export function statusTitle(status: StatusIconType, lang?: Lang): string {
  const currentLang = lang ?? getPreferredLang();
  switch (status) {
    case 'running':
      return t(currentLang, 'status_running');
    case 'waiting':
      return t(currentLang, 'status_waiting');
    case 'failed':
      return t(currentLang, 'status_failed');
    case 'stuck':
      return t(currentLang, 'status_stuck');
    case 'stopped':
      return t(currentLang, 'status_stopped');
    case 'queued':
      return t(currentLang, 'status_queued');
    case 'done':
      return t(currentLang, 'status_done');
  }
}

const LINE_PROPS = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.3,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function renderStatusContent(status: StatusIconType): ReactNode {
  switch (status) {
    case 'running':
      return (
        <>
          <circle cx={8} cy={8} r={5.6} {...LINE_PROPS} opacity={0.3} />
          <path {...LINE_PROPS} d="M8 2.4a5.6 5.6 0 0 1 5.6 5.6" className="status-icon-arc" />
        </>
      );
    case 'waiting':
      return (
        <>
          <circle cx={8} cy={8} r={5.6} {...LINE_PROPS} />
          <path {...LINE_PROPS} strokeWidth={1.8} d="M5.6 8h.01M8 8h.01M10.4 8h.01" />
        </>
      );
    case 'failed':
      return (
        <>
          <circle cx={8} cy={8} r={5.6} {...LINE_PROPS} />
          <path {...LINE_PROPS} d="M8 5.1v3.4" />
          <path {...LINE_PROPS} strokeWidth={1.7} d="M8 10.8h.01" />
        </>
      );
    case 'stuck':
      return (
        <>
          <circle cx={8} cy={8} r={5.6} {...LINE_PROPS} />
          <path {...LINE_PROPS} d="M8 5v3.2l2 1.3" />
        </>
      );
    case 'stopped':
      return (
        <>
          <circle cx={8} cy={8} r={5.6} {...LINE_PROPS} />
          <path {...LINE_PROPS} d="M6.3 6.3h3.4v3.4H6.3z" />
        </>
      );
    case 'queued':
      return <circle cx={8} cy={8} r={5.6} {...LINE_PROPS} strokeDasharray="2 2.4" />;
    case 'done':
      return (
        <>
          <circle cx={8} cy={8} r={5.6} {...LINE_PROPS} />
          <path {...LINE_PROPS} d="M5.6 8.2l1.7 1.7 3.2-3.4" />
        </>
      );
  }
}

export function StatusIcon({
  status,
  size = 14,
  title,
  lang,
  className = '',
  'aria-hidden': ariaHidden,
  'aria-label': ariaLabel,
}: StatusIconProps) {
  if (!status) return null;
  const resolvedTitle = title !== undefined ? title : statusTitle(status, lang);
  const tone = statusTone(status);
  const isRunning = status === 'running';

  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={[
        'status-icon',
        `status-icon-${status}`,
        `is-${tone}`,
        tone,
        isRunning ? 'status-icon-running is-running' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      data-testid="status-icon"
      data-status={status}
      role={ariaHidden ? undefined : 'img'}
      aria-hidden={ariaHidden}
      aria-label={ariaHidden ? undefined : ariaLabel || resolvedTitle || undefined}
      fill="none"
    >
      {resolvedTitle ? <title>{resolvedTitle}</title> : null}
      {renderStatusContent(status)}
    </svg>
  );
}

export { ArchiveIcon, type ArchiveIconProps };
