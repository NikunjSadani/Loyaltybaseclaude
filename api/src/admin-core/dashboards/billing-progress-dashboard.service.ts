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
const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 20;

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

  private load(user: JwtPayload, f: BillingProgressFilters): Promise<BillingProgressData> {
    const now = new Date();
    const resolved: BillingProgressFilters = { ...f, month: f.month ?? istMonthKey(now) };
    const key = JSON.stringify([user.clientId, resolved.month, resolved.program, resolved.outletType, resolved.managerId]);
    const hit = this.cache.get(key);
    if (hit && now.getTime() - hit.at < CACHE_TTL_MS) return hit.data;

    const data = loadBillingProgress(this.prisma, user.clientId, resolved, now);
    // A failed load must not be cached.
    data.catch(() => this.cache.delete(key));
    this.cache.set(key, { at: now.getTime(), data });
    if (this.cache.size > CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
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
