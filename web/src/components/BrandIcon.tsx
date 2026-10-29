import { useEffect, useState } from 'react';
import { brandIconUrl, isColorBrand } from '../data/composerModel';

export { brandIconUrl, isColorBrand };

const PLUG = (
  <svg
    viewBox="0 0 16 16"
    aria-hidden="true"
    className="brand-icon-plug brand-icon-cube"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.3"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M6 2v3.5M10 2v3.5" />
    <path d="M4.5 5.5h7v3a3.5 3.5 0 0 1-7 0Z" />
    <path d="M8 12v2.5" />
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
      ) : PLUG}
    </span>
  );
}
