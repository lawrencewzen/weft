import type { MouseEvent } from 'react';
import { highlightFilePath } from '../data/fileSearchHighlight';

export type FileSearchResultRowProps = {
  path: string;
  query: string;
  selected?: boolean;
  active?: boolean;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  onMouseEnter?: () => void;
};

export function FileSearchResultRow({
  path,
  query,
  selected = false,
  active = false,
  onClick,
  onMouseEnter,
}: FileSearchResultRowProps) {
  const { dir, nameSpans, dirSpans } = highlightFilePath(path, query);

  return (
    <button
      type="button"
      className={`file-search-result-row${selected ? ' is-selected' : ''}${active ? ' active' : ''}`}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      data-testid="file-search-result-row"
      data-path={path}
      title={path}
    >
      <span className="file-search-result-name">
        {nameSpans.map((span, idx) => (
          span.highlight ? (
            <span key={idx} className="file-search-match">{span.text}</span>
          ) : (
            <span key={idx}>{span.text}</span>
          )
        ))}
      </span>
      {dir ? (
        <span className="file-search-result-dir" title={dir}>
          {dirSpans.map((span, idx) => (
            span.highlight ? (
              <span key={idx} className="file-search-match">{span.text}</span>
            ) : (
              <span key={idx}>{span.text}</span>
            )
          ))}
        </span>
      ) : null}
    </button>
  );
}
