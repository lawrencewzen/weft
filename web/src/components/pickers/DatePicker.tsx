import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { Lang } from '../../data/lang';
import { readUiZoom } from '../../data/uiZoom';
import {
  addDays,
  computePopupPosition,
  addMonths,
  formatMonthHeader,
  getCalendarGrid,
  getTodayDateString,
  normalizeDateString,
  parseDate,
  WEEKDAY_HEADERS,
} from './pickerUtils';

export type DatePickerProps = {
  value: string; // "YYYY-MM-DD"
  onChange: (val: string) => void;
  min?: string; // "YYYY-MM-DD"
  id?: string;
  name?: string;
  disabled?: boolean;
  isError?: boolean;
  placeholder?: string;
  testId?: string;
  lang?: Lang;
  className?: string;
};

const CALENDAR_ICON = (
  <svg
    viewBox="0 0 16 16"
    width="15"
    height="15"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="2.5" y="3.5" width="11" height="10" rx="2" />
    <path d="M5 2v2.5M11 2v2.5M2.5 6.5h11" />
  </svg>
);

const CHEVRON_LEFT = (
  <svg
    viewBox="0 0 16 16"
    width="14"
    height="14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M10 12L6 8l4-4" />
  </svg>
);

const CHEVRON_RIGHT = (
  <svg
    viewBox="0 0 16 16"
    width="14"
    height="14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M6 12l4-4-4-4" />
  </svg>
);

export function DatePicker({
  value,
  onChange,
  min,
  id,
  name,
  disabled = false,
  isError = false,
  placeholder = 'YYYY-MM-DD',
  testId,
  lang = 'zh',
  className = '',
}: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value);
  const [popupCoords, setPopupCoords] = useState<{ top: number; left: number } | null>(null);

  // Active view year & month
  const initialDate = parseDate(value) || parseDate(min || '') || {
    year: new Date().getFullYear(),
    month: new Date().getMonth() + 1,
    day: new Date().getDate(),
  };
  const [viewYear, setViewYear] = useState(initialDate.year);
  const [viewMonth, setViewMonth] = useState(initialDate.month);
  const [cursorDate, setCursorDate] = useState(value || getTodayDateString());

  const triggerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const todayStr = getTodayDateString();

  // Sync internal text with incoming value
  useEffect(() => {
    setText(value);
    const p = parseDate(value);
    if (p) {
      setViewYear(p.year);
      setViewMonth(p.month);
      setCursorDate(value);
    }
  }, [value]);

  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const zoom = readUiZoom();
    const rect = triggerRef.current.getBoundingClientRect();
    const measured = popupRef.current?.getBoundingClientRect();
    const popupW = measured && measured.width > 0 ? measured.width : 268 * zoom;
    const popupH = measured && measured.height > 0 ? measured.height : 290 * zoom;
    const next = computePopupPosition(
      rect,
      { width: popupW, height: popupH },
      { width: window.innerWidth, height: window.innerHeight },
      zoom,
    );
    setPopupCoords((prev) =>
      prev && Math.abs(prev.top - next.top) < 0.5 && Math.abs(prev.left - next.left) < 0.5 ? prev : next,
    );
  }, []);

  const openPopup = useCallback(() => {
    if (disabled) return;
    const p = parseDate(value) || {
      year: new Date().getFullYear(),
      month: new Date().getMonth() + 1,
      day: new Date().getDate(),
    };
    setViewYear(p.year);
    setViewMonth(p.month);
    setCursorDate(value || getTodayDateString());
    updatePosition();
    setOpen(true);
  }, [disabled, value, updatePosition]);

  const closePopup = useCallback(() => {
    setOpen(false);
  }, []);

  // Re-anchor with the measured popup size once it is rendered.
  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [open, viewMonth, viewYear, updatePosition]);

  const commitText = useCallback(() => {
    const rawVal = inputRef.current ? inputRef.current.value : text;
    const norm = normalizeDateString(rawVal, value, min);
    setText(norm);
    if (inputRef.current) {
      inputRef.current.value = norm;
    }
    const p = parseDate(norm);
    if (p) {
      setViewYear(p.year);
      setViewMonth(p.month);
      setCursorDate(norm);
    }
    if (norm !== value) {
      onChange(norm);
    }
  }, [text, value, min, onChange]);

  // Click outside and resize/scroll listeners
  useEffect(() => {
    if (!open) return;

    const onMouseDown = (ev: MouseEvent) => {
      const target = ev.target as Node;
      if (triggerRef.current?.contains(target) || popupRef.current?.contains(target)) {
        return;
      }
      closePopup();
      commitText();
    };

    const onReposition = () => {
      updatePosition();
    };

    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);

    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
  }, [open, commitText, updatePosition, closePopup]);

  const handleInputBlur = (e: React.FocusEvent) => {
    const nextTarget = e.relatedTarget as Node | null;
    if (triggerRef.current?.contains(nextTarget) || popupRef.current?.contains(nextTarget)) {
      return;
    }
    commitText();
  };

  const handlePrevMonth = () => {
    if (viewMonth === 1) {
      setViewYear((y) => y - 1);
      setViewMonth(12);
    } else {
      setViewMonth((m) => m - 1);
    }
  };

  const handleNextMonth = () => {
    if (viewMonth === 12) {
      setViewYear((y) => y + 1);
      setViewMonth(1);
    } else {
      setViewMonth((m) => m + 1);
    }
  };

  const handleSelectDate = (dateStr: string) => {
    if (min && dateStr < min) return;
    setText(dateStr);
    onChange(dateStr);
    closePopup();
    inputRef.current?.focus();
  };

  const handleKeyDown = (ev: ReactKeyboardEvent) => {
    if (!open) {
      if (ev.key === 'ArrowDown' || ev.key === 'Enter') {
        ev.preventDefault();
        openPopup();
      }
      return;
    }

    if (ev.key === 'Escape') {
      ev.preventDefault();
      closePopup();
      setText(value);
      if (inputRef.current) inputRef.current.value = value;
      inputRef.current?.focus();
      return;
    }

    if (ev.key === 'Enter') {
      ev.preventDefault();
      if (!min || cursorDate >= min) {
        setText(cursorDate);
        onChange(cursorDate);
        closePopup();
        inputRef.current?.focus();
      }
      return;
    }

    let nextCursor = cursorDate;
    if (ev.key === 'ArrowLeft') {
      ev.preventDefault();
      nextCursor = addDays(cursorDate, -1);
    } else if (ev.key === 'ArrowRight') {
      ev.preventDefault();
      nextCursor = addDays(cursorDate, 1);
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      nextCursor = addDays(cursorDate, -7);
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      nextCursor = addDays(cursorDate, 7);
    } else if (ev.key === 'PageUp') {
      ev.preventDefault();
      nextCursor = addMonths(cursorDate, -1);
    } else if (ev.key === 'PageDown') {
      ev.preventDefault();
      nextCursor = addMonths(cursorDate, 1);
    }

    if (nextCursor !== cursorDate) {
      setCursorDate(nextCursor);
      const p = parseDate(nextCursor);
      if (p) {
        setViewYear(p.year);
        setViewMonth(p.month);
      }
    }
  };

  const calendarGrid = getCalendarGrid(viewYear, viewMonth);
  const weekdayLabels = WEEKDAY_HEADERS[lang] || WEEKDAY_HEADERS.zh;

  return (
    <div
      ref={triggerRef}
      className={`picker-trigger date-picker-trigger${open ? ' is-open' : ''}${isError ? ' is-error' : ''}${disabled ? ' is-disabled' : ''} ${className}`}
      onKeyDown={handleKeyDown}
    >
      <input
        ref={inputRef}
        id={id}
        name={name}
        type="text"
        className="picker-input date-picker-input"
        data-testid={testId}
        disabled={disabled}
        placeholder={placeholder}
        value={text}
        onClick={openPopup}
        onChange={(e) => setText(e.target.value)}
        onBlur={handleInputBlur}
      />
      <button
        type="button"
        className="picker-icon-btn date-picker-icon-btn"
        data-testid={testId ? `${testId}-btn` : undefined}
        tabIndex={-1}
        disabled={disabled}
        aria-label={lang === 'en' ? 'Select date' : '选择日期'}
        onClick={() => {
          if (open) closePopup();
          else openPopup();
        }}
      >
        {CALENDAR_ICON}
      </button>

      {open && popupCoords
        ? createPortal(
            <div
              ref={popupRef}
              className="picker-popup date-picker-popup"
              data-testid={testId ? `${testId}-popup` : 'next-date-picker-popup'}
              style={{ top: `${popupCoords.top}px`, left: `${popupCoords.left}px` }}
            >
              <div className="date-picker-header">
                <button
                  type="button"
                  className="date-picker-nav-btn"
                  data-testid="date-picker-prev-month"
                  aria-label={lang === 'en' ? 'Previous month' : '上个月'}
                  onClick={handlePrevMonth}
                >
                  {CHEVRON_LEFT}
                </button>
                <span className="date-picker-title" data-testid="date-picker-header-title">
                  {formatMonthHeader(viewYear, viewMonth, lang)}
                </span>
                <button
                  type="button"
                  className="date-picker-nav-btn"
                  data-testid="date-picker-next-month"
                  aria-label={lang === 'en' ? 'Next month' : '下个月'}
                  onClick={handleNextMonth}
                >
                  {CHEVRON_RIGHT}
                </button>
              </div>

              <div className="date-picker-weekdays" aria-hidden="true">
                {weekdayLabels.map((w, idx) => (
                  <div key={idx} className="date-picker-weekday">
                    {w}
                  </div>
                ))}
              </div>

              <div className="date-picker-grid" role="grid">
                {calendarGrid.map((cell) => {
                  const isSelected = cell.dateStr === value;
                  const isToday = cell.dateStr === todayStr;
                  const isCursor = cell.dateStr === cursorDate;
                  const isDisabled = Boolean(min && cell.dateStr < min);

                  return (
                    <button
                      key={cell.dateStr}
                      type="button"
                      disabled={isDisabled}
                      className={`date-picker-cell${!cell.isCurrentMonth ? ' is-other-month' : ''}${isToday ? ' is-today' : ''}${isSelected ? ' is-selected' : ''}${isCursor && !isSelected ? ' is-cursor' : ''}${isDisabled ? ' is-disabled' : ''}`}
                      data-testid={`date-picker-cell-${cell.dateStr}`}
                      onClick={() => handleSelectDate(cell.dateStr)}
                    >
                      {cell.day}
                    </button>
                  );
                })}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
