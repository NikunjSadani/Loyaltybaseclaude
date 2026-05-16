import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// ─── Tailwind class merger ────────────────────────────────────────────────────

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

// ─── Currency / Points formatters ─────────────────────────────────────────────

/**
 * Format an amount stored in paise (1/100th of INR) as ₹XX,XXX.XX
 */
export function formatCurrency(paise: number): string {
  const rupees = paise / 100;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(rupees);
}

/**
 * Format a points integer with locale-aware commas.
 */
export function formatPoints(points: number): string {
  return new Intl.NumberFormat('en-IN').format(points);
}

// ─── Date formatters ─────────────────────────────────────────────────────────

/**
 * Format a date as DD-MM-YYYY (e.g. 16-05-2026).
 */
export function formatDate(date: string | Date): string {
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}-${month}-${year}`;
}

/**
 * Format a date with time for display.
 */
export function formatDateTime(date: string | Date): string {
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(date));
}

// ─── OTP ──────────────────────────────────────────────────────────────────────

/**
 * Generate a random 6-digit OTP code.
 */
export function generateOTPCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ─── Pagination ───────────────────────────────────────────────────────────────

export interface PaginationResult {
  skip: number;
  take: number;
}

/**
 * Convert page/limit to Prisma skip/take values.
 */
export function paginate(page: number, limit: number): PaginationResult {
  const safePage = Math.max(1, Math.floor(page));
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 200);
  return { skip: (safePage - 1) * safeLimit, take: safeLimit };
}

// ─── Holding Period ───────────────────────────────────────────────────────────

/**
 * Calculate the date on which locked points become redeemable.
 */
export function calculateHoldingPeriodEnd(
  creditDate: Date,
  holdingDays: number
): Date {
  const end = new Date(creditDate);
  end.setDate(end.getDate() + holdingDays);
  return end;
}

// ─── Geo utilities ────────────────────────────────────────────────────────────

/**
 * Haversine formula – returns true if the two coordinates are within radiusMeters of each other.
 */
export function isWithinRadius(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
  radiusMeters: number
): boolean {
  const R = 6_371_000; // Earth radius in metres
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distanceMeters = R * c;

  return distanceMeters <= radiusMeters;
}

// ─── Misc helpers ─────────────────────────────────────────────────────────────

export function maskAccountNumber(account: string): string {
  if (account.length <= 4) return account;
  return '*'.repeat(account.length - 4) + account.slice(-4);
}

/**
 * Determine the current Indian financial year string, e.g. "2025-26".
 */
export function currentFinancialYear(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 1-indexed
  const fyStart = month >= 4 ? year : year - 1;
  return `${fyStart}-${String(fyStart + 1).slice(2)}`;
}
