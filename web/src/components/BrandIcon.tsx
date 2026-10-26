import { useEffect, useState } from 'react';

const CUBE = (
  <svg viewBox="0 0 16 16" aria-hidden="true" className="brand-icon-cube">
    <path d="M8 1.8 14 5v6L8 14.2 2 11V5L8 1.8Z" />
    <path d="M8 1.8v6.2M2 5l6 3.2L14 5" />
  </svg>
);

export function brandIconUrl(brand: string | null | undefined): string | null {
  const id = String(brand || '').trim();
  if (!id) return null;
  return `/vendor/brand-icons/${id.toLowerCase()}.svg`;
}

type Props = {
  brand?: string | null;
  size?: number;
  alt?: string;
  className?: string;
};

export function BrandIcon({ brand, size = 16, alt = '', className = '' }: Props) {
  const url = brandIconUrl(brand);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [url]);
  const showImg = Boolean(url) && !failed;

  return (
    <span
      className={`brand-icon ${className}`.trim()}
      style={{ width: size, height: size }}
      title={alt || undefined}
    >
      {showImg ? (
        <img
          src={url!}
          alt=""
          width={size}
          height={size}
          onError={() => setFailed(true)}
        />
      ) : CUBE}
    </span>
  );
}
