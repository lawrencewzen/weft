import type { ThinkingLevel } from '../data/composerModel';

const RANK: Record<ThinkingLevel, number> = {
  off: 0,
  minimal: 1,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 4,
};

type Props = {
  level: ThinkingLevel | null | undefined;
  size?: number;
  className?: string;
};

export function GaugeIcon({ level, size = 16, className = '' }: Props) {
  const r = level ? (RANK[level] ?? 0) : 0;
  const a = Math.PI * (1 - r / 4);
  const cx = 8;
  const cy = 11;
  const len = 4.8;
  const x = (cx + Math.cos(a) * len).toFixed(2);
  const y = (cy - Math.sin(a) * len).toFixed(2);

  return (
    <svg
      className={`gauge-icon ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.2 11a5.8 5.8 0 0 1 11.6 0" opacity="0.55" />
      <path d={`M${cx} ${cy}L${x} ${y}`} strokeWidth="1.6" />
      <circle cx={cx} cy={cy} r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}
