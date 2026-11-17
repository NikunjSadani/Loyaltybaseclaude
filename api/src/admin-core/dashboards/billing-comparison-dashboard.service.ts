import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtPayload } from '../../common/decorators/current-user.decorator';
import { istMonthKey } from '../../common/ist-date';
import { type BillingProgressFilters, parseBillingProgressFilters } from './billing-progress';
import {
  BILLING_CACHE_MAX_ENTRIES,
  BILLING_CACHE_TTL_MS,
  BILLING_LIST_DEFAULT_PAGE_SIZE,
  BILLING_LIST_MAX_PAGE_SIZE,
  BillingProgressDashboardService,
} from './billing-progress-dashboard.service';
import {
  type BillingComparisonData,
  type BillingComparisonOptions,
  loadBillingComparison,
  publicSlowerRow,
  summarizeBillingComparison,
} from './billing-comparison';

function intParam(raw: unknown, name: string, def: number, min: number, max: number): number {
  if (raw === undefined || raw === null || raw === '') return def;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(n) || n < min) throw new BadRequestException(`\`${name}\` must be a whole number ≥ ${min}.`);
  return Math.min(n, max);
}

/**
 * Billing comparison (MTD vs last month / 3-month average to the same day) for the admin billing card.
 * Tenant scope = `user.clientId` only (identical to billing-progress); the cache key is tenant-prefixed, so
 * paging the "slower than usual" list never re-reads the month and never crosses tenants.
 */
@Injectable()
export class BillingComparisonDashboardService {
  private readonly cache = new Map<string, { at: number; data: Promise<BillingComparisonData> }>();
  /** Loader overrides (tests only: the first day-data month / retention length); production uses the defaults. */
  options: Omit<BillingComparisonOptions, 'loadBilling'> = {};

  constructor(
    private readonly prisma: PrismaService,
    /** The billing universe is read through ITS cache (same tenant + filters as the card's own request). */
    private readonly billingProgress: BillingProgressDashboardService,
  ) {}

  get cacheSize(): number {
    return this.cache.size;
  }

  private evictExpired(nowMs: number): void {
    for (const [k, v] of this.cache) if (nowMs - v.at >= BILLING_CACHE_TTL_MS) this.cache.delete(k);
  }

  private load(user: JwtPayload, f: BillingProgressFilters): Promise<BillingComparisonData> {
    const now = new Date();
    const nowMs = now.getTime();
    this.evictExpired(nowMs);
    const resolved: BillingProgressFilters = { ...f, month: f.month ?? istMonthKey(now) };
    const key = JSON.stringify([user.clientId, resolved.month, resolved.program, resolved.outletType, resolved.managerId]);
    const hit = this.cache.get(key);
    if (hit) return hit.data;
    const data = loadBillingComparison(this.prisma, user.clientId, resolved, now, {
      ...this.options,
      loadBilling: () => this.billingProgress.load(user, resolved),
    });
    data.catch(() => {
      if (this.cache.get(key)?.data === data) this.cache.delete(key);
    });
    this.cache.set(key, { at: nowMs, data });
    while (this.cache.size > BILLING_CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return data;
  }

  /** GET /v1/admin/dashboard/billing-progress/comparison */
  async summary(user: JwtPayload, rawQuery: unknown) {
    return summarizeBillingComparison(await this.load(user, parseBillingProgressFilters(rawQuery)));
  }

  /** GET /v1/admin/dashboard/billing-progress/comparison/slower-outlets */
  async slowerOutlets(user: JwtPayload, rawQuery: unknown) {
    const q = (rawQuery && typeof rawQuery === 'object' ? rawQuery : {}) as Record<string, unknown>;
    const f = parseBillingProgressFilters(q);
    const page = intParam(q.page, 'page', 1, 1, Number.MAX_SAFE_INTEGER);
    const pageSize = intParam(q.pageSize, 'pageSize', BILLING_LIST_DEFAULT_PAGE_SIZE, 1, BILLING_LIST_MAX_PAGE_SIZE);
    const rows = (await this.load(user, f)).slowerRows;
    const start = (page - 1) * pageSize;
    return { rows: rows.slice(start, start + pageSize).map(publicSlowerRow), total: rows.length, page, pageSize };
  }
}
