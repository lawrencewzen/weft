import { useEffect, useState } from 'react';
import { brandIconUrl, isColorBrand } from '../data/composerModel';

export { brandIconUrl, isColorBrand };

const CUBE = (
  <svg viewBox="0 0 16 16" aria-hidden="true" className="brand-icon-cube">
    <path d="M8 1.8 14 5v6L8 14.2 2 11V5L8 1.8Z" />
    <path d="M8 1.8v6.2M2 5l6 3.2L14 5" />
  </svg>
);

type Props = {
  brand?: string | null;
  size?: number;
  alt?: string;
  className?: string;
  isColor?: boolean;
};

export function BrandIcon({ brand, size = 16, alt = '', className = '', isColor }: Props) {
  const url = brandIconUrl(brand);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [url]);
  const showImg = Boolean(url) && !failed;
  const colored = isColor ?? isColorBrand(brand);

  return (
    <span
      className={`brand-icon ${colored ? 'is-color' : 'is-mono'} ${className}`.trim()}
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
