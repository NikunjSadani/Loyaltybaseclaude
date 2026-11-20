/**
 * Redemption report — scope, filters and the shared WHERE (used by the Excel export kind AND the on-screen summary, so
 * the two can never disagree about which orders are in range).
 *
 * TENANT SCOPE (mirrors payments-report.controller / tds-reports.controller): a CLIENT_ADMIN — and an ASSUMED Gifsy
 * operator — is always pinned to the JWT clientId (any ?clientId= is ignored). An UN-ASSUMED GIFSY_ADMIN must name the
 * client with ?clientId=: unlike the payments report there is no platform-wide mode, because the hierarchy columns
 * are each client's OWN levels (a mixed-tenant sheet would have no single header row).
 *
 * RedemptionOrder has no clientId column — the tenant is the redeeming partner's (ChannelPartner.clientId), so every
 * query filters `partner: { clientId }`.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Prisma, RedemptionStatus } from '@prisma/client';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';
import { escapeLikeLiteral } from '../../common/applies-to/applies-to.prisma';
import { istDateKey, istDayRangeFilter, istMonthKey } from '../../common/ist-date';
import { platformWide } from '../../common/tenant-scope';
import type { RedemptionReportQueryDto, RedemptionRewardType } from '../dto/redemption-report.dto';

export interface RedemptionReportParams {
  /** The ONE tenant this report reads (resolved from the JWT; never platform-wide). */
  clientId: string;
  /** Inclusive IST calendar days (YYYY-MM-DD) on "Redeemed on" (order createdAt). */
  from: string;
  to: string;
  status: RedemptionStatus | null;
  rewardType: RedemptionRewardType | null;
  zone: string | null;
  state: string | null;
}

export const REDEMPTION_CHOOSE_CLIENT_MESSAGE =
  'Choose a client first: open the client (Working in …) or add ?clientId= — this report lists one client at a time.';

/** The tenant the caller may read. Throws 400 for an un-assumed Gifsy owner with no ?clientId=. */
export function resolveRedemptionClientId(user: JwtPayload, requested: string | null | undefined): string {
  if (platformWide(user)) {
    const c = (requested ?? '').trim();
    if (!c) throw new BadRequestException(REDEMPTION_CHOOSE_CLIENT_MESSAGE);
    return c;
  }
  const own = (user?.clientId ?? '').trim();
  if (!own) throw new ForbiddenException('The redemption report needs a client.');
  return own;
}

/** Default range: the 1st of the current IST month → today (IST). */
export function defaultRedemptionRange(now: Date): { from: string; to: string } {
  return { from: `${istMonthKey(now)}-01`, to: istDateKey(now) };
}

/** A real calendar day (rejects 2026-02-31, which Date would roll into March). */
function isRealDay(day: string): boolean {
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

function clean(v: string | undefined | null): string | null {
  const t = (v ?? '').trim();
  return t ? t : null;
}

/** Validate + normalise the query into stored params (defaults filled in, tenant resolved). */
export function resolveRedemptionParams(q: RedemptionReportQueryDto, user: JwtPayload, now: Date): RedemptionReportParams {
  const clientId = resolveRedemptionClientId(user, q.clientId);
  const def = defaultRedemptionRange(now);
  const from = q.from ?? def.from;
  const to = q.to ?? def.to;
  if (!isRealDay(from)) throw new BadRequestException(`from is not a real date: ${from}`);
  if (!isRealDay(to)) throw new BadRequestException(`to is not a real date: ${to}`);
  if (from > to) throw new BadRequestException('The From date must be on or before the To date.');
  return {
    clientId,
    from,
    to,
    status: q.status ?? null,
    rewardType: q.rewardType ?? null,
    zone: clean(q.zone),
    state: clean(q.state),
  };
}

/** Ranges longer than this many IST days are prepared in the background (Downloads page). */
export const REDEMPTION_LIGHT_MAX_DAYS = 31;

/** Number of IST days in the (inclusive) range. */
export function rangeDays(p: Pick<RedemptionReportParams, 'from' | 'to'>): number {
  return Math.round((Date.parse(`${p.to}T00:00:00Z`) - Date.parse(`${p.from}T00:00:00Z`)) / 86_400_000) + 1;
}

const ci = (v: string) => ({ equals: escapeLikeLiteral(v), mode: 'insensitive' as const });

/**
 * Reward-type rule (shared with the row's "Type" column — rewardTypeOf):
 *   CASH          = redemptionMode UPI / BANK_TRANSFER
 *   E_VOUCHER     = redemptionMode GIFT_CARD, or a gift fulfilled as a DIGITAL_VOUCHER
 *   PHYSICAL_GIFT = redemptionMode PHYSICAL_GIFT not fulfilled as a digital voucher
 */
function rewardTypeWhere(t: RedemptionRewardType | null): Prisma.RedemptionOrderWhereInput {
  if (t === 'CASH') return { redemptionMode: { in: ['UPI', 'BANK_TRANSFER'] } };
  if (t === 'E_VOUCHER') {
    return { OR: [{ redemptionMode: 'GIFT_CARD' }, { redemptionMode: 'PHYSICAL_GIFT', fulfilmentChannel: 'DIGITAL_VOUCHER' }] };
  }
  if (t === 'PHYSICAL_GIFT') {
    return {
      redemptionMode: 'PHYSICAL_GIFT',
      OR: [{ fulfilmentChannel: null }, { fulfilmentChannel: { not: 'DIGITAL_VOUCHER' } }],
    };
  }
  return {};
}

/** The ONE WHERE for every redemption-report read (orders, counts, summaries, status-history pass). */
export function redemptionWhere(p: RedemptionReportParams): Prisma.RedemptionOrderWhereInput {
  const outletFilter: Prisma.OutletWhereInput = {
    deletedAt: null,
    ...(p.zone ? { zone: ci(p.zone) } : {}),
    ...(p.state ? { state: ci(p.state) } : {}),
  };
  return {
    partner: {
      clientId: p.clientId,
      ...(p.zone || p.state ? { outlets: { some: outletFilter } } : {}),
    },
    createdAt: istDayRangeFilter(p.from, p.to),
    ...(p.status ? { status: p.status } : {}),
    ...rewardTypeWhere(p.rewardType),
  };
}

/** Plain-English filter line (Downloads page + About sheet). */
export function describeRedemptionParams(p: RedemptionReportParams): string {
  const TYPE: Record<RedemptionRewardType, string> = { E_VOUCHER: 'E-vouchers', PHYSICAL_GIFT: 'Physical gifts', CASH: 'Cash / UPI' };
  return [
    `${p.from} to ${p.to}`,
    p.status ? `status ${p.status.toLowerCase()}` : 'all statuses',
    p.rewardType ? TYPE[p.rewardType] : 'all reward types',
    p.zone ? `zone ${p.zone}` : null,
    p.state ? `state ${p.state}` : null,
    p.clientId,
  ]
    .filter(Boolean)
    .join(' · ');
}
