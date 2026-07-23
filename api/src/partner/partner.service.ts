import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { ListPartnerTargetsQueryDto } from './dto/partner.dto';
import { kpiCodeKeys, NAMES_KEY, lastNMonths } from '../targets/targets.helpers';
import { buildPayoutStatement } from '../common/payout-statement.helper';
import { TenantService } from '../tenant/tenant.service';
import { resolveTenantFeatures } from '../common/tenant-features.helper';
import {
  resolveActivePartnerId,
  resolveOperableContexts,
} from '../common/partner-group.helper';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantService,
  ) {}

  private readonly bannerSettingKey = 'banner_config';

  /**
   * Wave 3 login-picker ACCESS BOUNDARY. Resolves the ChannelPartner a request may ACT ON from the
   * optional client-supplied `x-active-partner-id` selector (threaded here as `requestedPartnerId`).
   *
   * SECURITY INVARIANT: NEVER trust the header. `resolveActivePartnerId` re-authorizes it — absent /
   * empty / own selector → the login's OWN partner (today's single-outlet behaviour, one query, no
   * switch); a selector naming a valid login-less same-group same-phone sibling → that sibling;
   * anything else → forbidden. A missed site would let a forged header reach another partner's data.
   *
   * Returns `null` when the login has no partner at all (e.g. a parent-only phone) — callers treat
   * that as "no operable outlet" and return today's empty/no-partner response.
   */
  private async resolveActivePartner(
    user: JwtPayload,
    requestedPartnerId?: string,
  ): Promise<string | null> {
    const { partnerId, forbidden } = await resolveActivePartnerId(this.prisma, {
      clientId: user.clientId,
      userSub: user.sub,
      phone: user.phone,
      requestedPartnerId,
    });
    if (forbidden) throw new ForbiddenException('You cannot act on that outlet.');
    return partnerId;
  }

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
  async getMe(user: JwtPayload, requestedPartnerId?: string) {
    // Wave 3 login-picker payload — everything THIS LOGIN may operate (own + login-less same-group
    // same-phone siblings) + read-only group-overview availability. Always keyed off the login itself
    // (user.sub / user.phone), independent of the selected active outlet, so the picker list is stable.
    // ownPartnerId is derived from the login → ALWAYS safe; we resolve it FIRST and use it as the
    // degrade target below.
    const { ownPartnerId, operable, groupParent } = await resolveOperableContexts(this.prisma, {
      clientId: user.clientId,
      userSub: user.sub,
      phone: user.phone,
    });

    // The DISPLAYED identity reflects the ACTIVE outlet — own by default, or the switched-to sibling
    // when a valid selector is supplied. AUDIT FIX (HIGH): getMe drives the ENTIRE partner shell, so a
    // stale/foreign selector (e.g. a shared-device cookie) must NOT 403 the whole portal. Unlike the
    // money/read endpoints (which stay fail-closed via `resolveActivePartner`), the identity/shell
    // endpoint DEGRADES: an invalid/forbidden selector falls back to the login's OWN partner for the
    // displayed identity and flags `activeSelectorInvalid` so the FE can clear the stale cookie. This
    // resolution NEVER throws (we read `forbidden` directly instead of the throwing private helper).
    const active = await resolveActivePartnerId(this.prisma, {
      clientId: user.clientId,
      userSub: user.sub,
      phone: user.phone,
      requestedPartnerId,
    });
    const activeSelectorInvalid = active.forbidden;
    const activePartnerId = active.forbidden ? ownPartnerId : active.partnerId;

    const partner = activePartnerId
      ? await this.prisma.channelPartner.findFirst({
          // Load by the RESOLVED (authorized) id, tenant-scoped. Not by userId — a switched sibling
          // is login-less (userId=null) and would never match a userId:user.sub filter.
          where: { id: activePartnerId, clientId: user.clientId },
          select: {
            id: true,
            partnerCode: true,
            businessName: true,
            ownerName: true,
            phone: true,
            email: true,
            entityType: true,
          },
        })
      : null;

    const { outletType, hasPointsActivity, hasPayoutActivity } = partner
      ? await this.resolvePartnerActivity(user.clientId, partner.id)
      : { outletType: null, hasPointsActivity: false, hasPayoutActivity: false };

    // Per-tenant feature blob (DB-backed via TenantService.resolveClient — D-1). The
    // partner shell reads its runtime feature gating (walletModule / partnerApp.*)
    // from THIS authenticated response instead of the in-code CLIENT_REGISTRY.
    const features = await resolveTenantFeatures(this.tenant, user.clientId);

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
      features,
      // Login-picker: the operable set + parent-overview availability (Wave 3).
      // `activePartnerId` = the currently-selected outlet (own by default) so the FE switcher can
      // mark which operable entry is active — the selector cookie is httpOnly, so the FE can't read it.
      activePartnerId,
      // AUDIT FIX (HIGH): true when the supplied x-active-partner-id selector was invalid/forbidden —
      // the displayed identity above degraded to the login's OWN partner instead of 403-ing the shell.
      // The FE clears the stale selector cookie when it sees this. Default false (absent/valid selector).
      activeSelectorInvalid,
      operableOutlets: operable,
      groupOverviewAvailable: groupParent != null,
      groupParent,
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
  async getPayouts(user: JwtPayload, requestedPartnerId?: string) {
    // Wave 3: resolve the ACTIVE partner (own, or an authorized switched-to sibling). The selector
    // is re-authorized here — a forged id can never surface another partner's payout statement.
    const partnerId = await this.resolveActivePartner(user, requestedPartnerId);
    if (!partnerId) return { payouts: [] };

    // Delegated to the shared builder so the partner wallet + the sales outlet
    // ledger (kyc.service.ledger) can never drift — it does the exact two-rail
    // union (redemption by partnerId + credit by outlet CODE), status mapping,
    // FAILED/REVERSED exclusion, newest-first sort and 100-cap.
    const payouts = await buildPayoutStatement(
      this.prisma,
      user.clientId,
      partnerId,
    );
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
  async getTargets(user: JwtPayload, q: ListPartnerTargetsQueryDto, requestedPartnerId?: string) {
    // ── Resolve the ACTIVE partner (own, or an authorized switched-to sibling) + its outlet codes ──
    // Wave 3 access boundary: the selector is re-authorized, so a forged id can never read another
    // partner's targets; when switched, we return the SIBLING's outlets' targets.
    const partnerId = await this.resolveActivePartner(user, requestedPartnerId);

    if (!partnerId) return { period: q.period ?? null, outlets: [] };

    const outlets = await this.prisma.outlet.findMany({
      where: {
        clientId: user.clientId,
        partnerId,
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
    requestedPartnerId?: string,
  ): Promise<{
    kpiCode: string | null;
    kpiName: string | null;
    unit: string | null;
    trend: Array<{ month: string; target: number | null; achieved: number | null }>;
  }> {
    const span = Math.min(Math.max(Math.trunc(months) || 0, 1), 36);

    // Wave 3 access boundary: trend the ACTIVE partner's outlets (own, or an authorized sibling).
    const partnerId = await this.resolveActivePartner(user, requestedPartnerId);
    if (!partnerId) return { kpiCode: null, kpiName: null, unit: null, trend: [] };

    const outlets = await this.prisma.outlet.findMany({
      where: { partnerId, clientId: user.clientId },
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
  async getSalesTeam(user: JwtPayload, requestedPartnerId?: string) {
    // Wave 3 access boundary: the assigned reps of the ACTIVE partner (own, or an authorized sibling).
    const partnerId = await this.resolveActivePartner(user, requestedPartnerId);
    if (!partnerId) return { team: [] };

    const outlets = await this.prisma.outlet.findMany({
      where: { clientId: user.clientId, partnerId, deletedAt: null },
      select: { id: true },
    });
    const outletIds = outlets.map((o) => o.id);

    const assignments = await this.prisma.salesUserAssignment.findMany({
      where: {
        unassignedAt: null,
        salesUser: { isActive: true, deletedAt: null, clientId: user.clientId },
        OR: [
          { partnerId },
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

}
