import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { TdsMethodology, TdsSection } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { loadOutletTypeDisplayNames, labelFor } from '../common/outlet-type-display';

/**
 * One enabled outlet type for the caller tenant, projected for every front-end that renders an
 * outlet-type picker / filter / label (sales, KYC, admin, partner).
 *
 * `code`        — the STABLE logic key (SSS / WHOLESALER / …); logic + filtering key only, never
 *                 localized.
 * `name`        — the global `OutletType.name`.
 * `displayName` — the tenant's per-type override (`OutletTypeClientConfig.displayName`), trimmed to
 *                 a non-blank value or `null`. This is the ONLY signal a surface needs to decide
 *                 "use the override vs keep my OWN current hardcoded label": a tenant with no
 *                 override (e.g. Deoleo) yields `displayName: null` for every type ⇒ every surface
 *                 keeps its current label BYTE-IDENTICAL. Bajaj's SSS→"RLP" / WHOLESALER→"BSC" set
 *                 it, so only those surfaces change, only for Bajaj, purely via config.
 * `label`       — convenience `displayName ?? name`, for a consumer that has no hardcoded fallback.
 */
export interface OutletTypeOption {
  code: string;
  label: string;
  name: string;
  displayName: string | null;
}

/**
 * TenantSettingsService — the SINGLE typed reader for the per-tenant "Gifsy Settings".
 *
 * Settings are stored as rows in `program_settings` (key/value JSON, scoped by clientId),
 * the same store the admin settings page already uses (`AdminCoreService.getSettings/
 * upsertSetting`). This service overlays those rows onto typed DEFAULTS and returns a
 * validated `EffectiveSettings` object.
 *
 * It replaces three divergent sources that previously each held a copy of these values:
 *   1. the per-deploy `POINTS_CONVERSION_RATE` env var (held as a `readonly` field in
 *      rewards/wallet services),
 *   2. the flat `SETTINGS_DEFAULTS` literal in admin-core,
 *   3. the browser `localStorage` blob (`platform/src/lib/gifsy-settings.ts`).
 *
 * conversionRate is on the money hot path (every redeem/confirm), so reads are cached per
 * clientId with a short TTL. The cache is busted on write: `AdminCoreService.upsertSetting`
 * calls `invalidate(clientId)` after persisting. @Global so any module can inject it.
 */

/**
 * RETIRED (2026-11-21, owner: "move Deoleo to it and completely retire the old engine"): the per-tenant POINTS
 * reversal engine mode. Every tenant now runs the one position-based engine (WalletService.applyCreditReversal); there
 * is no LEGACY / SHADOW mode and no switch. A `reversalEngine` program_settings row left behind (e.g. Bajaj staging's
 * 'V2') is IGNORED — nothing reads it. The key stays reserved only so the generic settings upsert keeps refusing it
 * (AdminCoreService.upsertSetting) — nobody can write a value that looks like it means something.
 */
export const REVERSAL_ENGINE_SETTING_KEY = 'reversalEngine';

/**
 * Per-tenant "POINTS reversal approvals paused" switch (WALLET-REVERSAL-ENGINE-DESIGN.md §9.1, owner Q5 2026-11-16):
 * the program_settings row `pointsReversalApprovalsPaused` = `{ paused: boolean, since?: ISO, by?: string,
 * reason?: string }`. The WP6 backfill turns it on for the APPLY window; while on, POINTS reversal create / approve
 * are refused. Absent ⇒ not paused. A malformed value FAILS CLOSED (treated as paused — money path).
 */
export const POINTS_REVERSAL_PAUSE_SETTING_KEY = 'pointsReversalApprovalsPaused';

/**
 * Per-tenant switch (owner decision 2026-11-25, UPLOAD-NEGATIVE-DEDUCTIONS-DESIGN.md): when `true`, a NEGATIVE POINTS
 * value in the Credits & Payouts upload DEDUCTS those points from the outlet's wallet instead of being an error. A
 * scalar boolean row in program_settings; absent / malformed / anything but a strict `true` ⇒ OFF (every tenant today,
 * incl. Deoleo). Turned ON for Bajaj only.
 */
export const CREDIT_UPLOAD_NEGATIVE_DEDUCTIONS_KEY = 'creditUploadNegativeDeductions';

export interface PointsReversalPause {
  paused: boolean;
  since: string | null;
  by: string | null;
  reason: string | null;
  /** the stored value could not be read → treated as paused */
  malformed?: boolean;
}

/** The DB handle a settings read runs on: the service's own client, or the CALLER's interactive transaction. */
export type SettingsReader = Pick<PrismaService, 'programSetting'>;

export interface RedemptionChannels {
  physicalGifts: boolean;
  vouchers:      boolean;
  bankTransfer:  boolean;
}

/**
 * Parent-child owner-group UNIQUENESS policy (docs/plans/PARTNER-MULTI-OUTLET.md). Which
 * exact-match identity fields are enforced unique-except-within-group. PAN is NOT here — it
 * is always the group golden-key (identical-within-group). Default preserves today's
 * behaviour: GST + phone enforced; bank/UPI were never checked, so default false.
 */
export interface UniquenessPolicySettings {
  gst:   boolean;
  phone: boolean;
  bank:  boolean;
  upi:   boolean;
}

export interface SalesAppSettings {
  ledgerLabel:              string;
  /** When true, the sales KYC form offers UPI as a payout option. Default false = bank-only. */
  upiEnabled:               boolean;
  upiManualEntry: boolean;
}
// NOTE: the former `redeemGiftWholesalerOnly` binary was replaced by the per-outlet-type
// `OutletTypeClientConfig.salesAssistedRedeemEnabled` flag (see sales-redeem-eligibility.ts).

/**
 * Per-tenant, per-purpose MSG91 OTP template IDs. Each field holds an MSG91-registered
 * template_id used for that OTP purpose; an EMPTY string means "use the global env
 * template" (MSG91_OTP_TEMPLATE_ID) — the prior behaviour, so platform + unconfigured
 * tenants are byte-identical to before.
 */
export interface OtpTemplatesSettings {
  /** Login OTP (pre-auth send-otp). */
  login:           string;
  /** Partner SELF redemption confirmation OTP. */
  redemptionSelf:  string;
  /** Outlet-owner KYC consent OTP. */
  kycConsent:      string;
  /** SALES-ASSISTED redemption OTP (sent to the outlet's phone). */
  redemptionSales: string;
}

/** The distinguishable OTP purposes, keyed to OtpTemplatesSettings. */
export type OtpTemplatePurpose = 'login' | 'redemptionSelf' | 'kycConsent' | 'redemptionSales';

/**
 * Points Compute Engine per-tenant switches (POINTS-COMPUTE-ENGINE-DESIGN.md §7, §12 #4/#8).
 * Reader + default ONLY at Wave 0 — NO enforcement is wired yet (that is Wave 2). Both
 * default FALSE so the engine ships DORMANT: a tenant must be explicitly turned on.
 *   - enabled             — master switch for the whole engine for this tenant (authoring +
 *                           compute + export). When OFF the engine is invisible/no-op.
 *   - directCreditEnabled — the GIFSY-admin-gated in-portal "compute → confirm → credit"
 *                           money shortcut (§12 #4). Even when the engine is enabled, direct
 *                           wallet crediting stays OFF until Gifsy turns this on; clients may
 *                           still author + compute + export without it.
 */
export interface PointsEngineSettings {
  enabled:             boolean;
  directCreditEnabled: boolean;
  /**
   * GIFSY-set "points engine first live month" (YYYY-MM; null = no guard — every tenant by default). Runs covering a
   * month BEFORE it (data imported from the old system) are refused for export / credit unless a Gifsy admin confirms.
   */
  firstLiveMonth?:     string | null;
}

export interface CreditsPayoutsSettings {
  monthCutoffDay:  number;
  safetyCapPoints: number;
  safetyCapInr:    number;
  /** DEFERRED to post-go-live — stored but not enforced; the toggle is hidden in the UI. */
  fourEyesEnabled: boolean;
  notifyEmails:    string[];
}

/** Visibility (POSM) geo-fence sub-config (design D10). */
export interface GeoFenceSettings {
  /** When true, a capture beyond `radiusMeters` from the outlet's reference geo is blocked. */
  enabled:      boolean;
  /** Geo-fence radius in metres. Positive integer, clamped/validated to 1..5000. Default 50. */
  radiusMeters: number;
}

/**
 * Visibility (POSM) configuration (docs/plans/VISIBILITY-POSM-DESIGN.md §1, D5/D6/D8/D10).
 * GIFSY_ADMIN-only write; tenant admins read-only. The Visibility master switch
 * (`visibilityEnabled`) and capture-mode selector live elsewhere — this holds the
 * photo-approval capture parameters.
 */
export interface VisibilityConfigSettings {
  /** Outlet scope = list of OutletType.code (e.g. ["SSS","SSS_TOT"]); empty = no outlets in scope yet. */
  outletScope:        string[];
  /** Captures required per calendar month → windows. Integer 1..4; default 1. */
  frequencyPerMonth:  number;
  /** Which SalesHierarchyLevel.code values may capture (e.g. ["XSR","SO","ASM"]); empty = none. */
  allowedSalesLevels: string[];
  /** Geo-fence policy on capture (D10). */
  geoFence:           GeoFenceSettings;
  /**
   * APPLIES-TO narrowing (APPLIES-TO-TARGETING-PLAN §0/D12): Outlet.programName values; EMPTY = all
   * programs. Narrows `outletScope` further (AND); `outletScope` keeps its own "empty = NONE" meaning.
   */
  programs:           string[];
  /** Outlet.programCategory values; EMPTY = all sub-programs (independent of `programs`, D11). */
  subPrograms:        string[];
  /**
   * Sales photo view (owner 2026-11-24, TENANT-SCOPED): SalesHierarchyLevel.code values (like allowedSalesLevels, e.g.
   * ["XSR","SO","ASM"]) whose users may SEE this month's capture photos of outlets in their team in the sales app.
   * ABSENT / empty = OFF — the key is only present on the effective config when the tenant stored a non-empty list, so
   * every other tenant's settings / config responses stay byte-identical.
   */
  salesPhotoViewLevels?: string[];
}

/**
 * Per-tenant TDS treatment for VISIBILITY-stream payouts (docs/plans/
 * VISIBILITY-PAYOUT-TDS-WAVE0-SCHEMA.md §5, W0-A). Resolved once at payout-confirm and
 * FROZEN by value onto each CreditPayoutEntry (never re-read live afterwards).
 *   - section     — which statutory section the visibility payout is treated under.
 *   - methodology — DEDUCT (withhold from payout, carry-forward) vs GROSS_UP (payer-borne
 *                   at-threshold TDS invoice + pro-rata recovery).
 * INCENTIVE-stream payouts ignore `section` — they are always 194R (see deriveFrozenSection).
 *
 * ⚠️ VALIDATION IS FAIL-CLOSED, not merge-to-default. An ABSENT tdsPolicy key resolves to the
 * default-on default {SEC_194C, GROSS_UP}. A PRESENT-but-malformed value THROWS (never
 * silently coerces) — a bad section/methodology must not silently mis-route tax on the
 * money path. See overlay()/validateTdsPolicy.
 */
export interface TdsPolicySettings {
  section:     TdsSection;
  methodology: TdsMethodology;
}

export interface EffectiveSettings {
  /** Points→₹ rate. Default = POINTS_CONVERSION_RATE env (preserves prior behaviour). */
  conversionRate:         number;
  /** Minimum ₹ for a bank/DBT transfer redemption. */
  minBankTransferAmount:  number;
  /** Minimum ₹ for a free-amount voucher redemption. */
  minVoucherFreeAmount:   number;
  /** Amber pace-zone threshold as a % of time elapsed. */
  paceAmberThreshold:     number;
  /**
   * Per-tenant MASTER switch for the whole Visibility module (photo-approval AND
   * amount-upload paths). When false, every visibility endpoint returns 403 and the
   * FE hides all visibility surfaces. Default is FALSE (opt-in) — a tenant must be
   * explicitly turned ON in the Gifsy Settings panel. Distinct from (and above) the
   * ClientConfig `visibilityCaptureMode` selector, and from the per-outlet-type
   * `OutletTypeClientConfig.visibilityEnabled` column.
   */
  visibilityEnabled:      boolean;
  /**
   * Per-tenant switch: when true (DEFAULT), a GSTIN is COMPULSORY to submit KYC — the KYC
   * create/submit path rejects a blank GSTIN. Gifsy-only editable (a tenant with genuinely
   * unregistered outlets is turned OFF in the Gifsy Settings panel). Default TRUE (opt-out),
   * the inverse of `visibilityEnabled`'s opt-in default.
   */
  kycGstinRequired:       boolean;
  redemptionChannels:     RedemptionChannels;
  salesApp:               SalesAppSettings;
  creditsPayouts:         CreditsPayoutsSettings;
  /**
   * Per-tenant, per-purpose OTP template IDs. Every field defaults to '' (use the global
   * env template). Resolved per send site via getOtpTemplateId(clientId, purpose).
   */
  otpTemplates:           OtpTemplatesSettings;
  /**
   * Allowed "Program Name" values for the Outlet Master upload (per-tenant). Drives the
   * upload validator + template generator on the FE. The value stored on each outlet stays
   * free text — only the ALLOWED list is configurable here. Never empty (default-guarded).
   */
  outletPrograms:         string[];
  /**
   * Allowed "Sub-Program" values for the Outlet Master upload (per-tenant). Same model
   * as outletPrograms. Never empty (default-guarded).
   */
  outletCategories:       string[];
  /**
   * Parent-child owner-group uniqueness policy — which identity fields are enforced
   * unique-except-within-group. PAN is always enforced separately (group golden-key).
   */
  uniquenessPolicy:       UniquenessPolicySettings;
  /**
   * The uniqueness policy AS STORED (before the Fix B `upiManualEntry` derivation). Read-only
   * view for the admin settings UI so it edits/saves the stored value, never the derived one
   * (prevents a write-back that would persist upi=true). Enforcement MUST read
   * `uniquenessPolicy` (derived), never this field.
   */
  uniquenessPolicyStored: UniquenessPolicySettings;
  /**
   * Visibility (POSM) capture configuration — outlet scope, monthly frequency, allowed
   * sales levels + geo-fence (design D5/D6/D8/D10). REPLACE-WHOLE nested key (see contract
   * below). Default = empty scope + empty levels + freq 1 + geo-fence off (radius 50m).
   */
  visibilityConfig:       VisibilityConfigSettings;
  /**
   * Per-tenant TDS treatment for VISIBILITY-stream payouts. Absent → default-on default
   * {SEC_194C, GROSS_UP}; a present-but-malformed value FAILS CLOSED (throws) rather than
   * silently coercing — money-path hardening (W0-A). Resolved via resolveTdsPolicy().
   */
  tdsPolicy:              TdsPolicySettings;
  /**
   * Points Compute Engine per-tenant switches. Both default FALSE (engine ships dormant).
   * Reader + default only at Wave 0 — enforcement is NOT wired yet.
   */
  pointsEngine:           PointsEngineSettings;
  /**
   * Upload negative POINTS deduct from the wallet (UPLOAD-NEGATIVE-DEDUCTIONS-DESIGN.md). Default FALSE. Display only
   * here — the money path reads getCreditUploadNegativeDeductionsUncached().
   */
  creditUploadNegativeDeductions: boolean;
}

/**
 * The keys as persisted in `program_settings.settingKey`. Scalars store a number/boolean;
 * the three grouped keys store a JSON object.
 *
 * ⚠️ CONTRACT — nested keys are REPLACE-WHOLE, not field-merge-against-stored. The overlay
 * deep-merges a stored nested object over its typed DEFAULT (so a malformed/partial value
 * still yields a complete object), but it does NOT merge against the previously-saved row.
 * A writer that PUTs only one sub-field (e.g. `{redemptionChannels:{bankTransfer:false}}`)
 * will reset the omitted siblings to their DEFAULTS, silently re-enabling a channel an admin
 * had disabled. Therefore every writer MUST send the COMPLETE nested object for these keys.
 * (The FE `saveGifsySettings` always passes whole nested objects — keep it that way.)
 */
type SettingKey =
  | 'conversionRate'
  | 'minBankTransferAmount'
  | 'minVoucherFreeAmount'
  | 'paceAmberThreshold'
  | 'visibilityEnabled'
  | 'kycGstinRequired'
  | 'redemptionChannels'
  | 'salesApp'
  | 'creditsPayouts'
  | 'otpTemplates'
  | 'outletPrograms'
  | 'outletCategories'
  | 'uniquenessPolicy'
  | 'visibilityConfig'
  | 'tdsPolicy'
  | 'pointsEngine'
  | typeof CREDIT_UPLOAD_NEGATIVE_DEDUCTIONS_KEY;

const NESTED_KEYS: ReadonlySet<SettingKey> = new Set([
  'redemptionChannels',
  'salesApp',
  'creditsPayouts',
  'otpTemplates',
  'uniquenessPolicy',
  'visibilityConfig',
  'pointsEngine',
]);

@Injectable()
export class TenantSettingsService {
  private readonly logger = new Logger(TenantSettingsService.name);

  private cache = new Map<string, { settings: EffectiveSettings; cachedAt: number }>();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes; also busted on write

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The caller-tenant's ENABLED outlet types for the FE outlet-type picker/filter/label surfaces.
   * Scoped by the JWT `clientId` (no cross-tenant exposure). Reuses the shared
   * `loadOutletTypeDisplayNames` / `labelFor` helpers so the override-resolution rule cannot
   * diverge from the admin-outlets list projection. A tenant with no `displayName` override (e.g.
   * Deoleo) ⇒ every row's `displayName` is `null` ⇒ every FE surface keeps its current label.
   */
  async getOutletTypes(clientId: string): Promise<OutletTypeOption[]> {
    const [displayNames, configs] = await Promise.all([
      loadOutletTypeDisplayNames(this.prisma, clientId),
      this.prisma.outletTypeClientConfig.findMany({
        where: { clientId, isEnabled: true, outletType: { isActive: true } },
        select: { outletTypeId: true, outletType: { select: { code: true, name: true } } },
      }),
    ]);
    return configs
      .map((c) => ({
        code: c.outletType.code,
        name: c.outletType.name,
        displayName: displayNames.get(c.outletTypeId) ?? null,
        label: labelFor(displayNames, c.outletTypeId, c.outletType.name),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  /**
   * Default conversion rate, derived from the env var so the boot guard in main.ts
   * (which validates POINTS_CONVERSION_RATE is finite/positive) stays meaningful and the
   * per-tenant default never diverges from the deploy-wide default.
   */
  /**
   * Smallest conversion rate the centi-rate snapshot (Math.round(rate*100)) can represent
   * without collapsing to 0. A rate below this rounds to conversionRateCenti=0, which the
   * confirm path can't distinguish from a pre-migration null — so such a rate is rejected at
   * the validation boundary and the env/per-tenant default is kept instead. Guarantees the
   * order snapshot is always >= 1 and the rate-freeze invariant always holds.
   */
  static readonly MIN_RATE = 0.005; // Math.round(0.005 * 100) === 1

  static envConversionRate(): number {
    const raw = parseFloat(process.env.POINTS_CONVERSION_RATE ?? '1');
    return Number.isFinite(raw) && raw >= TenantSettingsService.MIN_RATE ? raw : 1;
  }

  /** Typed defaults. Mirrors the prior localStorage DEFAULT_SETTINGS so no behaviour shifts. */
  defaults(): EffectiveSettings {
    return {
      conversionRate:         TenantSettingsService.envConversionRate(),
      minBankTransferAmount:  250,
      minVoucherFreeAmount:   250,
      paceAmberThreshold:     10,
      // Master Visibility switch defaults OFF — visibility is opt-in per tenant
      // (owner decision 2026-06-25). A tenant must be turned ON in Gifsy Settings.
      visibilityEnabled:      false,
      // GSTIN compulsory by default (opt-out); a tenant with unregistered outlets is turned OFF.
      kycGstinRequired:       true,
      redemptionChannels:     { physicalGifts: true, vouchers: true, bankTransfer: true },
      salesApp:               { ledgerLabel: 'Wallet', upiEnabled: false, upiManualEntry: false },
      creditsPayouts: {
        monthCutoffDay:  28,
        safetyCapPoints: 50000,
        safetyCapInr:    100000,
        fourEyesEnabled: false,
        notifyEmails:    [],
      },
      // Every OTP template defaults to '' = "use the global env template" (MSG91_OTP_TEMPLATE_ID),
      // so a tenant that hasn't configured per-purpose templates behaves exactly as before.
      otpTemplates: {
        login:           '',
        redemptionSelf:  '',
        kycConsent:      '',
        redemptionSales: '',
      },
      // Allowed Outlet Master upload lists — default to the prior hardcoded FE constants
      // so existing tenants see no behaviour change until they customise them.
      outletPrograms:   ['Trade Loyalty', 'Gold Programme'],
      outletCategories: ['Premium', 'Standard', 'Economy'],
      // Uniqueness policy — default preserves today's behaviour (GST + phone enforced;
      // bank/UPI were never checked). Deoleo turns bank/UPI on via a per-tenant override.
      uniquenessPolicy: { gst: true, phone: true, bank: false, upi: false },
      // Stored-view copy of the default policy (separate object — never share the reference).
      uniquenessPolicyStored: { gst: true, phone: true, bank: false, upi: false },
      // Visibility (POSM) config — default is dormant: no outlets in scope, no allowed
      // levels, one window/month, geo-fence off (suggested 50m radius). A GIFSY admin
      // configures scope/levels/geo before the feature is meaningful for a tenant.
      visibilityConfig: {
        outletScope:        [],
        frequencyPerMonth:  1,
        allowedSalesLevels: [],
        geoFence:           { enabled: false, radiusMeters: 50 },
        programs:           [],
        subPrograms:        [],
      },
      // TDS policy — DEFAULT-ON (owner decision W0-E): a tenant with no explicit tdsPolicy
      // row applies 194C + gross-up at confirm. (A present-but-malformed row throws — see
      // overlay/validateTdsPolicy — so this default only ever applies to a genuinely ABSENT key.)
      tdsPolicy: {
        section:     TdsSection.SEC_194C,
        methodology: TdsMethodology.GROSS_UP,
      },
      // Points Compute Engine — DORMANT by default (owner decision §12 #4/#8). Both OFF: a
      // tenant must be explicitly enabled; direct wallet crediting stays GIFSY-gated on top.
      pointsEngine: {
        enabled:             false,
        directCreditEnabled: false,
        firstLiveMonth:      null,
      },
      // Upload negative POINTS → wallet deductions — OFF by default (owner 2026-11-25: Bajaj only).
      creditUploadNegativeDeductions: false,
    };
  }

  /**
   * The full typed settings for a tenant (cached). `opts.fresh` bypasses the per-instance cache read
   * (the DB is re-read and the cache refreshed) — for a gate that must not reject on a ≤5-min-stale
   * copy after the flag was just flipped on another instance.
   */
  async getEffectiveSettings(clientId: string, opts?: { fresh?: boolean }): Promise<EffectiveSettings> {
    const cached = opts?.fresh ? undefined : this.cache.get(clientId);
    if (cached && Date.now() - cached.cachedAt < this.CACHE_TTL_MS) {
      return cached.settings;
    }

    const base = this.defaults();
    let rows: { settingKey: string; settingValue: unknown }[] = [];
    try {
      rows = await this.prisma.programSetting.findMany({
        where: { clientId },
        select: { settingKey: true, settingValue: true },
      });
    } catch (e) {
      // Never let a settings read crash a money path — fall back to typed defaults.
      this.logger.warn(`programSetting read failed for ${clientId}; using defaults: ${e}`);
      return base;
    }

    const settings = this.overlay(base, rows);
    this.cache.set(clientId, { settings, cachedAt: Date.now() });
    return settings;
  }

  /** Convenience for the money path. */
  async getConversionRate(clientId: string): Promise<number> {
    return (await this.getEffectiveSettings(clientId)).conversionRate;
  }

  /**
   * Resolve the per-tenant TDS policy {section, methodology} used by the payout engine at
   * confirm-time to freeze each entry's treatment. UNCACHED strict read (mirrors
   * getVisibilityEnabledUncached): absent → default-on {SEC_194C, GROSS_UP}; a present-but-malformed
   * stored value THROWS here — fail-closed SCOPED to the money path. Deliberately does NOT route
   * through getEffectiveSettings/overlay: a bad tdsPolicy must block a payout confirm WITHOUT
   * breaking unrelated settings reads (conversionRate/channels/visibility) for the tenant.
   */
  async resolveTdsPolicy(clientId: string): Promise<TdsPolicySettings> {
    const row = await this.prisma.programSetting.findUnique({
      where: { clientId_settingKey: { clientId, settingKey: 'tdsPolicy' } },
      select: { settingValue: true },
    });
    if (!row) return { ...this.defaults().tdsPolicy }; // absent → default-on default
    return this.validateTdsPolicy(row.settingValue); // present → strict (throws on malformed)
  }

  /**
   * Resolve the per-tenant MSG91 template id for an OTP purpose, or `undefined` to fall
   * back to the global env template (MSG91_OTP_TEMPLATE_ID). Returns `undefined` when:
   *   - clientId is falsy (e.g. pre-auth login before the tenant is known), OR
   *   - the tenant has no non-empty override for that purpose.
   * NEVER throws — a settings read failure resolves to `undefined` so the send site
   * transparently uses the global template rather than failing the OTP.
   */
  async getOtpTemplateId(
    clientId: string | undefined | null,
    purpose: OtpTemplatePurpose,
  ): Promise<string | undefined> {
    if (!clientId) return undefined;
    try {
      const settings = await this.getEffectiveSettings(clientId);
      const tpl = settings.otpTemplates[purpose]?.trim();
      return tpl ? tpl : undefined;
    } catch (e) {
      // getEffectiveSettings already fails-soft to defaults, but belt-and-braces: any
      // unexpected throw here must fall back to the global template, never break the send.
      this.logger.warn(`getOtpTemplateId(${clientId}, ${purpose}) failed; using env template: ${e}`);
      return undefined;
    }
  }

  /**
   * UNCACHED read of the visibility master switch — used by the visibility gate.
   *
   * The 5-min in-memory cache above is per-instance and only busted on the instance
   * that served the write. With multiple Cloud Run instances that makes a tenant
   * OFF→ON / ON→OFF flip eventually-consistent (up to CACHE_TTL_MS) across the fleet —
   * unacceptable for a switch sold as an immediate enable/kill control. visibilityEnabled
   * is NOT on the money hot path (only conversionRate is), and visibility endpoints are
   * low-traffic, so we read the single program_settings row directly every time. Fails
   * CLOSED: any read error, a missing row, or a non-boolean value → false (OFF).
   */
  async getVisibilityEnabledUncached(clientId: string): Promise<boolean> {
    try {
      const row = await this.prisma.programSetting.findUnique({
        where: { clientId_settingKey: { clientId, settingKey: 'visibilityEnabled' } },
        select: { settingValue: true },
      });
      return row?.settingValue === true;
    } catch (e) {
      this.logger.warn(`visibilityEnabled read failed for ${clientId}; treating as OFF: ${e}`);
      return false;
    }
  }

  /**
   * UNCACHED read of the Points Engine flags — used by the direct-credit MONEY gate (commitCompute).
   *
   * Same rationale as getVisibilityEnabledUncached: directCreditEnabled turns a wallet-crediting path
   * on/off, so a Gifsy "turn it off" must take effect immediately fleet-wide; the 5-min per-instance
   * cache would leave the capability live on stale instances for up to CACHE_TTL_MS. Reads the single
   * `pointsEngine` row directly. Fails CLOSED (both false) on an absent row, a read error, or a
   * non-object value; each flag is true ONLY on a strict boolean `true`.
   */
  async getPointsEngineFlagsUncached(
    clientId: string,
  ): Promise<{ enabled: boolean; directCreditEnabled: boolean }> {
    try {
      const row = await this.prisma.programSetting.findUnique({
        where: { clientId_settingKey: { clientId, settingKey: 'pointsEngine' } },
        select: { settingValue: true },
      });
      const v = row?.settingValue;
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        return { enabled: false, directCreditEnabled: false };
      }
      const rec = v as Record<string, unknown>;
      return { enabled: rec.enabled === true, directCreditEnabled: rec.directCreditEnabled === true };
    } catch (e) {
      this.logger.warn(`pointsEngine flags read failed for ${clientId}; treating as OFF: ${e}`);
      return { enabled: false, directCreditEnabled: false };
    }
  }

  /**
   * UNCACHED read of the points engine "first live month" (YYYY-MM or null) — the imported-months MONEY gate on export /
   * direct credit. A read error fails SAFE for money: the guard cannot be proven absent, so it throws (the export /
   * credit is refused with a retry message) rather than silently skipping the guard.
   */
  async getPointsEngineFirstLiveMonthUncached(clientId: string): Promise<string | null> {
    const row = await this.prisma.programSetting.findUnique({
      where: { clientId_settingKey: { clientId, settingKey: 'pointsEngine' } },
      select: { settingValue: true },
    });
    const v = row?.settingValue;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const m = (v as Record<string, unknown>).firstLiveMonth;
    return typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m) ? m : null;
  }

  /**
   * UNCACHED read of the GSTIN-compulsory switch — used by the KYC create/submit guard.
   *
   * Same rationale as getVisibilityEnabledUncached: the 5-min per-instance cache would leave an
   * OFF→ON tightening eventually-consistent across the fleet (a blank-GST submission could slip
   * through on a stale instance for up to CACHE_TTL_MS right after the compliance control is
   * turned on). KYC submits are low-traffic, so read the single row directly. Fails toward the
   * SAFE state (compulsory = true): an absent row, a read error, or anything but a strict
   * boolean `false` → true. Only an explicit boolean `false` turns the requirement OFF.
   */
  async getKycGstinRequiredUncached(clientId: string): Promise<boolean> {
    try {
      const row = await this.prisma.programSetting.findUnique({
        where: { clientId_settingKey: { clientId, settingKey: 'kycGstinRequired' } },
        select: { settingValue: true },
      });
      return row?.settingValue === false ? false : true;
    } catch (e) {
      this.logger.warn(`kycGstinRequired read failed for ${clientId}; treating as REQUIRED: ${e}`);
      return true;
    }
  }

  /**
   * UNCACHED read of the POINTS-reversal pause switch (owner Q5). Absent row ⇒ not paused; `{ paused: false }` ⇒ not
   * paused; `{ paused: true, … }` ⇒ paused; anything else ⇒ paused + `malformed` (fail closed). Pass the caller's
   * `tx` when the caller holds row locks — reading on this service's own client would take a SECOND pool connection
   * while the first is held, and ≥ pool-size concurrent lock holders then starve each other (WP7 pool test).
   */
  async getPointsReversalPauseUncached(clientId: string, db: SettingsReader = this.prisma): Promise<PointsReversalPause> {
    const row = await db.programSetting.findUnique({
      where: { clientId_settingKey: { clientId, settingKey: POINTS_REVERSAL_PAUSE_SETTING_KEY } },
      select: { settingValue: true },
    });
    return parsePointsReversalPause(row ? row.settingValue : undefined);
  }

  /**
   * UNCACHED read of the upload-deductions switch — the MONEY gate of createBatch / confirmBatch / the deduction
   * preview (same rationale as getVisibilityEnabledUncached: a Gifsy "turn it off" must apply fleet-wide at once).
   * Fails CLOSED: only a strict boolean `true` is ON; an absent row, a read error or any other value → OFF. Called
   * only when a batch actually carries a negative row, so an ordinary upload makes no extra read.
   */
  async getCreditUploadNegativeDeductionsUncached(clientId: string): Promise<boolean> {
    try {
      const row = await this.prisma.programSetting.findUnique({
        where: { clientId_settingKey: { clientId, settingKey: CREDIT_UPLOAD_NEGATIVE_DEDUCTIONS_KEY } },
        select: { settingValue: true },
      });
      return row?.settingValue === true;
    } catch (e) {
      this.logger.warn(`${CREDIT_UPLOAD_NEGATIVE_DEDUCTIONS_KEY} read failed for ${clientId}; treating as OFF: ${e}`);
      return false;
    }
  }

  /** Bust the cache for a tenant — called by AdminCoreService.upsertSetting after a write. */
  invalidate(clientId: string): void {
    this.cache.delete(clientId);
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /** Overlay persisted rows onto typed defaults with per-key validation + deep-merge. */
  private overlay(
    base: EffectiveSettings,
    rows: { settingKey: string; settingValue: unknown }[],
  ): EffectiveSettings {
    const out: EffectiveSettings = {
      ...base,
      redemptionChannels: { ...base.redemptionChannels },
      salesApp:           { ...base.salesApp },
      creditsPayouts:     { ...base.creditsPayouts },
      otpTemplates:       { ...base.otpTemplates },
      uniquenessPolicy:   { ...base.uniquenessPolicy },
      pointsEngine:       { ...base.pointsEngine },
      visibilityConfig: {
        ...base.visibilityConfig,
        // Copy the arrays + nested geoFence — never share the reference held by the cached default.
        outletScope:        [...base.visibilityConfig.outletScope],
        allowedSalesLevels: [...base.visibilityConfig.allowedSalesLevels],
        geoFence:           { ...base.visibilityConfig.geoFence },
        programs:           [...base.visibilityConfig.programs],
        subPrograms:        [...base.visibilityConfig.subPrograms],
        ...(base.visibilityConfig.salesPhotoViewLevels
          ? { salesPhotoViewLevels: [...base.visibilityConfig.salesPhotoViewLevels] }
          : {}),
      },
      tdsPolicy:          { ...base.tdsPolicy },
    };

    for (const row of rows) {
      const key = row.settingKey as SettingKey;
      const v = row.settingValue;
      switch (key) {
        case 'conversionRate': {
          const n = this.num(v);
          // Reject <= 0 (div-by-zero) AND rates too small for the centi snapshot (< 0.005),
          // which would defeat the rate-freeze; keep the default in both cases.
          if (n != null && n >= TenantSettingsService.MIN_RATE) out.conversionRate = n;
          break;
        }
        case 'minBankTransferAmount': {
          const n = this.num(v);
          if (n != null && n >= 0) out.minBankTransferAmount = n;
          break;
        }
        case 'minVoucherFreeAmount': {
          const n = this.num(v);
          if (n != null && n >= 0) out.minVoucherFreeAmount = n;
          break;
        }
        case 'paceAmberThreshold': {
          const n = this.num(v);
          if (n != null && n >= 0) out.paceAmberThreshold = n;
          break;
        }
        case 'visibilityEnabled': {
          if (typeof v === 'boolean') out.visibilityEnabled = v;
          break;
        }
        case 'kycGstinRequired': {
          if (typeof v === 'boolean') out.kycGstinRequired = v;
          break;
        }
        case 'redemptionChannels': {
          if (this.isObj(v)) {
            out.redemptionChannels = {
              physicalGifts: this.bool(v.physicalGifts, base.redemptionChannels.physicalGifts),
              vouchers:      this.bool(v.vouchers,      base.redemptionChannels.vouchers),
              bankTransfer:  this.bool(v.bankTransfer,  base.redemptionChannels.bankTransfer),
            };
          }
          break;
        }
        case 'uniquenessPolicy': {
          if (this.isObj(v)) {
            out.uniquenessPolicy = {
              gst:   this.bool(v.gst,   base.uniquenessPolicy.gst),
              phone: this.bool(v.phone, base.uniquenessPolicy.phone),
              bank:  this.bool(v.bank,  base.uniquenessPolicy.bank),
              upi:   this.bool(v.upi,   base.uniquenessPolicy.upi),
            };
          }
          break;
        }
        case 'salesApp': {
          if (this.isObj(v)) {
            out.salesApp = {
              ledgerLabel: typeof v.ledgerLabel === 'string' && v.ledgerLabel.trim()
                ? v.ledgerLabel : base.salesApp.ledgerLabel,
              upiEnabled: this.bool(v.upiEnabled, base.salesApp.upiEnabled),
              upiManualEntry: this.bool(v.upiManualEntry, base.salesApp.upiManualEntry),
            };
          }
          break;
        }
        case 'creditsPayouts': {
          if (this.isObj(v)) {
            const d = base.creditsPayouts;
            out.creditsPayouts = {
              monthCutoffDay:  this.dayOr(v.monthCutoffDay,  d.monthCutoffDay),
              // Floor the caps at 1: a stored 0 (only reachable via a raw settings PUT that
              // bypasses the admin card's FE validation) would make `amount > cap` reject EVERY
              // credited row → silently freeze all credit uploads for the tenant. Never < 1.
              safetyCapPoints: Math.max(1, this.numOr(v.safetyCapPoints, d.safetyCapPoints)),
              safetyCapInr:    Math.max(1, this.numOr(v.safetyCapInr,    d.safetyCapInr)),
              fourEyesEnabled: this.bool(v.fourEyesEnabled,  d.fourEyesEnabled),
              notifyEmails:    Array.isArray(v.notifyEmails)
                // Drop empties/whitespace so a `[""]` can't silently swallow the batch-confirm
                // notification (it would skip the ops@ fallback yet send to nobody).
                ? v.notifyEmails.filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
                // Copy the default array — never share the reference held by the cached entry.
                : [...d.notifyEmails],
            };
          }
          break;
        }
        case 'otpTemplates': {
          if (this.isObj(v)) {
            const d = base.otpTemplates;
            // Each field is a trimmed string; a non-string / missing value → '' (use env template).
            out.otpTemplates = {
              login:           this.str(v.login,           d.login),
              redemptionSelf:  this.str(v.redemptionSelf,  d.redemptionSelf),
              kycConsent:      this.str(v.kycConsent,       d.kycConsent),
              redemptionSales: this.str(v.redemptionSales, d.redemptionSales),
            };
          }
          break;
        }
        case 'outletPrograms': {
          // Replace-whole list. A non-array OR an empty (post-clean) list keeps the default,
          // so a tenant can never lock itself out of all outlet uploads.
          out.outletPrograms = this.stringList(v, base.outletPrograms);
          break;
        }
        case 'outletCategories': {
          out.outletCategories = this.stringList(v, base.outletCategories);
          break;
        }
        case 'visibilityConfig': {
          // REPLACE-WHOLE nested key: a stored object rebuilds the complete block from
          // defaults, so a partial/malformed PUT still yields a valid, complete config.
          if (this.isObj(v)) {
            const d = base.visibilityConfig;
            const geo = this.isObj(v.geoFence) ? v.geoFence : {};
            // Sales photo view: present ONLY when a non-empty list is stored (absent = OFF, byte-identical).
            const photoLevels = this.stringList(v.salesPhotoViewLevels, []);
            out.visibilityConfig = {
              // Code allow-lists: dedupe/trim, but ALLOW empty here (empty scope just means
              // "no outlets in scope yet") — so pass [] as the fallback, not the default.
              outletScope:        this.stringList(v.outletScope,        []),
              allowedSalesLevels: this.stringList(v.allowedSalesLevels, []),
              // Frequency = integer 1..4 else default (1).
              frequencyPerMonth:  this.intInRange(v.frequencyPerMonth, 1, 4, d.frequencyPerMonth),
              geoFence: {
                enabled:      this.bool(geo.enabled, d.geoFence.enabled),
                // Radius = positive integer 1..5000 else default (50).
                radiusMeters: this.intInRange(geo.radiusMeters, 1, 5000, d.geoFence.radiusMeters),
              },
              // APPLIES-TO narrowing: empty = ALL. An older stored config without these keys → [].
              programs:           this.stringList(v.programs,    []),
              subPrograms:        this.stringList(v.subPrograms, []),
              ...(photoLevels.length ? { salesPhotoViewLevels: photoLevels } : {}),
            };
          }
          break;
        }
        case 'pointsEngine': {
          // REPLACE-WHOLE nested key: rebuild the complete block from defaults so a
          // partial/malformed PUT still yields a valid, complete config. Both switches
          // default FALSE. No enforcement here — this is the reader/default only (Wave 0).
          if (this.isObj(v)) {
            out.pointsEngine = {
              enabled:             this.bool(v.enabled,             base.pointsEngine.enabled),
              directCreditEnabled: this.bool(v.directCreditEnabled, base.pointsEngine.directCreditEnabled),
              firstLiveMonth:      typeof v.firstLiveMonth === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v.firstLiveMonth) ? v.firstLiveMonth : null,
            };
          }
          break;
        }
        case CREDIT_UPLOAD_NEGATIVE_DEDUCTIONS_KEY: {
          out.creditUploadNegativeDeductions = v === true;
          break;
        }
        case 'tdsPolicy': {
          // getEffectiveSettings must stay robust for EVERY consumer — this is the cached,
          // broad, hot-path read. A malformed tdsPolicy here falls back to the default for the
          // (informational) effective-settings view rather than throwing and taking down
          // conversionRate/channels/visibility for the tenant. The MONEY path does not use this
          // value: the payout engine calls resolveTdsPolicy(), which strict-validates + fails
          // closed. So the tax-safety guarantee is preserved, scoped to where it matters.
          try {
            out.tdsPolicy = this.validateTdsPolicy(v);
          } catch (e) {
            this.logger.warn(
              `malformed tdsPolicy in effective-settings view; showing default (payout confirm still fails closed via resolveTdsPolicy): ${e}`,
            );
          }
          break;
        }
        default:
          break; // unknown key — ignore (admin settings store holds other keys too)
      }
    }

    // Fix B — manual UPI entry forces UPI uniqueness even when the policy flag is off: a
    // hand-typed VPA can collide, so dedup must run. QR-only tenants are unaffected. Placed
    // after the loop so out.salesApp and out.uniquenessPolicy are both final regardless of row order.
    // Snapshot the STORED policy first so the admin UI can show/save it without writing back
    // the derived value.
    out.uniquenessPolicyStored = { ...out.uniquenessPolicy };
    out.uniquenessPolicy.upi = out.uniquenessPolicy.upi || out.salesApp.upiManualEntry;

    return out;
  }

  /**
   * Validate a stored tdsPolicy value against the exact Prisma enum literals. Returns the
   * typed policy or THROWS (BadRequestException) — deliberately fail-closed for the money
   * path: a bad value must surface loudly, never resolve to a silent default. Only reached
   * when a tdsPolicy row is actually present (an absent key keeps the default).
   */
  private validateTdsPolicy(v: unknown): TdsPolicySettings {
    if (!this.isObj(v)) {
      throw new BadRequestException('tdsPolicy must be an object { section, methodology }.');
    }
    const validSections = Object.values(TdsSection) as string[];
    const validMethodologies = Object.values(TdsMethodology) as string[];
    const { section, methodology } = v;
    if (typeof section !== 'string' || !validSections.includes(section)) {
      throw new BadRequestException(
        `tdsPolicy.section must be one of ${validSections.join(', ')} (got ${JSON.stringify(section)}).`,
      );
    }
    if (typeof methodology !== 'string' || !validMethodologies.includes(methodology)) {
      throw new BadRequestException(
        `tdsPolicy.methodology must be one of ${validMethodologies.join(', ')} (got ${JSON.stringify(methodology)}).`,
      );
    }
    return { section: section as TdsSection, methodology: methodology as TdsMethodology };
  }

  /**
   * Validate a stored value as a non-empty string list for the outlet allow-lists:
   * trim each entry, drop blanks, DEDUPE (case-sensitive, order-preserving). If the value is
   * not an array, or reduces to an empty list, return the (copied) fallback default — a tenant
   * must never end up with an empty allow-list. Never shares the fallback array reference.
   */
  private stringList(v: unknown, fallback: string[]): string[] {
    if (!Array.isArray(v)) return [...fallback];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of v) {
      if (typeof item !== 'string') continue;
      const t = item.trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
    return out.length > 0 ? out : [...fallback];
  }

  private num(v: unknown): number | null {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
    return Number.isFinite(n) ? n : null;
  }
  private numOr(v: unknown, fallback: number): number {
    const n = this.num(v);
    return n != null && n >= 0 ? n : fallback;
  }
  /** A day-of-month (1..31); anything out of range falls back to the default. */
  private dayOr(v: unknown, fallback: number): number {
    const n = this.num(v);
    return n != null && n >= 1 && n <= 31 ? Math.floor(n) : fallback;
  }
  /**
   * An integer clamped to an inclusive [min,max] range: floors a finite numeric value and
   * accepts it only if it lands within [min,max]; otherwise returns the fallback default.
   * (Used by visibilityConfig for frequencyPerMonth 1..4 and geoFence.radiusMeters 1..5000.)
   */
  private intInRange(v: unknown, min: number, max: number, fallback: number): number {
    const n = this.num(v);
    if (n == null) return fallback;
    const i = Math.floor(n);
    return i >= min && i <= max ? i : fallback;
  }
  private bool(v: unknown, fallback: boolean): boolean {
    return typeof v === 'boolean' ? v : fallback;
  }
  /** A trimmed string; a non-string / missing value falls back to the default (usually ''). */
  private str(v: unknown, fallback: string): string {
    return typeof v === 'string' ? v.trim() : fallback;
  }
  private isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  }
}

/** PURE parser of the `pointsReversalApprovalsPaused` value (see getPointsReversalPauseUncached). */
export function parsePointsReversalPause(v: unknown): PointsReversalPause {
  const off: PointsReversalPause = { paused: false, since: null, by: null, reason: null };
  if (v === undefined || v === null) return off;
  if (typeof v === 'object' && !Array.isArray(v)) {
    const r = v as Record<string, unknown>;
    const str = (x: unknown) => (typeof x === 'string' && x.trim() ? x : null);
    if (r.paused === false) return off;
    if (r.paused === true) return { paused: true, since: str(r.since), by: str(r.by), reason: str(r.reason) };
  }
  return { paused: true, since: null, by: null, reason: `unreadable setting value ${JSON.stringify(v)}`, malformed: true };
}
