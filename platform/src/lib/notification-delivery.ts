/**
 * notification-delivery — FE client + types for the transactional delivery-status report
 * (Wave 4). The response shapes here are the SINGLE definition of the FE↔BE contract: they
 * mirror the backend `NotificationDeliveryReportService` return shapes EXACTLY. If the BE
 * changes a shape, change it HERE (and the page/tests break loudly) — never let the two drift
 * (the "C2" class of bug came from two agents inventing divergent contracts).
 *
 * The api-client returns the global TransformInterceptor envelope `{ success, data }` verbatim —
 * do NOT double-unwrap: read `res.data` as the payload directly.
 *
 * SCOPING is enforced entirely by the backend (tenantScope from the JWT). The FE sends NO
 * clientId — a CLIENT_ADMIN sees only their tenant, a GIFSY_ADMIN sees all (or the assumed
 * tenant). The FE just renders whatever scoped payload it gets.
 */

import { api, authHeader, type ApiResponse } from '@/lib/api-client';
import { downloadBlob } from '@/lib/download';

export type DeliveryChannel = 'SMS' | 'WHATSAPP';

/** SMS funnel (SMS never reports READ). Counts are cumulative: sent ⊇ delivered. */
export interface SmsFunnel {
  sent: number;
  delivered: number;
  failed: number;
  pending: number;
  deliveryRate: number | null;
}

/** WhatsApp funnel (adds READ). Counts are cumulative: sent ⊇ delivered ⊇ read. */
export interface WhatsappFunnel {
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  pending: number;
  deliveryRate: number | null;
}

/** OTP tile (aggregate). `indicative` = tenant-scoped undercount caveat (redemption OTPs only). */
export interface OtpTile {
  sent: number;
  delivered: number;
  failed: number;
  deliveryRate: number | null;
  indicative: boolean;
}

export interface DeliverySummary {
  sms: SmsFunnel;
  whatsapp: WhatsappFunnel;
  otp: OtpTile;
}

export interface DeliveryListItem {
  id: string;
  channel: string;
  eventKey: string | null;
  recipientPhone: string | null;
  status: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failureReason: string | null;
  createdAt: string | null;
}

export interface DeliveryListPage {
  items: DeliveryListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DeliveryFilters {
  /** '' = all channels. */
  channel?: DeliveryChannel | '';
  from?: string;
  to?: string;
  event?: string;
}

export const DELIVERY_PAGE_SIZE = 25;

export function emptyDeliveryFilters(): DeliveryFilters {
  return { channel: '', from: '', to: '', event: '' };
}

export function isDeliveryFiltersEmpty(f: DeliveryFilters): boolean {
  return !f.channel && !f.from && !f.to && !f.event;
}

/**
 * Build the query string shared by all three endpoints. Only non-empty filters are emitted so
 * the whitelist ValidationPipe never sees an empty param. `page`/`pageSize` are added for the list.
 */
export function buildDeliveryQuery(
  f: DeliveryFilters,
  extra?: { page?: number; pageSize?: number },
): string {
  const p = new URLSearchParams();
  if (f.channel) p.set('channel', f.channel);
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  if (f.event) p.set('event', f.event.trim());
  if (extra?.page) p.set('page', String(extra.page));
  if (extra?.pageSize) p.set('pageSize', String(extra.pageSize));
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Summary funnel + OTP tile (scoped by the BE). */
export function fetchDeliverySummary(
  f: DeliveryFilters,
): Promise<ApiResponse<DeliverySummary>> {
  return api.get<DeliverySummary>(
    `/api/admin/notification-delivery/summary${buildDeliveryQuery(f)}`,
  );
}

/** Paginated per-message receipt list (scoped by the BE). */
export function fetchDeliveryList(
  f: DeliveryFilters,
  page: number,
  pageSize: number = DELIVERY_PAGE_SIZE,
): Promise<ApiResponse<DeliveryListPage>> {
  return api.get<DeliveryListPage>(
    `/api/admin/notification-delivery${buildDeliveryQuery(f, { page, pageSize })}`,
  );
}

/**
 * Download the xlsx export. Uses raw fetch (NOT api.get — api.get parses JSON and would corrupt
 * the binary body), reads the filename from Content-Disposition, then downloadBlob. Throws on a
 * non-OK response so the caller can surface an error.
 */
export async function downloadDeliveryExport(f: DeliveryFilters): Promise<void> {
  const res = await fetch(
    `/api/admin/notification-delivery/export${buildDeliveryQuery(f)}`,
    { headers: authHeader() },
  );
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      msg = j.error ?? msg;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg);
  }
  const cd = res.headers.get('Content-Disposition') ?? '';
  const match = cd.match(/filename="?([^"]+)"?/);
  const filename =
    match?.[1] ?? `notification-delivery-${new Date().toISOString().slice(0, 10)}.xlsx`;
  const blob = await res.blob();
  downloadBlob(blob, filename);
}

// ── pure display helpers ──────────────────────────────────────────────────

/** Format a [0,1] rate as a whole-percent string; a null rate (no terminal outcome) shows as —. */
export function formatRate(r: number | null): string {
  return r == null ? '—' : `${Math.round(r * 100)}%`;
}

export function channelLabel(c: string): string {
  switch (c) {
    case 'SMS':
      return 'SMS';
    case 'WHATSAPP':
      return 'WhatsApp';
    default:
      return c;
  }
}

/** Title-case a receipt status (QUEUED/SENT/DELIVERED/READ/FAILED). */
export function statusLabel(s: string): string {
  if (!s) return '';
  return s.charAt(0) + s.slice(1).toLowerCase();
}

/** Tailwind classes for a status pill. */
export function statusPillClass(s: string): string {
  switch (s) {
    case 'DELIVERED':
    case 'READ':
      return 'bg-green-100 text-green-700';
    case 'SENT':
      return 'bg-blue-100 text-blue-700';
    case 'FAILED':
      return 'bg-red-100 text-red-700';
    default: // QUEUED
      return 'bg-gray-100 text-gray-600';
  }
}
