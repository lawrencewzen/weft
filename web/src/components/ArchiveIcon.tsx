export interface ArchiveIconProps {
  size?: number;
  className?: string;
  title?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
  'aria-label'?: string;
}

export function ArchiveIcon({
  size = 14,
  className = '',
  title,
  'aria-hidden': ariaHidden,
  'aria-label': ariaLabel,
}: ArchiveIconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinejoin="round"
      className={['archive-icon', className].filter(Boolean).join(' ')}
      data-testid="archive-icon"
      role={ariaHidden ? undefined : 'img'}
      aria-hidden={ariaHidden}
      aria-label={ariaHidden ? undefined : (ariaLabel || title || undefined)}
    >
      {title ? <title>{title}</title> : null}
      <rect x={2} y={3} width={12} height={3} rx={1} />
      <path d="M3 6v6.5A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6M6.5 9h3" />
    </svg>
  );
}
