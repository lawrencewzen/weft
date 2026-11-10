import { t } from '../../i18n';
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
import { computePopupPosition, formatTime, normalizeTimeString, parseTime } from './pickerUtils';

export type TimePickerProps = {
  value: string; // "HH:MM"
  onChange: (val: string) => void;
  id?: string;
  name?: string;
  disabled?: boolean;
  isError?: boolean;
  placeholder?: string;
  testId?: string;
  lang?: Lang;
  className?: string;
};

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);
const ITEM_HEIGHT = 28;
const COLUMN_HEIGHT = 192;

const CLOCK_ICON = (
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
    <circle cx="8" cy="8" r="6" />
    <path d="M8 4.5v3.8l2.5 1.5" />
  </svg>
);

export function TimePicker({
  value,
  onChange,
  id,
  name,
  disabled = false,
  isError = false,
  placeholder = 'HH:MM',
  testId,
  lang = 'zh',
  className = '',
}: TimePickerProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value);
  const [activeCol, setActiveCol] = useState<'hour' | 'minute'>('hour');
  const [popupCoords, setPopupCoords] = useState<{ top: number; left: number } | null>(null);

  const parsed = parseTime(value) || { hour: 9, minute: 0 };
  const [selectedHour, setSelectedHour] = useState(parsed.hour);
  const [selectedMinute, setSelectedMinute] = useState(parsed.minute);

  const triggerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const hourColRef = useRef<HTMLDivElement>(null);
  const minColRef = useRef<HTMLDivElement>(null);

  // Sync internal text and selected time with incoming value
  useEffect(() => {
    setText(value);
    const p = parseTime(value);
    if (p) {
      setSelectedHour(p.hour);
      setSelectedMinute(p.minute);
    }
  }, [value]);

  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const zoom = readUiZoom();
    const rect = triggerRef.current.getBoundingClientRect();
    const measured = popupRef.current?.getBoundingClientRect();
    const popupW = measured && measured.width > 0 ? measured.width : 150 * zoom;
    const popupH = measured && measured.height > 0 ? measured.height : 206 * zoom;
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
    const p = parseTime(value);
    if (p) {
      setSelectedHour(p.hour);
      setSelectedMinute(p.minute);
    }
    updatePosition();
    setActiveCol('hour');
    setOpen(true);
  }, [disabled, value, updatePosition]);

  const closePopup = useCallback(() => {
    setOpen(false);
  }, []);

  // Center selected items in scroll containers when opened
  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();

    const centerItem = (col: HTMLDivElement | null, index: number) => {
      if (!col) return;
      // Column layout: 2px padding, 28px items, 2px gap (CSS px, zoom-independent).
      const viewH = col.clientHeight || COLUMN_HEIGHT;
      const itemTop = 2 + index * (ITEM_HEIGHT + 2);
      col.scrollTop = Math.max(0, itemTop - viewH / 2 + ITEM_HEIGHT / 2);
    };
    centerItem(hourColRef.current, selectedHour);
    centerItem(minColRef.current, Math.max(0, MINUTES.indexOf(selectedMinute - (selectedMinute % 5))));
  // Only re-center when the popup opens, not on every selection change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, updatePosition]);

  const commitText = useCallback(() => {
    const rawVal = inputRef.current ? inputRef.current.value : text;
    const norm = normalizeTimeString(rawVal, value);
    setText(norm);
    if (inputRef.current) {
      inputRef.current.value = norm;
    }
    const p = parseTime(norm);
    if (p) {
      setSelectedHour(p.hour);
      setSelectedMinute(p.minute);
    }
    if (norm !== value) {
      onChange(norm);
    }
  }, [text, value, onChange]);

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

  const handleSelectHour = (h: number) => {
    setSelectedHour(h);
    const newTime = formatTime(h, selectedMinute);
    setText(newTime);
    if (inputRef.current) inputRef.current.value = newTime;
    onChange(newTime);
    // Hour click only updates hour, popup stays open
  };

  const handleSelectMinute = (m: number) => {
    setSelectedMinute(m);
    const newTime = formatTime(selectedHour, m);
    setText(newTime);
    if (inputRef.current) inputRef.current.value = newTime;
    onChange(newTime);
    // Minute click commits and closes popup
    closePopup();
    inputRef.current?.focus();
  };

  // Keyboard navigation when popup is open
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
      commitText();
      closePopup();
      inputRef.current?.focus();
      return;
    }

    if (ev.key === 'ArrowLeft') {
      ev.preventDefault();
      setActiveCol('hour');
      return;
    }

    if (ev.key === 'ArrowRight') {
      ev.preventDefault();
      setActiveCol('minute');
      return;
    }

    if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (activeCol === 'hour') {
        const delta = ev.key === 'ArrowDown' ? 1 : -1;
        const nextH = (selectedHour + delta + 24) % 24;
        setSelectedHour(nextH);
        const newTime = formatTime(nextH, selectedMinute);
        setText(newTime);
        if (inputRef.current) inputRef.current.value = newTime;
        onChange(newTime);
      } else {
        let idx = MINUTES.indexOf(selectedMinute);
        if (idx === -1) {
          idx = Math.min(11, Math.max(0, Math.round(selectedMinute / 5)));
        }
        const delta = ev.key === 'ArrowDown' ? 1 : -1;
        const nextIdx = Math.min(11, Math.max(0, idx + delta));
        const nextM = MINUTES[nextIdx];
        setSelectedMinute(nextM);
        const newTime = formatTime(selectedHour, nextM);
        setText(newTime);
        if (inputRef.current) inputRef.current.value = newTime;
        onChange(newTime);
      }
    }
  };

  return (
    <div
      ref={triggerRef}
      className={`picker-trigger time-picker-trigger${open ? ' is-open' : ''}${isError ? ' is-error' : ''}${disabled ? ' is-disabled' : ''} ${className}`}
      onKeyDown={handleKeyDown}
    >
      <input
        ref={inputRef}
        id={id}
        name={name}
        type="text"
        className="picker-input time-picker-input"
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
        className="picker-icon-btn time-picker-icon-btn"
        data-testid={testId ? `${testId}-btn` : undefined}
        tabIndex={-1}
        disabled={disabled}
        aria-label={t(lang, 'sched_pick_time')}
        onClick={() => {
          if (open) closePopup();
          else openPopup();
        }}
      >
        {CLOCK_ICON}
      </button>

      {open && popupCoords
        ? createPortal(
            <div
              ref={popupRef}
              className="picker-popup time-picker-popup"
              data-testid={testId ? `${testId}-popup` : 'next-time-picker-popup'}
              style={{ top: `${popupCoords.top}px`, left: `${popupCoords.left}px` }}
            >
              <div className="time-picker-columns">
                <div
                  ref={hourColRef}
                  className={`time-picker-column time-picker-col-hours${activeCol === 'hour' ? ' is-active-col' : ''}`}
                  data-testid="time-picker-hours-col"
                >
                  {HOURS.map((h) => {
                    const isSelected = h === selectedHour;
                    const label = String(h).padStart(2, '0');
                    return (
                      <button
                        key={h}
                        type="button"
                        className={`time-picker-item${isSelected ? ' is-selected' : ''}${activeCol === 'hour' && isSelected ? ' is-cursor' : ''}`}
                        data-testid={testId ? `${testId}-hour-${label}` : `time-hour-${label}`}
                        onClick={() => handleSelectHour(h)}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                <div
                  ref={minColRef}
                  className={`time-picker-column time-picker-col-minutes${activeCol === 'minute' ? ' is-active-col' : ''}`}
                  data-testid="time-picker-minutes-col"
                >
                  {MINUTES.map((m) => {
                    // Only selected if divisible by 5 and equals selectedMinute
                    const isSelected = selectedMinute % 5 === 0 && m === selectedMinute;
                    const label = String(m).padStart(2, '0');
                    return (
                      <button
                        key={m}
                        type="button"
                        className={`time-picker-item${isSelected ? ' is-selected' : ''}${activeCol === 'minute' && isSelected ? ' is-cursor' : ''}`}
                        data-testid={testId ? `${testId}-min-${label}` : `time-min-${label}`}
                        onClick={() => handleSelectMinute(m)}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
