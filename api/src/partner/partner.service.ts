import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { OutletPaymentType, PaymentDetailsStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import {
  CapturePayoutDetailsDto,
  ListPartnerTargetsQueryDto,
  UploadPartnerDocumentDto,
} from './dto/partner.dto';
import { kpiCodeKeys, NAMES_KEY, lastNMonths } from '../targets/targets.helpers';
import { buildPayoutStatement } from '../common/payout-statement.helper';
import { TenantService } from '../tenant/tenant.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { StorageService } from '../storage/storage.service';
import { sniffFileType } from '../common/file-signature';
import { resolveTenantFeatures } from '../common/tenant-features.helper';
import {
  acquireIdentityLocks,
  checkGroupUniqueness,
  isLockConflictError,
  normalizeIdentityValue,
  resolveActivePartnerId,
  resolveGroupIdentity,
  resolveOperableContexts,
} from '../common/partner-group.helper';
import { asUpiCaptureMethod, resolveUpiCaptureMethod } from '../common/payout-rail.helper';
import {
  allowedPaymentModes,
  isPaymentModeAllowed,
  PaymentMode,
} from '../common/payment-type.helper';
import { isLoyaltyEnabledForPartner } from '../common/loyalty-eligibility';
import { pickDeliveryDefaults, DeliveryDefaults } from './delivery-defaults.helper';
import { AppliesToOutletFacets } from '../common/applies-to/applies-to';
import { kpiAppliesToOutlet, outletPrimaryFallback } from '../sales/outlet-kpi-scope.helper';

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
    private readonly tenantSettings: TenantSettingsService,
    private readonly storage: StorageService,
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

    const { outletType, outletName, hasPointsActivity, hasPayoutActivity, loyaltyEnabled, deliveryDefaults } = partner
      ? await this.resolvePartnerActivity(user.clientId, partner.id)
      : {
          outletType: null,
          outletName: null,
          hasPointsActivity: false,
          hasPayoutActivity: false,
          loyaltyEnabled: true,
          deliveryDefaults: null,
        };

    // Per-tenant feature blob (DB-backed via TenantService.resolveClient — D-1). The
    // partner shell reads its runtime feature gating (walletModule / partnerApp.*)
    // from THIS authenticated response instead of the in-code CLIENT_REGISTRY.
    const features = await resolveTenantFeatures(this.tenant, user.clientId);

    return {
      businessName: partner?.businessName ?? null,
      // The active outlet's MASTER name (Outlet.name) — the partner shell header shows this so it
      // matches the admin outlet master; the FE falls back to businessName when it's null.
      outletName,
      ownerName: partner?.ownerName ?? null,
      partnerCode: partner?.partnerCode ?? null,
      phone: partner?.phone ?? null,
      email: partner?.email ?? null,
      entityType: partner?.entityType ?? null,
      outletType,
      hasPointsActivity,
      hasPayoutActivity,
      // Per-outlet-type Loyalty gate (OutletTypeClientConfig.loyaltyEnabled). Governs the
      // partner Rewards catalogue/redeem surface. Defaults true when there is no config row
      // for the primary outlet's type, or the partner has no outlet/type (schema default).
      loyaltyEnabled,
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
      // The ACTIVE outlet's pre-fill for the physical-gift delivery form (PLATFORM-WIDE,
      // owner-approved): the primary outlet's address on file — the partner's OWN data, keyed on
      // the re-authorized active partner (resolveActivePartnerId) + tenant. Null when nothing is on
      // file. Never logged; never written back to the outlet.
      deliveryDefaults,
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
  ): Promise<{
    outletType: string | null;
    outletName: string | null;
    hasPointsActivity: boolean;
    hasPayoutActivity: boolean;
    loyaltyEnabled: boolean;
    deliveryDefaults: DeliveryDefaults | null;
  }> {
    // Partner's outlets — outletCode (payout-entry scoping) + primary-outlet type + name in one query.
    // NB: CreditPayoutEntry.outletId stores the outlet CODE (not the Outlet PK) — it is a
    // bare string set from the uploaded "Outlet ID", resolved elsewhere via outletCode
    // (credits.service confirmBatch). So the credit-payout scope MUST key on outletCode.
    const outlets = await this.prisma.outlet.findMany({
      where: { clientId, partnerId, deletedAt: null },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      select: {
        name: true,
        outletCode: true,
        outletTypeId: true,
        outletType: { select: { code: true } },
        // Delivery-address pre-fill reads the SAME primary-outlet row (no extra query).
        addressLine1: true,
        addressLine2: true,
        city: true,
        state: true,
        pincode: true,
      },
    });
    const outletType = outlets[0]?.outletType?.code ?? null;
    // The ACTIVE outlet's MASTER name (the admin-roster Outlet.name) for the partner-shell header,
    // resolved from the SAME primary-outlet selection as outletType. Null when the partner has no
    // outlet — the FE then falls back to businessName so the header never shows blank.
    const outletName = outlets[0]?.name ?? null;
    const outletCodes = outlets.map((o) => o.outletCode);
    // Redeem-form address pre-fill from the SAME primary-outlet row (outlet address only).
    const deliveryDefaults = pickDeliveryDefaults(outlets[0] ?? null);

    // Per-outlet-type Loyalty (Rewards) gate — resolved via the shared helper (single source
    // of truth, also used by the rewards-service enforcement). Defaults true when there is no
    // OutletTypeClientConfig row for the primary outlet's type, or no outlet/type at all.
    const loyaltyEnabled = await isLoyaltyEnabledForPartner(this.prisma, clientId, partnerId);

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

    return { outletType, outletName, hasPointsActivity, hasPayoutActivity, loyaltyEnabled, deliveryDefaults };
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
   * GET /v1/partner/payouts — the caller's own FULL payout history (no row cap).
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
    // FAILED/REVERSED exclusion and newest-first sort — the complete history, uncapped.
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
      // outletType resolves from the AUTHORITATIVE Outlet.outletType.code (Phase 1 root-fix),
      // NOT the stale OutletTarget.outletType snapshot which only refreshes on re-upload.
      // programName/programCategory = the APPLIES-TO program facets (per-outlet KPI scope, D6).
      select: { outletCode: true, programName: true, programCategory: true, outletType: { select: { code: true } } },
    });

    if (outlets.length === 0) return { period: q.period ?? null, outlets: [] };

    const outletCodes = outlets.map((o) => o.outletCode);

    // outletCode → current (authoritative) outlet-type code, for the per-outlet projection below.
    const outletTypeByCode = new Map(outlets.map((o) => [o.outletCode, o.outletType?.code]));
    // outletCode → APPLIES-TO facets (current outlet attributes — D9 live evaluation).
    const facetsByCode = new Map<string, AppliesToOutletFacets>(
      outlets.map((o) => [
        o.outletCode,
        { outletType: o.outletType?.code ?? null, program: o.programName ?? null, subProgram: o.programCategory ?? null },
      ]),
    );

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
        select: { outletCode: true, outletName: true, targetValues: true },
      }),
      this.prisma.outletSalesRecord.findMany({
        where: whereBase,
        select: { outletCode: true, kpiValues: true },
      }),
      this.prisma.kpiDef.findMany({
        where: { clientId: user.clientId },
        select: {
          code: true, label: true, unit: true, isPrimary: true, order: true,
          outletType: true, outletTypes: true, programs: true, subPrograms: true,
        },
      }),
    ]);

    // KPI code → generic label (the fallback when no per-outlet override is set),
    // plus unit + primary flag so the partner dashboard hero can pick THE primary
    // KPI and label its number (e.g. "of 800 cases") from real data.
    const kpiLabel   = new Map(kpiRows.map((k) => [k.code, k.label]));
    const kpiUnit    = new Map(kpiRows.map((k) => [k.code, k.unit]));
    const kpiPrimary = new Map(kpiRows.map((k) => [k.code, k.isPrimary]));
    // APPLIES-TO (D6): each outlet card is a single-outlet view → a KPI out of THAT outlet's scope is
    // hidden; when the tenant primary is out of scope the outlet's first in-scope KPI is its primary.
    // Unscoped KPIs have no predicate → every row/flag is exactly as before (Deoleo byte-identical).
    const kpiDefByCode = new Map(kpiRows.map((k) => [k.code, k]));

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
        const facets = facetsByCode.get(outletCode) ?? {};
        const allKpiCodes = new Set(
          [...kpiCodeKeys(targetValues), ...kpiCodeKeys(kpiValues)].filter((code) => {
            const def = kpiDefByCode.get(code);
            return !def || kpiAppliesToOutlet(def, facets); // D6: hide an out-of-scope KPI
          }),
        );
        const primaryFallback = outletPrimaryFallback(kpiRows, facets);

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
          const isPrimary =
            primaryFallback !== null ? code === primaryFallback : (kpiPrimary.get(code) ?? false);

          return { code, name, target, achieved, pace, unit, isPrimary };
        });

        return {
          outletCode,
          outletName: tRow?.outletName ?? outletCode,
          outletType: outletTypeByCode.get(outletCode) ?? '',
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
      select: { outletCode: true, programName: true, programCategory: true, outletType: { select: { code: true } } },
    });
    const outletCodes = outlets.map((o) => o.outletCode);
    if (outletCodes.length === 0) return { kpiCode: null, kpiName: null, unit: null, trend: [] };

    // Pick the KPI to trend. The caller (dashboard) passes the SAME primary KPI
    // its hero headline resolved, so the chart and the hero never disagree; when
    // it's absent/unknown, fall back to the flagged primary, then the first KPI.
    const allKpiDefs = await this.prisma.kpiDef.findMany({
      where: { clientId: user.clientId },
      select: {
        code: true, label: true, unit: true, isPrimary: true,
        outletType: true, outletTypes: true, programs: true, subPrograms: true,
      },
      orderBy: { code: 'asc' },
    });
    // APPLIES-TO (D6): only KPIs that apply to at least ONE of the partner's outlets are candidates
    // (so the primary falls back to an in-scope KPI). Unscoped KPIs always qualify → for an unscoped
    // tenant this is the full list in the same order (byte-identical).
    const outletFacets = outlets.map((o) => ({
      outletType: o.outletType?.code ?? null,
      program: o.programName ?? null,
      subProgram: o.programCategory ?? null,
    }));
    const kpiDefs = allKpiDefs.filter((k) => outletFacets.some((f) => kpiAppliesToOutlet(k, f)));
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

  // ── Capture-bank-at-redemption (docs/plans/PAYMENT-DETAILS-AT-REDEMPTION-DESIGN.md) ──────────
  /**
   * POST /v1/partner/documents — partner-scoped cheque upload (cancelled cheque only). Mirrors
   * KycService.uploadDocument (magic-byte sniff, 5 MB cap, tenant-foldered GCS key) so the bytes
   * live in object storage, not the DB. Partners cannot reach the KYC `kyc:initiate` doc route, so
   * the redemption capture needs its own partner-roled upload. Returns the object reference; the
   * caller passes { fileKey } to POST /v1/partner/payout-details.
   */
  async uploadPayoutDocument(user: JwtPayload, file: Express.Multer.File) {
    // Same feature gate as the capture itself — a tenant without the flag (incl. Deoleo) cannot use
    // this upload route at all (no storage abuse on a capability they don't have).
    const features = await resolveTenantFeatures(this.tenant, user.clientId);
    if ((features as Record<string, unknown>).captureBankAtRedemption !== true) {
      throw new ForbiddenException('Payout-detail capture is not enabled for this account.');
    }
    if (!file) throw new BadRequestException('No file uploaded');
    if (!file.buffer?.length) throw new BadRequestException('Empty file');
    const MAX_BYTES = 5 * 1024 * 1024; // 5 MB — same cap as KYC docs
    if (file.size > MAX_BYTES) throw new BadRequestException('File too large (max 5 MB)');
    // Untrusted client mimetype → sniff the real type from the file's magic bytes (AF-10).
    const sniffed = sniffFileType(file.buffer);
    if (!sniffed) {
      throw new BadRequestException(
        'Unsupported or corrupt file. Upload a JPG, PNG, WEBP, GIF, or PDF.',
      );
    }
    const key = this.storage.generateKey(
      `kyc/${user.clientId}`,
      file.originalname || `CANCELLED_CHEQUE.${sniffed.ext}`,
    );
    const fileUrl = await this.storage.uploadFile(file.buffer, key, sniffed.mime);
    return {
      documentType: 'CANCELLED_CHEQUE' as const,
      fileKey: key,
      fileUrl,
      fileName: file.originalname ?? null,
      mimeType: sniffed.mime, // trusted (sniffed), not client-supplied
      fileSizeBytes: file.size,
    };
  }

  /**
   * POST /v1/partner/payout-details — a wholesaler self-captures bank/UPI IN-FLOW at redemption.
   * Reuses the SAME validation + uniqueness rules as KYC (payment-type.helper, checkGroupUniqueness,
   * normalizeIdentityValue) but writes DIRECTLY to the partner (NOT a KYC submission → never flips an
   * approved outlet back to review). Persists with paymentDetailsStatus=UNVERIFIED; the details stay
   * HIDDEN from Store Info until a redemption payout on them is marked PAID (payouts.processBatch),
   * which flips the status to VERIFIED. Gated by the per-tenant `captureBankAtRedemption` flag
   * (default OFF → Deoleo & all other tenants cannot reach this path).
   */
  async capturePayoutDetails(
    user: JwtPayload,
    dto: CapturePayoutDetailsDto,
    requestedPartnerId?: string,
  ) {
    const partnerId = await this.resolveActivePartner(user, requestedPartnerId);
    if (!partnerId) throw new ForbiddenException('No operable outlet for this login.');

    // Feature gate — a no-op capability for any tenant without the flag.
    const features = await resolveTenantFeatures(this.tenant, user.clientId);
    if ((features as Record<string, unknown>).captureBankAtRedemption !== true) {
      throw new ForbiddenException('Payout-detail capture is not enabled for this account.');
    }

    // The partner + its primary outlet (payout mandate + owner-group for the uniqueness check) +
    // its CURRENT rails/status (to guard against overwriting an already-on-file beneficiary).
    const partner = await this.prisma.channelPartner.findFirst({
      where: { id: partnerId, clientId: user.clientId },
      select: {
        id: true,
        bankAccountNumber: true,
        ifscCode: true,
        upiId: true,
        upiCaptureMethod: true,
        paymentDetailsStatus: true,
        outlets: {
          where: { deletedAt: null },
          select: { requiredPaymentType: true, parentId: true },
          orderBy: { createdAt: 'asc' },
          take: 1,
        },
      },
    });
    if (!partner) throw new ForbiddenException('No operable outlet for this login.');

    // AUDIT FIX (HIGH): capture is only for an outlet with NO usable beneficiary, or one explicitly
    // flagged for re-capture after a FAILED payout. Mirror the FE gate SERVER-SIDE (the route is the
    // authority) so a direct POST can NEVER overwrite/wipe a beneficiary already on file — this both
    // protects VERIFIED details the credits bank-file reads live AND closes the re-capture-mid-flight
    // window that could let a never-paid rail ride a payout into VERIFIED.
    const hasBeneficiary = !!(
      partner.upiId || (partner.bankAccountNumber && partner.ifscCode)
    );
    if (
      hasBeneficiary &&
      partner.paymentDetailsStatus !== PaymentDetailsStatus.NEEDS_RECAPTURE
    ) {
      throw new BadRequestException(
        'Payout details are already on file for this outlet and cannot be changed here.',
      );
    }

    const requiredType = partner.outlets[0]?.requiredPaymentType ?? OutletPaymentType.ANY;
    const ourParentId = partner.outlets[0]?.parentId ?? null;

    const mode: PaymentMode = dto.paymentMode;
    // M1: a UPI capture WRITES a upiId → read the settings UNCACHED ONCE and use that copy for BOTH
    // the manual-entry gate and the UPI uniqueness lock/check below (a just-enabled flag / policy is
    // never refused or skipped from a stale per-instance cache). A bank capture keeps the cached read.
    const { salesApp, uniquenessPolicy } =
      mode === 'upi'
        ? await this.tenantSettings.getEffectiveSettings(user.clientId, { fresh: true })
        : await this.tenantSettings.getEffectiveSettings(user.clientId);
    const upiEnabled = salesApp.upiEnabled;

    // 1. Mode must satisfy the outlet mandate + tenant UPI gate (identical to kyc.service.create).
    if (!isPaymentModeAllowed(requiredType, mode, upiEnabled)) {
      const allowed = allowedPaymentModes(requiredType, upiEnabled);
      const label = allowed.length > 1 ? 'bank or UPI' : allowed[0] === 'upi' ? 'UPI' : 'bank';
      throw new BadRequestException(`This outlet requires payout by ${label}.`);
    }

    // 2. Required fields for the chosen mode (bank → name/acct/IFSC + cheque; UPI → upiId).
    const filled = (v?: string) => typeof v === 'string' && v.trim() !== '';
    if (mode === 'bank') {
      const missing = (['bankName', 'accountNumber', 'ifscCode'] as const).filter(
        (k) => !filled(dto[k]),
      );
      if (missing.length) {
        throw new BadRequestException(`Bank payout requires: ${missing.join(', ')}.`);
      }
      if (!filled(dto.chequeFileKey)) {
        throw new BadRequestException('A cancelled cheque is required for bank payout.');
      }
      // The cheque must be an object THIS tenant uploaded (reject a forged cross-tenant key). Also
      // reject any path-traversal segment so a crafted key can't escape the tenant folder on a
      // filesystem-backed StorageService (defense-in-depth; GCS keys are literal, but don't rely on it).
      if (
        !dto.chequeFileKey!.startsWith(`kyc/${user.clientId}/`) ||
        dto.chequeFileKey!.includes('..')
      ) {
        throw new BadRequestException('Invalid cheque reference.');
      }
    } else if (!filled(dto.upiId)) {
      throw new BadRequestException('UPI payout requires a UPI ID.');
    }

    // 2b. VPA safeguard — UPI capture method + manual-entry gate (mirrors kyc.service.create, R6/R7).
    //  Manual (typed) UPI entry is a per-tenant opt-in and the server is the authority — but a UPI
    //  that canonically EQUALS the partner's stored UPI, or the group UPI it was prefilled from, is not
    //  a fresh manual capture: it is accepted and keeps that prior's recorded method (also when no
    //  method was sent by an old cached FE). The settings were read UNCACHED above for a UPI capture
    //  (M1), so a just-enabled flag is never refused from a stale per-instance cache.
    let upiCaptureMethod: string | null = null;
    if (mode === 'upi') {
      const submittedUpi = normalizeIdentityValue('upi', dto.upiId);
      let prior: { upiCaptureMethod?: unknown } | null =
        submittedUpi != null && normalizeIdentityValue('upi', partner.upiId) === submittedUpi ? partner : null;
      const manualAllowed = salesApp.upiManualEntry;
      const sentMethod = asUpiCaptureMethod(dto.upiCaptureMethod);
      const explicitMethod = sentMethod === 'QR' || (sentMethod === 'MANUAL' && manualAllowed);
      // L3: no usable method sent (none / MANUAL with manual entry OFF) → a UPI equal to the group
      // prefill keeps the group's recorded method.
      if (!prior && !explicitMethod && ourParentId) {
        const gi = await resolveGroupIdentity(this.prisma, user.clientId, ourParentId);
        if (gi && submittedUpi != null && normalizeIdentityValue('upi', gi.upiId) === submittedUpi) prior = gi;
      }
      if (!prior && sentMethod === 'MANUAL' && !manualAllowed) {
        throw new BadRequestException('Manual UPI entry is not enabled');
      }
      upiCaptureMethod = resolveUpiCaptureMethod(dto.upiCaptureMethod, manualAllowed, prior);
      if (
        asUpiCaptureMethod(dto.upiCaptureMethod) === 'MANUAL' &&
        manualAllowed &&
        normalizeIdentityValue('upi', dto.upiIdConfirm) !== submittedUpi
      ) {
        // VPA safeguard: a TYPED UPI ID must be confirmed by re-entry (case/space-insensitive — the
        // same canonical form we persist). A scanned (QR) UPI needs no confirmation.
        throw new BadRequestException('UPI IDs do not match');
      }
    }

    // 3. Normalized identity values (the SAME canonical form KYC persists AND locks/checks on).
    const bankAcct = mode === 'bank' ? normalizeIdentityValue('bank', dto.accountNumber) : null;
    const upi = mode === 'upi' ? normalizeIdentityValue('upi', dto.upiId) : null;

    // 4. Atomic: row-lock the partner → re-run the overwrite gate on the LOCKED row → advisory-lock the
    //    identity value(s) → re-check group-uniqueness → conditional write. bank/UPI have NO DB unique
    //    index, so the identity lock + check is their ONLY race guard (mirrors kyc.service).
    //    LOCK ORDER (deadlock fix): the partner row FIRST, identity advisory locks SECOND — the SAME
    //    order as the re-KYC approval (kyc.service applyBridgeOutcome: SELECT … FOR UPDATE on
    //    channel_partners, then acquireIdentityLocks). The opposite order let a capture holding an
    //    identity lock wait on the partner row an approval held while that approval waited on the
    //    capture's identity lock → Postgres deadlock (40P01) → a raw 500.
    try {
      await this.prisma.$transaction(async (tx) => {
        const lockedRows = await tx.$queryRaw<
          Array<{
            upiId: string | null;
            bankAccountNumber: string | null;
            ifscCode: string | null;
            paymentDetailsStatus: string | null;
          }>
        >`SELECT "upiId", "bankAccountNumber", "ifscCode", "paymentDetailsStatus"::text AS "paymentDetailsStatus"
          FROM channel_partners WHERE id = ${partnerId} FOR UPDATE`;
        const locked = lockedRows?.[0];
        if (!locked) throw new ForbiddenException('No operable outlet for this login.');
        // The overwrite gate, re-run on the ROW-LOCKED values (the gate above read an unlocked snapshot;
        // a re-KYC approval may have committed a VERIFIED rail in between). Same rule, same message.
        const lockedHasBeneficiary = !!(locked.upiId || (locked.bankAccountNumber && locked.ifscCode));
        if (lockedHasBeneficiary && locked.paymentDetailsStatus !== PaymentDetailsStatus.NEEDS_RECAPTURE) {
          throw new BadRequestException(
            'Payout details are already on file for this outlet and cannot be changed here.',
          );
        }
        await acquireIdentityLocks(tx, {
          clientId: user.clientId,
          details: { bankAccountNumber: bankAcct, upiId: upi },
          policy: uniquenessPolicy,
        });
        const violation = await checkGroupUniqueness(tx, {
          clientId: user.clientId,
          ourParentId,
          details: { bankAccountNumber: bankAcct, upiId: upi },
          policy: uniquenessPolicy,
          exceptPartnerId: partnerId,
        });
        if (violation) throw new BadRequestException(violation.message);

        // F3 (race, belt-and-braces): the row is now locked above, but the write stays CONDITIONED on
        // exactly the status + routing values the UNLOCKED gate read (and that the UPI capture-method
        // prior was derived from): if any changed before the lock, 0 rows match → 409, nothing written.
        const { count } = await tx.channelPartner.updateMany({
          where: {
            id: partnerId,
            clientId: user.clientId,
            paymentDetailsStatus: partner.paymentDetailsStatus,
            upiId: partner.upiId ?? null,
            bankAccountNumber: partner.bankAccountNumber ?? null,
            ifscCode: partner.ifscCode ?? null,
          },
          data:
            mode === 'bank'
              ? {
                  paymentMode: 'bank',
                  bankName: dto.bankName!.trim(),
                  bankAccountHolder: dto.accountHolderName?.trim() || null,
                  bankAccountNumber: bankAcct,
                  ifscCode: dto.ifscCode!.trim().toUpperCase(),
                  upiId: null, // clear the other rail so a payout can't misroute to a stale UPI
                  upiCaptureMethod: null,
                  payoutChequeFileKey: dto.chequeFileKey!,
                  paymentDetailsStatus: PaymentDetailsStatus.UNVERIFIED,
                }
              : {
                  paymentMode: 'upi',
                  upiId: upi,
                  upiCaptureMethod,
                  bankName: null,
                  bankAccountHolder: null,
                  bankAccountNumber: null,
                  ifscCode: null,
                  payoutChequeFileKey: null,
                  paymentDetailsStatus: PaymentDetailsStatus.UNVERIFIED,
                },
        });
        if (count === 0) {
          throw new ConflictException('Payout details changed — please refresh');
        }
      });
    } catch (e) {
      // A lock-conflict abort (P2034 / Postgres 40P01 deadlock / 40001) → the same clean 409, never a 500.
      if (isLockConflictError(e)) throw new ConflictException('Payout details changed — please refresh');
      throw e;
    }

    return {
      ok: true,
      paymentMode: mode,
      paymentDetailsStatus: PaymentDetailsStatus.UNVERIFIED,
    };
  }
}
