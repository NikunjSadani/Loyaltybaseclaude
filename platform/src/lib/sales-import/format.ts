/**
 * Sales Import — display helpers (plain-English warning text, status chips, number formatting). Pure; no Date
 * reads at module scope (hydration lesson #58: pages call these only after data has loaded).
 */
import { SALES_KPI_QUANTITY_DECIMALS, type MonthPreview, type SalesImportStatus, type SalesMonthWarning } from './types';

export const ACTIVE_STATUSES: readonly SalesImportStatus[] = ['QUEUED', 'PROCESSING'];

export function isActiveStatus(s: SalesImportStatus): boolean {
  return ACTIVE_STATUSES.includes(s);
}

export const STATUS_LABEL: Record<SalesImportStatus, string> = {
  UPLOADING: 'Uploading / incomplete',
  QUEUED: 'Queued',
  PROCESSING: 'Processing',
  NEEDS_MAPPING: 'Needs column mapping',
  READY: 'Ready',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

export const STATUS_CHIP: Record<SalesImportStatus, string> = {
  UPLOADING: 'bg-gray-50 text-gray-600 border-gray-200',
  QUEUED: 'bg-blue-50 text-blue-700 border-blue-200',
  PROCESSING: 'bg-blue-50 text-blue-700 border-blue-200',
  NEEDS_MAPPING: 'bg-amber-50 text-amber-700 border-amber-200',
  READY: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  FAILED: 'bg-red-50 text-red-700 border-red-200',
  CANCELLED: 'bg-gray-50 text-gray-500 border-gray-200',
};

/** YYYY-MM → "May 2026" (no timezone involved: the month is a calendar key). */
export function monthLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const idx = Number(m[2]) - 1;
  return idx >= 0 && idx < 12 ? `${names[idx]} ${m[1]}` : month;
}

/** YYYY-MM-DD → "05 Oct" (calendar date, no TZ shift). */
export function dayLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${m[3]} ${names[Number(m[2]) - 1] ?? m[2]}`;
}

/** ISO timestamp → IST "09 Nov 2026, 14:05". */
export function dateTimeLabel(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * ₹ with Indian grouping: whole rupees show no decimals ("₹1,500"); anything with paise always shows two
 * ("₹1,500.50", never "₹1,500.5"). Negative values put the sign before the symbol: "−₹500".
 */
export function formatRupees(v: number): string {
  const abs = Math.abs(v);
  const paise = Math.round(abs * 100);
  const whole = paise % 100 === 0;
  const text = (paise / 100).toLocaleString('en-IN', {
    minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2,
  });
  return `${v < 0 && paise !== 0 ? '−' : ''}₹${text}`;
}

/** Drops one trailing full stop so "…: {message}. Next sentence" never renders "..". */
export function sentence(s: string | null | undefined): string {
  return String(s ?? '').trim().replace(/\.+$/, '');
}

/** Cases with up to SALES_KPI_QUANTITY_DECIMALS (3) decimals — the precision the backend stores and sends. */
export function formatCases(v: number): string {
  const text = Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: SALES_KPI_QUANTITY_DECIMALS });
  // Typographic minus, like formatRupees ("−12.5"); a value that rounds to 0 shows no sign.
  return v < 0 && /[1-9]/.test(text) ? `−${text}` : text;
}

export function formatCount(v: number): string {
  return v.toLocaleString('en-IN');
}

export function formatSigned(v: number, fmt: (n: number) => string): string {
  if (v === 0) return fmt(0);
  return v > 0 ? `+${fmt(v)}` : `−${fmt(Math.abs(v))}`;
}

/**
 * File sizes in BINARY units everywhere in Sales Import (1 KB = 1024 B, 1 MB = 1024² B — what Windows Explorer
 * shows), so "600 MB" in the limit copy, the size column and the server limit (SALES_IMPORT_MAX_FILE_BYTES = 600·1024²)
 * all agree.
 */
export function formatBytes(b: number): string {
  const KB = 1024;
  const MB = 1024 * 1024;
  if (b < KB) return `${b} B`;
  if (b < MB && Number((b / KB).toFixed(1)) < 1024) return `${(b / KB).toFixed(1)} KB`;
  return `${(b / MB).toFixed(1)} MB`;
}

export function formatKpiValue(v: number, measure: 'AMOUNT' | 'QUANTITY'): string {
  return measure === 'AMOUNT' ? formatRupees(v) : `${formatCases(v)} cases`;
}

/** Plain-English text for a month warning chip (the "why" an admin needs before applying). */
export function warningText(
  w: SalesMonthWarning,
  m: Pick<MonthPreview, 'month' | 'firstDate' | 'lastDate'> & { lastApplied?: MonthPreview['lastApplied'] },
): string {
  switch (w) {
    case 'STARTS_AFTER_FIRST':
      return `Partial month: the file starts on ${dayLabel(m.firstDate)}, not the 1st. Applying replaces ALL of ${monthLabel(m.month)} with only these dates.`;
    case 'ENDS_BEFORE_MONTH_END':
      return `Partial month: the file stops on ${dayLabel(m.lastDate)}, before the month ended. Applying replaces ALL of ${monthLabel(m.month)} with only these dates.`;
    case 'OLDER_THAN_LAST_APPLIED': {
      const theirs = m.lastApplied?.lastInvoiceDate;
      return `Older data: this file's sales for ${monthLabel(m.month)} stop on ${dayLabel(m.lastDate)}` +
        (theirs ? `, but the file applied last time goes up to ${dayLabel(theirs)}` : ', earlier than the file applied last time') +
        '. Applying it would roll the month back and replace the newer numbers with older ones.';
    }
    case 'REPLACES_MANUAL_VALUES':
      return 'Some outlets have values for these KPIs from the manual achievement upload. Applying replaces them with the sales-file values.';
    case 'NEGATIVE_VALUES':
      return 'Some outlets come out negative (returns are bigger than sales). They are stored as-is.';
    default:
      return String(w);
  }
}

export const WARNING_SHORT: Record<SalesMonthWarning, string> = {
  STARTS_AFTER_FIRST: 'Starts after the 1st',
  ENDS_BEFORE_MONTH_END: 'Ends before month end',
  OLDER_THAN_LAST_APPLIED: 'Older data than last applied',
  REPLACES_MANUAL_VALUES: 'Replaces manual values',
  NEGATIVE_VALUES: 'Negative values',
};

export function isPartialMonth(m: Pick<MonthPreview, 'warnings'>): boolean {
  return m.warnings.includes('STARTS_AFTER_FIRST') || m.warnings.includes('ENDS_BEFORE_MONTH_END');
}

/**
 * What still blocks pressing Apply for the ticked months. Empty array = ready.
 * Mirrors the backend ApplyRequest rules (§5.1): partial months need a per-month ack; any month older than the
 * last applied import needs the single "older" ack.
 */
export function applyBlockers(
  months: MonthPreview[],
  selected: Set<string>,
  partialAcks: Set<string>,
  olderAck: boolean,
): string[] {
  const out: string[] = [];
  const picked = months.filter((m) => selected.has(m.month));
  if (picked.length === 0) out.push('Tick at least one month.');
  for (const m of picked) {
    if (!m.canApply) out.push(`${monthLabel(m.month)} cannot be applied${m.blockedReason ? `: ${sentence(m.blockedReason)}.` : '.'}`);
    if (isPartialMonth(m) && !partialAcks.has(m.month)) out.push(`Confirm the partial-month replacement for ${monthLabel(m.month)}.`);
  }
  if (picked.some((m) => m.warnings.includes('OLDER_THAN_LAST_APPLIED')) && !olderAck) {
    out.push("Confirm that you want to roll a month back to this file's older data.");
  }
  return out;
}
