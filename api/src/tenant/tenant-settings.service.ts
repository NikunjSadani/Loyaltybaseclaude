import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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

export interface RedemptionChannels {
  physicalGifts: boolean;
  vouchers:      boolean;
  bankTransfer:  boolean;
}

export interface SalesAppSettings {
  ledgerLabel:              string;
  redeemGiftWholesalerOnly: boolean;
}

export interface CreditsPayoutsSettings {
  monthCutoffDay:  number;
  safetyCapPoints: number;
  safetyCapInr:    number;
  /** DEFERRED to post-go-live — stored but not enforced; the toggle is hidden in the UI. */
  fourEyesEnabled: boolean;
  notifyEmails:    string[];
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
  /** Whether the sales app may submit visibility photos. */
  visibilityPhotoEnabled: boolean;
  /**
   * Per-tenant MASTER switch for the whole Visibility module (photo-approval AND
   * amount-upload paths). When false, every visibility endpoint returns 403 and the
   * FE hides all visibility surfaces. Default is FALSE (opt-in) — a tenant must be
   * explicitly turned ON in the Gifsy Settings panel. Distinct from (and above) both
   * `visibilityPhotoEnabled` and the ClientConfig `visibilityCaptureMode` selector,
   * and from the per-outlet-type `OutletTypeClientConfig.visibilityEnabled` column.
   */
  visibilityEnabled:      boolean;
  redemptionChannels:     RedemptionChannels;
  salesApp:               SalesAppSettings;
  creditsPayouts:         CreditsPayoutsSettings;
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
  | 'visibilityPhotoEnabled'
  | 'visibilityEnabled'
  | 'redemptionChannels'
  | 'salesApp'
  | 'creditsPayouts';

const NESTED_KEYS: ReadonlySet<SettingKey> = new Set([
  'redemptionChannels',
  'salesApp',
  'creditsPayouts',
]);

@Injectable()
export class TenantSettingsService {
  private readonly logger = new Logger(TenantSettingsService.name);

  private cache = new Map<string, { settings: EffectiveSettings; cachedAt: number }>();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes; also busted on write

  constructor(private readonly prisma: PrismaService) {}

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
      visibilityPhotoEnabled: false,
      // Master Visibility switch defaults OFF — visibility is opt-in per tenant
      // (owner decision 2026-06-25). A tenant must be turned ON in Gifsy Settings.
      visibilityEnabled:      false,
      redemptionChannels:     { physicalGifts: true, vouchers: true, bankTransfer: true },
      salesApp:               { ledgerLabel: 'Wallet', redeemGiftWholesalerOnly: true },
      creditsPayouts: {
        monthCutoffDay:  28,
        safetyCapPoints: 50000,
        safetyCapInr:    100000,
        fourEyesEnabled: false,
        notifyEmails:    [],
      },
    };
  }

  /** The full typed settings for a tenant (cached). */
  async getEffectiveSettings(clientId: string): Promise<EffectiveSettings> {
    const cached = this.cache.get(clientId);
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
        case 'visibilityPhotoEnabled': {
          if (typeof v === 'boolean') out.visibilityPhotoEnabled = v;
          break;
        }
        case 'visibilityEnabled': {
          if (typeof v === 'boolean') out.visibilityEnabled = v;
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
        case 'salesApp': {
          if (this.isObj(v)) {
            out.salesApp = {
              ledgerLabel: typeof v.ledgerLabel === 'string' && v.ledgerLabel.trim()
                ? v.ledgerLabel : base.salesApp.ledgerLabel,
              redeemGiftWholesalerOnly:
                this.bool(v.redeemGiftWholesalerOnly, base.salesApp.redeemGiftWholesalerOnly),
            };
          }
          break;
        }
        case 'creditsPayouts': {
          if (this.isObj(v)) {
            const d = base.creditsPayouts;
            out.creditsPayouts = {
              monthCutoffDay:  this.dayOr(v.monthCutoffDay,  d.monthCutoffDay),
              safetyCapPoints: this.numOr(v.safetyCapPoints, d.safetyCapPoints),
              safetyCapInr:    this.numOr(v.safetyCapInr,    d.safetyCapInr),
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
        default:
          break; // unknown key — ignore (admin settings store holds other keys too)
      }
    }

    return out;
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
  private bool(v: unknown, fallback: boolean): boolean {
    return typeof v === 'boolean' ? v : fallback;
  }
  private isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  }
}
