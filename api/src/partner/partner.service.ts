import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { ListPartnerTargetsQueryDto } from './dto/partner.dto';
import { kpiCodeKeys, NAMES_KEY, lastNMonths } from '../targets/targets.helpers';

/**
 * Partner self-service — ported from platform/src/app/api/partner/* onto /v1.
 * Every query is tenant-scoped by clientId (from the session-bound JWT) and
 * additionally scoped to the caller's own partner/user (user.sub), preserving
 * the source routes' ownership scoping. Business logic lives here; the
 * controller is a thin HTTP adapter.
 *
 * NOTE: the source PATCH /partner/invoices/[id] route was NOT ported — it reads
 * an in-memory MOCK_VISIBILITY_INVOICES array (lib/invoice.ts), not a Prisma
 * model, so there is no real table to back it.
 */
@Injectable()
export class PartnerService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly bannerSettingKey = 'banner_config';

  /**
   * GET /v1/partner/me — the caller's own channel-partner identity (real, JWT-scoped). Replaces the
   * FE demo persona (lib/partner-session DEMO_SESSIONS) for shell/header display. Returns nulls when
   * the caller has no channel partner so the FE can fall back to the JWT user name.
   *
   * ALSO drives the partner app's points-vs-payout experience from REAL data (was the hardcoded
   * demo REWARD_TRACK). Three presence-based signals — never keyed off a single "mode" or the last
   * ledger entry, since a partner can hold BOTH points and payout in the same period:
   *   - outletType         — the partner's PRIMARY outlet's OutletType.code (for outlet-typed heroes)
   *   - hasPointsActivity  — the partner holds/held ANY points reality (wallet balance/lifetime or ledger)
   *   - hasPayoutActivity  — the partner has ANY payout reality (credit payout entries or payout txns)
   */
  async getMe(user: JwtPayload) {
    const partner = await this.prisma.channelPartner.findFirst({
      where: { userId: user.sub, clientId: user.clientId },
      select: {
        id: true,
        partnerCode: true,
        businessName: true,
        ownerName: true,
        phone: true,
        email: true,
        entityType: true,
      },
    });

    const { outletType, hasPointsActivity, hasPayoutActivity } = partner
      ? await this.resolvePartnerActivity(user.clientId, partner.id)
      : { outletType: null, hasPointsActivity: false, hasPayoutActivity: false };

    return {
      businessName: partner?.businessName ?? null,
      ownerName: partner?.ownerName ?? null,
      partnerCode: partner?.partnerCode ?? null,
      phone: partner?.phone ?? null,
      email: partner?.email ?? null,
      entityType: partner?.entityType ?? null,
      outletType,
      hasPointsActivity,
      hasPayoutActivity,
    };
  }

  /**
   * Resolve the presence-based points/payout signals for a partner (tenant-scoped).
   *
   * Queries (all scoped to clientId + this partner):
   *   - outletType: the PRIMARY outlet's OutletType.code. Primary-outlet selection matches the
   *     codebase pattern — order by isPrimary desc then createdAt asc and take the first (do NOT
   *     filter isPrimary:true, which returns empty for real outlets that never set the flag).
   *   - hasPointsActivity: the partner's Wallet has redeemablePoints > 0 OR lifetimeEarned > 0,
   *     OR any PointsLedger row exists for that wallet.
   *   - hasPayoutActivity: any CreditPayoutEntry with status PAID or PENDING for one of the
   *     partner's outlets, OR any PayoutTransaction for the partner.
   */
  private async resolvePartnerActivity(
    clientId: string,
    partnerId: string,
  ): Promise<{ outletType: string | null; hasPointsActivity: boolean; hasPayoutActivity: boolean }> {
    // Partner's outlets — outletCode (payout-entry scoping) + primary-outlet type in one query.
    // NB: CreditPayoutEntry.outletId stores the outlet CODE (not the Outlet PK) — it is a
    // bare string set from the uploaded "Outlet ID", resolved elsewhere via outletCode
    // (credits.service confirmBatch). So the credit-payout scope MUST key on outletCode.
    const outlets = await this.prisma.outlet.findMany({
      where: { clientId, partnerId, deletedAt: null },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      select: { outletCode: true, outletType: { select: { code: true } } },
    });
    const outletType = outlets[0]?.outletType?.code ?? null;
    const outletCodes = outlets.map((o) => o.outletCode);

    // Wallet reality — the partner's wallet balances + any ledger row.
    const wallet = await this.prisma.wallet.findFirst({
      where: { partnerId },
      select: { id: true, redeemablePoints: true, lifetimeEarned: true },
    });
    let hasPointsActivity =
      !!wallet && (wallet.redeemablePoints > 0 || wallet.lifetimeEarned > 0);
    if (!hasPointsActivity && wallet) {
      const ledgerRow = await this.prisma.pointsLedger.findFirst({
        where: { walletId: wallet.id },
        select: { id: true },
      });
      hasPointsActivity = !!ledgerRow;
    }

    // Payout reality — a credit payout entry against one of the partner's outlets,
    // or a payout transaction for the partner. Either presence flips the flag.
    // The status set MUST match the one surfaced by getPayouts (PENDING/PROCESSING/
    // PAID) so the payout CARD and the payout LIST can never disagree — otherwise a
    // partner with only in-flight credit payouts sees the card but an empty list.
    const [payoutEntry, payoutTxn] = await Promise.all([
      outletCodes.length
        ? this.prisma.creditPayoutEntry.findFirst({
            where: {
              clientId,
              outletId: { in: outletCodes },
              status: { in: ['PENDING', 'PROCESSING', 'PAID'] },
            },
            select: { id: true },
          })
        : Promise.resolve(null),
      // Match the LIST rail: a FAILED/REVERSED redemption is hidden from the statement,
      // so it must not flip the card on either (else card shows, list empty).
      this.prisma.payoutTransaction.findFirst({
        where: { partnerId, status: { notIn: ['FAILED', 'REVERSED'] } },
        select: { id: true },
      }),
    ]);
    const hasPayoutActivity = !!payoutEntry || !!payoutTxn;

    return { outletType, hasPointsActivity, hasPayoutActivity };
  }

  /**
   * GET /v1/partner/banners — active banner + popup config for the caller's
   * tenant. All authenticated roles may read. Reads the real ProgramSetting
   * row (banner_config); the source route's dev-only mock fallback is dropped.
   */
  async getBanners(user: JwtPayload) {
    const setting = await this.prisma.programSetting.findFirst({
      where: { clientId: user.clientId, settingKey: this.bannerSettingKey },
    });

    const config = (setting?.settingValue as {
      banners?: unknown[];
      popups?: unknown[];
    } | null) ?? { banners: [], popups: [] };

    return {
      banners: config.banners ?? [],
      popups: config.popups ?? [],
    };
  }

  /**
   * GET /v1/partner/payouts — the caller's own payout history (most recent 100).
   * Scoped to the caller's channel partner within the tenant; returns an empty
   * list when the caller has no channel partner.
   */
  async getPayouts(user: JwtPayload) {
    const partner = await this.prisma.channelPartner.findFirst({
      where: { userId: user.sub, clientId: user.clientId },
      select: { id: true },
    });
    if (!partner) return { payouts: [] };

    // The partner's outlets — credit payouts are scoped by outlet CODE (a partner may
    // own several outlets); redemption payouts are scoped by partnerId. CreditPayoutEntry
    // .outletId holds the outlet CODE (a bare string, not the Outlet PK) — see the note
    // in resolvePartnerActivity — so this MUST key on outletCode or it matches nothing.
    const outlets = await this.prisma.outlet.findMany({
      where: { clientId: user.clientId, partnerId: partner.id, deletedAt: null },
      select: { outletCode: true },
    });
    const outletCodes = outlets.map((o) => o.outletCode);

    // Two payout rails, unioned into one history the partner sees in the wallet:
    //   • redemption cash-outs → PayoutTransaction (scoped by partnerId)
    //   • credit-based payouts → CreditPayoutEntry (scoped by outletId)
    // Credit entries are surfaced from generation (PENDING/PROCESSING) through PAID
    // so the outlet sees a payout is coming, then the SAME row flips to PAID with its
    // UTR — mirroring the redemption side. FAILED/REVERSED are excluded (a transient
    // bank-reject that GLM-2 re-banks / a clawed-back award — not a payout to show).
    const [transactions, creditEntries] = await Promise.all([
      this.prisma.payoutTransaction.findMany({
        // Hide FAILED/REVERSED at the query so they don't consume the 100-cap or the
        // presence card (aligns the list rail with the credit rail + the presence probe).
        where: { partnerId: partner.id, status: { notIn: ['FAILED', 'REVERSED'] } },
        include: {
          batch: {
            select: { batchCode: true, notes: true, createdAt: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      outletCodes.length
        ? this.prisma.creditPayoutEntry.findMany({
            where: {
              clientId: user.clientId,
              outletId: { in: outletCodes },
              status: { in: ['PENDING', 'PROCESSING', 'PAID'] },
            },
            select: {
              id: true,
              period: true,
              fieldName: true,
              amountPaise: true,
              narration: true,
              status: true,
              utr: true,
              paidAt: true,
              createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
            take: 100,
          })
        : Promise.resolve(
            [] as Array<{
              id: string;
              period: string;
              fieldName: string;
              amountPaise: bigint;
              narration: string;
              status: string;
              utr: string | null;
              paidAt: Date | null;
              createdAt: Date;
            }>,
          ),
    ]);

    // Effective date = when money hit (completedAt/paidAt) else when it was added
    // (createdAt); the merged list sorts newest-first on it, then caps at 100.
    const redemptionPayouts = transactions.map((t) => ({
      id: t.id,
      period: this.toPeriod(t.completedAt ?? t.createdAt),
      kpiLabel: t.batch?.notes ?? 'Incentive Payout',
      achievedPct: 100,
      payoutAmountPaise: Number(t.netAmountPaise),
      uploadedAt: (t.batch?.createdAt ?? t.createdAt).toISOString(),
      utr: t.providerRefId ?? undefined,
      paidAt: t.completedAt?.toISOString() ?? undefined,
      status: this.mapPayoutStatus(t.status),
      narration: t.batch?.notes ?? undefined,
      _sortAt: (t.completedAt ?? t.createdAt).getTime(),
    }));

    const creditPayouts = creditEntries.map((e) => ({
      id: e.id,
      period: e.period, // already 'YYYY-MM' (the credit month) — no server-TZ derivation
      kpiLabel: e.fieldName || 'Credit Payout',
      achievedPct: 100,
      payoutAmountPaise: Number(e.amountPaise),
      uploadedAt: e.createdAt.toISOString(), // when the payout was generated/added
      utr: e.utr ?? undefined,
      paidAt: e.paidAt?.toISOString() ?? undefined,
      status: this.mapCreditEntryStatus(e.status),
      narration: e.narration || undefined,
      _sortAt: (e.paidAt ?? e.createdAt).getTime(),
    }));

    const payouts = [...redemptionPayouts, ...creditPayouts]
      .sort((a, b) => b._sortAt - a._sortAt)
      .slice(0, 100)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      .map(({ _sortAt, ...p }) => p);

    return { payouts };
  }

  /**
   * GET /v1/partner/targets — the caller's own outlets' target + achievement +
   * pace per KPI for the requested month (or the most-recent month with data).
   *
   * Rewired from SchemeTarget (P4.1 dropped scheme-scoped targets) to the real
   * per-outlet × KPI × month model:
   *   - OutletTarget.targetValues   — target side
   *   - OutletSalesRecord.kpiValues — achievement side
   *
   * Joins on (clientId, outletCode, month).  Pace = achieved ÷ target;
   * target absent or 0 → pace null (divide-by-zero guard).
   *
   * Caller scoping: the partner's outlets are looked up via ChannelPartner
   * (userId → id → Outlet[]) so only the caller's own outlets are returned.
   * Tenant scope: every query is filtered by clientId from the JWT.
   */
  async getTargets(user: JwtPayload, q: ListPartnerTargetsQueryDto) {
    // ── Resolve the caller's ChannelPartner + their outlet codes ─────────────
    const partner = await this.prisma.channelPartner.findFirst({
      where: { userId: user.sub, clientId: user.clientId },
      select: { id: true },
    });

    if (!partner) return { period: q.period ?? null, outlets: [] };

    const outlets = await this.prisma.outlet.findMany({
      where: {
        clientId: user.clientId,
        partnerId: partner.id,
        isActive: true,
        deletedAt: null,
      },
      select: { outletCode: true },
    });

    if (outlets.length === 0) return { period: q.period ?? null, outlets: [] };

    const outletCodes = outlets.map((o) => o.outletCode);

    // ── Determine the month to query ──────────────────────────────────────────
    // If the caller passes a period, use it.  Otherwise, find the most-recent
    // month for which this partner has any target data.
    let month: string | null = q.period ?? null;

    if (!month) {
      const latest = await this.prisma.outletTarget.findFirst({
        where: { clientId: user.clientId, outletCode: { in: outletCodes } },
        orderBy: { month: 'desc' },
        select: { month: true },
      });
      month = latest?.month ?? null;
    }

    if (!month) return { period: null, outlets: [] };

    const whereBase = {
      clientId: user.clientId,
      month,
      outletCode: { in: outletCodes },
    };

    // ── Fetch both sides in parallel (+ KPI labels for the name fallback) ──────
    const [targetRows, achievementRows, kpiRows] = await Promise.all([
      this.prisma.outletTarget.findMany({
        where: whereBase,
        select: { outletCode: true, outletName: true, outletType: true, targetValues: true },
      }),
      this.prisma.outletSalesRecord.findMany({
        where: whereBase,
        select: { outletCode: true, kpiValues: true },
      }),
      this.prisma.kpiDef.findMany({
        where: { clientId: user.clientId },
        select: { code: true, label: true, unit: true, isPrimary: true },
      }),
    ]);

    // KPI code → generic label (the fallback when no per-outlet override is set),
    // plus unit + primary flag so the partner dashboard hero can pick THE primary
    // KPI and label its number (e.g. "of 800 cases") from real data.
    const kpiLabel   = new Map(kpiRows.map((k) => [k.code, k.label]));
    const kpiUnit    = new Map(kpiRows.map((k) => [k.code, k.unit]));
    const kpiPrimary = new Map(kpiRows.map((k) => [k.code, k.isPrimary]));

    const targetIndex      = new Map(targetRows.map((r) => [r.outletCode, r]));
    const achievementIndex = new Map(achievementRows.map((r) => [r.outletCode, r]));

    const allOutletCodes = new Set([...targetIndex.keys(), ...achievementIndex.keys()]);

    const result = [...allOutletCodes]
      .sort()
      .map((outletCode) => {
        const tRow = targetIndex.get(outletCode);
        const aRow = achievementIndex.get(outletCode);

        const targetValues  = (tRow?.targetValues  ?? {}) as Record<string, number>;
        const kpiValues     = (aRow?.kpiValues     ?? {}) as Record<string, number>;

        // Per-outlet custom KPI display names (the "name override") live under the
        // reserved `__names` key inside targetValues — never a KPI value.
        const names = ((targetValues as Record<string, unknown>)[NAMES_KEY] ?? {}) as Record<
          string,
          string
        >;

        // Enumerate KPI codes from both sides, EXCLUDING the reserved `__names`
        // key so it can never surface as a phantom KPI row.
        const allKpiCodes = new Set([
          ...kpiCodeKeys(targetValues),
          ...kpiCodeKeys(kpiValues),
        ]);

        const kpis = [...allKpiCodes].map((code) => {
          const target  = Object.prototype.hasOwnProperty.call(targetValues, code)
            ? targetValues[code]
            : null;
          const achieved = Object.prototype.hasOwnProperty.call(kpiValues, code)
            ? kpiValues[code]
            : null;

          // Divide-by-zero guard: target absent OR target===0 → pace null
          let pace: number | null = null;
          if (target !== null && target !== 0 && achieved !== null) {
            pace = achieved / target;
          }

          // Display rule: per-outlet custom name if set, else the KPI's generic
          // label (else the raw code as a last resort).
          const name = names[code] || kpiLabel.get(code) || code;
          const unit = kpiUnit.get(code) ?? '';
          const isPrimary = kpiPrimary.get(code) ?? false;

          return { code, name, target, achieved, pace, unit, isPrimary };
        });

        return {
          outletCode,
          outletName: tRow?.outletName ?? outletCode,
          outletType: tRow?.outletType ?? '',
          kpis,
        };
      });

    return { period: month, outlets: result };
  }

  /**
   * GET /v1/partner/targets/trend — the caller's PRIMARY KPI target vs achieved
   * for each of the trailing `months` calendar months (oldest first), summed
   * across all of the partner's outlets. Powers the dashboard "Target vs.
   * Achievement" chart with REAL data (was hardcoded ₹-lakh mock).
   *
   * Same per-outlet × KPI × month model as getTargets:
   *   - OutletTarget.targetValues[code]   — target side
   *   - OutletSalesRecord.kpiValues[code] — achievement side
   * A month with no row on a side stays null (an honest gap, not a fake 0).
   */
  async getTargetTrend(
    user: JwtPayload,
    months = 24,
    kpiCode?: string,
  ): Promise<{
    kpiCode: string | null;
    kpiName: string | null;
    unit: string | null;
    trend: Array<{ month: string; target: number | null; achieved: number | null }>;
  }> {
    const span = Math.min(Math.max(Math.trunc(months) || 0, 1), 36);

    const partner = await this.prisma.channelPartner.findFirst({
      where: { userId: user.sub, clientId: user.clientId },
      select: { id: true },
    });
    if (!partner) return { kpiCode: null, kpiName: null, unit: null, trend: [] };

    const outlets = await this.prisma.outlet.findMany({
      where: { partnerId: partner.id, clientId: user.clientId },
      select: { outletCode: true },
    });
    const outletCodes = outlets.map((o) => o.outletCode);
    if (outletCodes.length === 0) return { kpiCode: null, kpiName: null, unit: null, trend: [] };

    // Pick the KPI to trend. The caller (dashboard) passes the SAME primary KPI
    // its hero headline resolved, so the chart and the hero never disagree; when
    // it's absent/unknown, fall back to the flagged primary, then the first KPI.
    const kpiDefs = await this.prisma.kpiDef.findMany({
      where: { clientId: user.clientId },
      select: { code: true, label: true, unit: true, isPrimary: true },
      orderBy: { code: 'asc' },
    });
    const primary =
      (kpiCode && kpiDefs.find((k) => k.code === kpiCode)) ||
      kpiDefs.find((k) => k.isPrimary) ||
      kpiDefs[0] ||
      null;
    if (!primary) return { kpiCode: null, kpiName: null, unit: null, trend: [] };

    const monthKeys = lastNMonths(span);
    const whereBase = {
      clientId: user.clientId,
      outletCode: { in: outletCodes },
      month: { in: monthKeys },
    };

    const [targetRows, achievementRows] = await Promise.all([
      this.prisma.outletTarget.findMany({
        where: whereBase,
        select: { month: true, targetValues: true },
      }),
      this.prisma.outletSalesRecord.findMany({
        where: whereBase,
        select: { month: true, kpiValues: true },
      }),
    ]);

    const code = primary.code;
    const targetByMonth = new Map<string, number>();
    const achievedByMonth = new Map<string, number>();
    for (const r of targetRows) {
      const v = (r.targetValues as Record<string, unknown>)?.[code];
      if (typeof v === 'number') targetByMonth.set(r.month, (targetByMonth.get(r.month) ?? 0) + v);
    }
    for (const r of achievementRows) {
      const v = (r.kpiValues as Record<string, unknown>)?.[code];
      if (typeof v === 'number') achievedByMonth.set(r.month, (achievedByMonth.get(r.month) ?? 0) + v);
    }

    const trend = monthKeys.map((m) => ({
      month: m,
      target: targetByMonth.has(m) ? targetByMonth.get(m)! : null,
      achieved: achievedByMonth.has(m) ? achievedByMonth.get(m)! : null,
    }));

    return { kpiCode: code, kpiName: primary.label, unit: primary.unit ?? '', trend };
  }

  /**
   * GET /v1/partner/sales-team — the REAL sales reps mapped to the caller's
   * outlets, for the partner Support page "Your Sales Team" card (replaces the
   * hardcoded demo personas Anil Sharma / Rajesh Kumar).
   *
   * Source of truth: active SalesUserAssignment rows tied to the partner itself
   * or any of its outlets → the assigned SalesUser(s) + each one's immediate
   * reporting manager (so the partner gets both their field rep and an
   * escalation contact, matching the "reach your ISR or Sales Officer" intent).
   * Caller-scoped (own partner only) + tenant-scoped (clientId from the JWT).
   * Inactive/deleted sales users are excluded; results are deduped.
   */
  async getSalesTeam(user: JwtPayload) {
    const partner = await this.prisma.channelPartner.findFirst({
      where: { userId: user.sub, clientId: user.clientId },
      select: { id: true },
    });
    if (!partner) return { team: [] };

    const outlets = await this.prisma.outlet.findMany({
      where: { clientId: user.clientId, partnerId: partner.id, deletedAt: null },
      select: { id: true },
    });
    const outletIds = outlets.map((o) => o.id);

    const assignments = await this.prisma.salesUserAssignment.findMany({
      where: {
        unassignedAt: null,
        salesUser: { isActive: true, deletedAt: null, clientId: user.clientId },
        OR: [
          { partnerId: partner.id },
          ...(outletIds.length ? [{ outletId: { in: outletIds } }] : []),
        ],
      },
      select: {
        salesUser: {
          select: {
            id: true,
            employeeCode: true,
            user: { select: { name: true, phone: true } },
            hierarchyLevel: { select: { name: true, level: true } },
            reportingTo: {
              select: {
                id: true,
                clientId: true,
                employeeCode: true,
                isActive: true,
                deletedAt: true,
                user: { select: { name: true, phone: true } },
                hierarchyLevel: { select: { name: true, level: true } },
              },
            },
          },
        },
      },
    });

    // Dedup by sales-user id; tier 0 = directly assigned (field rep), tier 1 =
    // their manager. A user seen at both tiers keeps the lower (more direct) tier.
    type Member = { name: string; role: string; phone: string; employeeCode: string; level: number; tier: number };
    const byId = new Map<string, Member>();
    const add = (su: any, tier: number) => {
      if (!su) return;
      const existing = byId.get(su.id);
      if (existing) { existing.tier = Math.min(existing.tier, tier); return; }
      byId.set(su.id, {
        name: su.user?.name ?? 'Unknown',
        role: su.hierarchyLevel?.name ?? '',
        phone: su.user?.phone ?? '',
        employeeCode: su.employeeCode,
        level: su.hierarchyLevel?.level ?? 0,
        tier,
      });
    };
    for (const a of assignments) {
      add(a.salesUser, 0);
      const mgr = a.salesUser?.reportingTo;
      // Defense-in-depth: a reporting chain is same-tenant by construction, but
      // assert clientId explicitly before surfacing a manager so a bad
      // cross-tenant reportingToId could never leak a foreign contact.
      if (mgr && mgr.isActive && !mgr.deletedAt && mgr.clientId === user.clientId) add(mgr, 1);
    }

    // Field reps first (tier), then by seniority within a tier, then name.
    const team = [...byId.values()]
      .sort((x, y) => x.tier - y.tier || x.level - y.level || x.name.localeCompare(y.name))
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      .map(({ tier, ...m }) => m);

    return { team };
  }

  private toPeriod(d: Date): string {
    const yr = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    return `${yr}-${mo}`;
  }

  private mapPayoutStatus(s: string): 'PAID' | 'PENDING' | 'PROCESSING' | 'FAILED' {
    // 'SUCCESS' is the actual completed value in the PayoutStatus enum (payouts.service
    // writes it on UTR upload); 'PAID'/'COMPLETED' are kept as defensive aliases. Missing
    // 'SUCCESS' here mapped every paid redemption to PENDING → shown as perpetually pending.
    if (s === 'SUCCESS' || s === 'PAID' || s === 'COMPLETED') return 'PAID';
    if (s === 'FAILED' || s === 'REVERSED') return 'FAILED';
    if (s === 'INITIATED' || s === 'PROCESSING') return 'PROCESSING';
    return 'PENDING';
  }

  // CreditEntryStatus → the wallet's 4-state payout status. FAILED/REVERSED map to
  // FAILED (though getPayouts excludes them from the surfaced set); PROCESSING is the
  // in-flight state (entry pulled into a payout download, awaiting UTR).
  private mapCreditEntryStatus(s: string): 'PAID' | 'PENDING' | 'PROCESSING' | 'FAILED' {
    if (s === 'PAID') return 'PAID';
    if (s === 'FAILED' || s === 'REVERSED') return 'FAILED';
    if (s === 'PROCESSING') return 'PROCESSING';
    return 'PENDING';
  }
}
