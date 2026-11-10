export function parseTime(str: string): { hour: number; minute: number } | null {
  if (!str) return null;
  const trimmed = str.trim();

  // 1. "HH:MM" or "H:M"
  const colonMatch = /^(\d{1,2}):(\d{1,2})$/.exec(trimmed);
  if (colonMatch) {
    const h = parseInt(colonMatch[1], 10);
    const m = parseInt(colonMatch[2], 10);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return { hour: h, minute: m };
    }
    return null;
  }

  // 2. "HHMM" or "HMM" (e.g. 0905 -> 09:05, 905 -> 09:05, 1430 -> 14:30)
  const compactMatch = /^(\d{1,2})(\d{2})$/.exec(trimmed);
  if (compactMatch) {
    const h = parseInt(compactMatch[1], 10);
    const m = parseInt(compactMatch[2], 10);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return { hour: h, minute: m };
    }
    return null;
  }

  // 3. Single or double digit hour (e.g. "9" -> 09:00, "14" -> 14:00)
  const singleHourMatch = /^(\d{1,2})$/.exec(trimmed);
  if (singleHourMatch) {
    const h = parseInt(singleHourMatch[1], 10);
    if (h >= 0 && h <= 23) {
      return { hour: h, minute: 0 };
    }
    return null;
  }

  return null;
}

export function formatTime(hour: number, minute: number): string {
  const h = String(Math.max(0, Math.min(23, hour))).padStart(2, '0');
  const m = String(Math.max(0, Math.min(59, minute))).padStart(2, '0');
  return `${h}:${m}`;
}

export function normalizeTimeString(raw: string, fallback: string): string {
  const parsed = parseTime(raw);
  if (!parsed) return fallback;
  return formatTime(parsed.hour, parsed.minute);
}

export function isValidDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = new Date(year, month, 0).getDate();
  return day <= daysInMonth;
}

export function formatDate(year: number, month: number, day: number): string {
  const y = String(year).padStart(4, '0');
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function parseDate(str: string): { year: number; month: number; day: number } | null {
  if (!str) return null;
  const trimmed = str.trim();

  // 1. "YYYY-MM-DD", "YYYY/MM/DD", "YYYY.MM.DD"
  const sepMatch = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(trimmed);
  if (sepMatch) {
    const y = parseInt(sepMatch[1], 10);
    const m = parseInt(sepMatch[2], 10);
    const d = parseInt(sepMatch[3], 10);
    if (isValidDate(y, m, d)) {
      return { year: y, month: m, day: d };
    }
    return null;
  }

  // 2. "YYYYMMDD"
  const compactMatch = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
  if (compactMatch) {
    const y = parseInt(compactMatch[1], 10);
    const m = parseInt(compactMatch[2], 10);
    const d = parseInt(compactMatch[3], 10);
    if (isValidDate(y, m, d)) {
      return { year: y, month: m, day: d };
    }
    return null;
  }

  return null;
}

export function normalizeDateString(raw: string, fallback: string, min?: string): string {
  const parsed = parseDate(raw);
  if (!parsed) return fallback;
  const formatted = formatDate(parsed.year, parsed.month, parsed.day);
  if (min && formatted < min) return fallback;
  return formatted;
}

export function getTodayDateString(): string {
  const d = new Date();
  return formatDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

export type CalendarCell = {
  year: number;
  month: number;
  day: number;
  dateStr: string;
  isCurrentMonth: boolean;
};

export function getCalendarGrid(year: number, month: number): CalendarCell[] {
  const firstDay = new Date(year, month - 1, 1).getDay(); // 0: Sun, 1: Mon...
  const leadingDays = (firstDay + 6) % 7; // Monday-based: Mon=0, Tue=1, ..., Sun=6

  const daysInCurrentMonth = new Date(year, month, 0).getDate();
  const daysInPrevMonth = new Date(year, month - 1, 0).getDate();

  const cells: CalendarCell[] = [];

  // Prev month leading days
  for (let i = leadingDays - 1; i >= 0; i--) {
    const d = daysInPrevMonth - i;
    const prevMonthDate = new Date(year, month - 2, d);
    const y = prevMonthDate.getFullYear();
    const m = prevMonthDate.getMonth() + 1;
    cells.push({
      year: y,
      month: m,
      day: d,
      dateStr: formatDate(y, m, d),
      isCurrentMonth: false,
    });
  }

  // Current month days
  for (let d = 1; d <= daysInCurrentMonth; d++) {
    cells.push({
      year,
      month,
      day: d,
      dateStr: formatDate(year, month, d),
      isCurrentMonth: true,
    });
  }

  // Trailing days of next month to complete 35 or 42 cells
  const totalCells = cells.length > 35 ? 42 : 35;
  const trailingDays = totalCells - cells.length;
  for (let d = 1; d <= trailingDays; d++) {
    const nextMonthDate = new Date(year, month, d);
    const y = nextMonthDate.getFullYear();
    const m = nextMonthDate.getMonth() + 1;
    cells.push({
      year: y,
      month: m,
      day: d,
      dateStr: formatDate(y, m, d),
      isCurrentMonth: false,
    });
  }

  return cells;
}

const EN_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function formatMonthHeader(year: number, month: number, lang: 'zh' | 'en'): string {
  if (lang === 'en') {
    return `${EN_MONTHS[month - 1] || ''} ${year}`;
  }
  return `${year}年${month}月`;
}

export const WEEKDAY_HEADERS: Record<'zh' | 'en', string[]> = {
  zh: ['一', '二', '三', '四', '五', '六', '日'],
  en: ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'],
};

export function addDays(dateStr: string, deltaDays: number): string {
  const p = parseDate(dateStr);
  if (!p) return dateStr;
  const d = new Date(p.year, p.month - 1, p.day + deltaDays);
  return formatDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

export function addMonths(dateStr: string, deltaMonths: number): string {
  const p = parseDate(dateStr);
  if (!p) return dateStr;
  const d = new Date(p.year, p.month - 1 + deltaMonths, p.day);
  return formatDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
}
