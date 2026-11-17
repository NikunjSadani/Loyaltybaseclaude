import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtPayload } from '../../common/decorators/current-user.decorator';
import { istMonthKey } from '../../common/ist-date';
import {
  BillingProgressData,
  BillingProgressFilters,
  loadBillingProgress,
  parseBillingListKey,
  parseBillingProgressFilters,
  publicBillingRow,
  selectBillingRows,
  summarizeBillingProgress,
} from './billing-progress';

export const BILLING_LIST_DEFAULT_PAGE_SIZE = 50;
export const BILLING_LIST_MAX_PAGE_SIZE = 200;
/** Paging through one tile's list re-uses the computed month for this long (no re-scan per page). */
export const BILLING_CACHE_TTL_MS = 30_000;
/** Hard cap — each entry holds a whole month's per-outlet rows (≈6.5k at Bajaj). */
export const BILLING_CACHE_MAX_ENTRIES = 10;

function intParam(raw: unknown, name: string, def: number, min: number, max: number): number {
  if (raw === undefined || raw === null || raw === '') return def;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(n) || n < min) throw new BadRequestException(`\`${name}\` must be a whole number ≥ ${min}.`);
  return Math.min(n, max);
}

/**
 * Billing progress (primary-KPI target achievement, bucketed) for the admin dashboard.
 * Tenant scope = `user.clientId` only (the assumed tenant for a Gifsy operator) — identical to every
 * other admin dashboard; the cache key is tenant-prefixed so one tenant never sees another's rows.
 */
@Injectable()
export class BillingProgressDashboardService {
  private readonly cache = new Map<string, { at: number; data: Promise<BillingProgressData> }>();

  constructor(private readonly prisma: PrismaService) {}

  /** Entries currently held (tests / diagnostics). */
  get cacheSize(): number {
    return this.cache.size;
  }

  /** Drop every expired entry (run on every read and write, so stale months never pile up in memory). */
  private evictExpired(nowMs: number): void {
    for (const [k, v] of this.cache) if (nowMs - v.at >= BILLING_CACHE_TTL_MS) this.cache.delete(k);
  }

  /** The (cached, tenant + filter keyed) month — also reused by BillingComparisonDashboardService (no second load). */
  load(user: JwtPayload, f: BillingProgressFilters): Promise<BillingProgressData> {
    const now = new Date();
    const nowMs = now.getTime();
    this.evictExpired(nowMs);
    const resolved: BillingProgressFilters = { ...f, month: f.month ?? istMonthKey(now) };
    // Key = tenant + EVERY filter (one tenant never sees another's rows; one filter set never another's).
    const key = JSON.stringify([user.clientId, resolved.month, resolved.program, resolved.outletType, resolved.managerId]);
    const hit = this.cache.get(key);
    if (hit) return hit.data;

    const data = loadBillingProgress(this.prisma, user.clientId, resolved, now);
    // A failed load must not be cached (only remove OUR entry — a newer one may have replaced it).
    data.catch(() => {
      if (this.cache.get(key)?.data === data) this.cache.delete(key);
    });
    this.cache.set(key, { at: nowMs, data });
    // Cap: evict oldest-inserted first (Map iteration order) until within the limit.
    while (this.cache.size > BILLING_CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return data;
  }

  /** GET /v1/admin/dashboard/billing-progress */
  async summary(user: JwtPayload, rawQuery: unknown) {
    const f = parseBillingProgressFilters(rawQuery);
    return summarizeBillingProgress(await this.load(user, f));
  }

  /** GET /v1/admin/dashboard/billing-progress/outlets */
  async outlets(user: JwtPayload, rawQuery: unknown) {
    const q = (rawQuery && typeof rawQuery === 'object' ? rawQuery : {}) as Record<string, unknown>;
    const f = parseBillingProgressFilters(q);
    const key = parseBillingListKey(q.bucket);
    const page = intParam(q.page, 'page', 1, 1, Number.MAX_SAFE_INTEGER);
    const pageSize = intParam(q.pageSize, 'pageSize', BILLING_LIST_DEFAULT_PAGE_SIZE, 1, BILLING_LIST_MAX_PAGE_SIZE);
    const rows = selectBillingRows(await this.load(user, f), key);
    const start = (page - 1) * pageSize;
    return {
      rows: rows.slice(start, start + pageSize).map(publicBillingRow),
      total: rows.length,
      page,
      pageSize,
    };
  }
}
