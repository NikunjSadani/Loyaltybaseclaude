import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { ListPartnerTargetsQueryDto } from './dto/partner.dto';
import { kpiCodeKeys, NAMES_KEY } from '../targets/targets.helpers';

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
   */
  async getMe(user: JwtPayload) {
    const partner = await this.prisma.channelPartner.findFirst({
      where: { userId: user.sub, clientId: user.clientId },
      select: {
        partnerCode: true,
        businessName: true,
        ownerName: true,
        phone: true,
        email: true,
        entityType: true,
      },
    });
    return {
      businessName: partner?.businessName ?? null,
      ownerName: partner?.ownerName ?? null,
      partnerCode: partner?.partnerCode ?? null,
      phone: partner?.phone ?? null,
      email: partner?.email ?? null,
      entityType: partner?.entityType ?? null,
    };
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

    const transactions = await this.prisma.payoutTransaction.findMany({
      where: { partnerId: partner.id },
      include: {
        batch: {
          select: { batchCode: true, notes: true, createdAt: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const payouts = transactions.map((t) => ({
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
    }));

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
    if (s === 'PAID' || s === 'COMPLETED') return 'PAID';
    if (s === 'FAILED' || s === 'REVERSED') return 'FAILED';
    if (s === 'INITIATED' || s === 'PROCESSING') return 'PROCESSING';
    return 'PENDING';
  }
}
