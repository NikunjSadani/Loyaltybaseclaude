import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { GiftFulfilmentChannel, PayoutMode, Prisma, RedemptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { problemRowsEcho } from '../common/upload-echo';
import { isFixedOtpAllowed } from '../common/fixed-otp';
import { generateNumericOtp } from '../common/otp';
import { claimOtpAttempt, markOtpUsed, refundOtpAttempt, whyOtpClaimRefused } from '../common/otp-attempt';
import { ensureOutletAccount } from '../common/reward-account.helper';
import { WalletService } from '../wallet/wallet.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Msg91Service } from '../notifications/msg91.service';
import { captureOtpDeliveryHandle } from '../notifications/otp-delivery';
import { EventKey } from '../notification-templates/notification-templates.config';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { resolveEffectiveKycStatus, isPartnerPayable } from '../kyc/kyc-eligibility';
import { resolveActivePartnerId } from '../common/partner-group.helper';
import { isLoyaltyEnabledForPartner } from '../common/loyalty-eligibility';
import { isSalesRedeemEnabledForPartner } from '../common/sales-redeem-eligibility';
import { isGifsyOperator, isTenantAdmin, tenantScope } from '../common/tenant-scope';
import { GifsyRoleService } from '../common/rbac/gifsy-role.service';
import { descendantSalesUserIds } from '../sales/sales-hierarchy-access.helper';
import { NOT_PARKED_OUTLET } from '../sales/sales.service';
import { generateTenantOrderNumber } from './order-number.helper';
import {
  noIssuedVoucherGuard,
  VOUCHER_ISSUED_REFUND_BLOCK_MESSAGE,
  hasIssuedVoucher,
  supersedePendingOrders,
  transitionOrderStatus,
  transitionOrderStatusOrConflict,
} from './order-status-transition';
import {
  canFillStoredVoucher,
  combineGuards,
  hasHubbleMarkers,
  hashVoucherCode,
  assertVoucherCodeReusableInTx,
  lockVoucherCode,
  isHubbleIssuedCode,
  isHubbleNeverPlaced,
  planVoucherWrite,
  rethrowUnlessIdempotentPinRace,
  VOUCHER_WRITE_CONFLICT_MESSAGE,
  VoucherWriteOptions,
  withPinRaceRetry,
} from './voucher-write-guard';
import {
  notifyVoucherIssued as notifyVoucherIssuedShared,
  maskVoucherCodeForAudit,
  programLabelFor,
  recordVoucherIssuedAudit,
} from './voucher-issuance';
import { derivePointsCost } from './derive-points-cost.helper';
import { computeFrozenValuePaise } from './gift-value.helper';
import { computeDispatchSla } from '../common/dispatch-sla';
import { loadHolidaySet } from '../common/holiday-calendar';
import { istDayRangeFilter } from '../common/ist-date';
import {
  AdminListCatalogQueryDto,
  CreateRewardCatalogDto,
  CreateRewardCategoryDto,
  FulfilmentOrdersQueryDto,
  FulfilmentTemplateQueryDto,
  ListCatalogQueryDto,
  ListOrdersQueryDto,
  RedeemConfirmDto,
  RedeemDto,
  SalesRedeemConfirmDto,
  SalesRedeemDto,
  TransitionOrderDto,
  UpdatableOrderStatus,
  UpdateOrderDto,
  UpdateRewardCatalogDto,
  UpdateRewardCategoryDto,
} from './dto/rewards.dto';
import {
  buildFulfilmentTemplateBuffer,
  parseFulfilmentUploadBuffer,
} from './rewards-fulfilment.helpers';
import {
  HubbleNotConfiguredError,
  HubbleOrderResult,
  HubbleProduct,
  HubbleProductNotFoundError,
  HubbleService,
  HubbleVoucher,
} from '../hubble/hubble.service';
import {
  extractHubbleDenominations,
  isAmountIssuable,
  memberHubbleFields,
  normaliseHubbleDenominations,
  validateHubbleItemAmounts,
} from './hubble-catalog.helpers';

/**
 * Rewards & Redemption — ported from platform/src/app/api/rewards/* onto /v1.
 * Tenant-scoped by clientId (from the session-bound JWT); non-GIFSY callers
 * see/act on only their own partner's catalog affordability and orders. Business
 * logic lives here; the controller is a thin HTTP adapter.
 *
 * 5.4a CORE redemption pipeline (now ported): redeem → OTP confirm → guarded
 * fulfilment transition. The points debit/refund composes WalletService (which
 * owns the canonical wallet invariant + PointsLedger) inside this service's own
 * $transaction; the REDEMPTION_CONFIRM OTP reuses the OtpCode model; confirm +
 * status events enqueue via NotificationsService.
 */
/**
 * Default dispatch-SLA budget (BUSINESS hours) for self-fulfilled channels
 * (GIFSY_WAREHOUSE / BRAND). Amazon / DIGITAL_VOUCHER are exempt (see dispatch-sla.ts).
 * A single platform default in v1 — a per-channel/per-tenant config is a later addition.
 */
export const DISPATCH_SLA_BUSINESS_HOURS = 48;

/**
 * DPDP consent version stamped on a VENDOR-sourced redemption (decision #15). Bump
 * this whenever the consent wording changes so each order records WHICH version of
 * the "share my delivery details with the fulfilment partner" statement the member
 * agreed to (demonstrable, versioned consent). Kept as a single platform string in
 * v1; the exact legal wording is an owner/legal deliverable.
 */
export const VENDOR_PII_CONSENT_VERSION = 'v1-2026-08';

/**
 * Opaque keyset cursor for listOrders — base64url of `<createdAt ISO>|<id>` (the same
 * encoding the notifications feed uses). Decode returns null for anything malformed.
 */
export function encodeOrderCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

/**
 * Mask a voucher code for an audit row / app log: "••••" + the last 4 characters only for a code
 * of 12+ chars (the tail is then at most a third of it); a shorter code is fully masked so it can
 * never be reconstructed from the hint. Never reversible. ONE rule — delegates to
 * maskVoucherCodeForAudit (voucher-issuance.ts).
 */
export function maskVoucherCode(code: string): string {
  return maskVoucherCodeForAudit(code);
}

/**
 * The order-read projection for a viewer who must NOT see a voucher code: no character of it,
 * only whether one is issued. Spread over the row (overrides voucherCode).
 */
export function hiddenVoucherFields(code: string | null | undefined): {
  voucherCode: null;
  voucherPin: null;
  voucherIssued: boolean;
  voucherCodeMasked: boolean;
} {
  const issued = code != null && code !== '';
  // The PIN is hidden exactly like the code (no character, no "has PIN" hint).
  return { voucherCode: null, voucherPin: null, voucherIssued: issued, voucherCodeMasked: issued };
}

/** Sales hierarchy roles (mirrors rewards.controller SALES_ROLES). */
const SALES_VIEWER_ROLES: ReadonlySet<string> = new Set([
  'SALES_HO',
  'SALES_STATE_HEAD',
  'SALES_ASM',
  'SALES_SO',
  'SALES_ISR',
]);

/**
 * OWNER RULE: a sales rep NEVER sees a voucher card number or PIN, on ANY route — even if their
 * login were ever to resolve to a partner. The bearer credential belongs to the outlet owner only.
 */
export function isSalesViewer(role: string | null | undefined): boolean {
  return !!role && SALES_VIEWER_ROLES.has(role);
}

/**
 * The member-facing credentials of a Hubble voucher:
 *  - code = card number if present, else the PIN (a PIN-only card's PIN IS its code);
 *  - pin  = the PIN ONLY when BOTH a card number and a PIN are present (card+PIN products such as
 *           CARD_AND_PIN_NO_SECURED) — otherwise null (number-only / PIN-only: unchanged).
 * Values are trimmed; blank counts as absent.
 */
export function hubbleVoucherCredentials(voucher: HubbleVoucher | undefined | null): {
  code: string | null;
  pin: string | null;
} {
  if (!voucher) return { code: null, pin: null };
  const num = (voucher.cardNumber ?? '').toString().trim();
  const pin = (voucher.cardPin ?? '').toString().trim();
  return { code: num || pin || null, pin: num && pin ? pin : null };
}

/** Operator-console projection of an order's Hubble reconcile state (from metadata). */
export function hubbleReconcileFlags(metadata: unknown): {
  hubbleNeedsReconcile: boolean;
  hubbleReconcileReason: string | null;
} {
  const m = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
  // A manual override sets hubbleNeedsReconcile false; a LATER flag (e.g. Hubble succeeded on top
  // of the manual code) sets it true again and must surface.
  const needs = m.hubbleNeedsReconcile === true;
  return {
    hubbleNeedsReconcile: needs,
    hubbleReconcileReason: needs && typeof m.hubbleReconcileReason === 'string' ? m.hubbleReconcileReason : null,
  };
}

export function decodeOrderCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = raw.indexOf('|');
    if (sep < 0) return null;
    const createdAt = new Date(raw.slice(0, sep));
    const id = raw.slice(sep + 1);
    if (Number.isNaN(createdAt.getTime()) || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/**
 * Member-catalogue VENDOR visibility filter (review CRITICAL #2 — the suspend/revoke
 * cascade). A PLATFORM row is always visible; a VENDOR row is visible ONLY while its
 * Vendor is ACTIVE and holds an ACTIVE VendorTenantGrant for this tenant. Because the
 * predicate lives on every member read/redeem path, suspending a vendor or revoking
 * its grant DYNAMICALLY hides its items and blocks their redemption with no sweep.
 */
export function vendorVisibilityFilter(clientId: string): Prisma.RewardCatalogWhereInput {
  return {
    OR: [
      { sourceType: 'PLATFORM' },
      {
        sourceType: 'VENDOR',
        vendor: {
          is: {
            status: 'ACTIVE',
            grants: { some: { clientId, status: 'ACTIVE' } },
          },
        },
      },
    ],
  };
}

/**
 * Member-safe RewardCatalog projection for the partner-facing catalogue reads
 * (listCatalog / getCatalogItem). Deliberately EXCLUDES ops/internal columns —
 * sellingValuePaise (194R/cost basis), sourceType, vendorId, giftMasterId,
 * giftCategoryId and the moderation* fields — that a member must never see.
 *
 * SECURITY (cost-basis inference leak, review HIGH): `mrpPaise` is ALSO excluded here.
 * It is no longer needed FE-side (the slash is server-computed) and, shipped next to the
 * public `pointsCost` + a derived `slashPoints`, it lets a member solve back the hidden
 * cost basis: sellingValuePaise ≈ pointsCost × mrpPaise / slashPoints. The slash paths
 * select `mrpPaise` + `sellingValuePaise` TRANSIENTLY (flag-gated) to compute slashPoints,
 * then strip BOTH — the member only ever receives (pointsCost, slashPoints), from which the
 * absolute cost basis is unrecoverable (one equation, two unknowns).
 */
const MEMBER_CATALOG_SELECT = {
  id: true,
  code: true,
  name: true,
  description: true,
  imageUrls: true,
  pointsCost: true,
  redemptionMode: true,
  status: true,
  minRedemptionPoints: true,
  maxRedemptionPoints: true,
  stockQuantity: true,
  termsAndConditions: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
  category: { select: { name: true, sortOrder: true } },
} satisfies Prisma.RewardCatalogSelect;

/**
 * Member-safe RedemptionOrder projection for the partner-facing order reads
 * (listOrders / getOrder member path). EXCLUDES the ops-only fulfilment fields
 * (fulfilmentChannel, supplierOrderRef, fulfilledByVendorId, podUrl, notes) and the
 * BigInt valuePaise. partnerId is included for the caller-ownership authorization
 * check (it is the member's own partner, not an ops-only field).
 */
const MEMBER_ORDER_SELECT = {
  id: true,
  partnerId: true,
  orderNumber: true,
  status: true,
  redemptionMode: true,
  totalPointsCost: true,
  quantity: true,
  voucherCode: true,
  voucherPin: true,
  voucherProvider: true,
  trackingNumber: true,
  trackingUrl: true,
  logisticsPartner: true,
  dispatchedAt: true,
  deliveredAt: true,
  cancelledAt: true,
  createdAt: true,
  updatedAt: true,
  deliveryName: true,
  deliveryPhone: true,
  deliveryAddressLine1: true,
  deliveryAddressLine2: true,
  deliveryCity: true,
  deliveryState: true,
  deliveryPincode: true,
  reward: { select: { id: true, name: true, imageUrls: true, redemptionMode: true } },
  partner: { select: { id: true, businessName: true } },
} satisfies Prisma.RedemptionOrderSelect;

/**
 * The RedemptionOrder shape the Hubble auto-issuance helpers operate on (a structural
 * subset of the full row loaded by RewardsService.loadHubbleOrder — extra columns are
 * fine). Keeps the money-path helpers strongly typed without threading Prisma generics.
 */
interface HubbleLoadedOrder {
  id: string;
  orderNumber: string;
  partnerId: string;
  status: RedemptionStatus;
  voucherCode: string | null;
  pointsDeducted: number;
  valuePaise: bigint | null;
  redemptionMode: PayoutMode;
  metadata: Prisma.JsonValue;
  /** Row version as loaded — the PROCESSING claim pins it (optional: test fixtures omit it). */
  updatedAt?: Date | null;
  reward: { metadata: Prisma.JsonValue } | null;
}

/** Statuses that prove an order got past OTP confirmation (points were deducted). */
const REACHED_CONFIRMED_STATUSES: RedemptionStatus[] = [
  RedemptionStatus.CONFIRMED,
  RedemptionStatus.PROCESSING,
  RedemptionStatus.DISPATCHED,
  RedemptionStatus.DELIVERED,
  RedemptionStatus.RETURNED,
  RedemptionStatus.FAILED,
];

/** Cap a problem-only error list at UPLOAD_ECHO_MAX_ROWS (memory-safety). */
function cappedFulfilmentErrors<T>(errors: T[]): { errors: T[]; errorsTruncated: boolean } {
  const e = problemRowsEcho(errors, () => true);
  return { errors: e.problemRows, errorsTruncated: e.problemRowsTruncated };
}

@Injectable()
export class RewardsService {
  private readonly logger = new Logger(RewardsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly tenantSettings: TenantSettingsService,
    private readonly notifications: NotificationsService,
    private readonly msg91: Msg91Service,
    private readonly hubble: HubbleService,
    // @Global RbacModule — always present in the app. @Optional only so unit-test modules that
    // don't wire it still construct; absent → staff is treated as NOT permitted (fail closed).
    @Optional() private readonly gifsyRoles?: GifsyRoleService,
  ) {}

  /**
   * May this OPERATOR see a full voucher code (a spendable bearer credential)? Only those who
   * fulfil orders: GIFSY_ADMIN, or GIFSY_STAFF whose resolved GifsyRole grants
   * rewards:manage_orders. Everyone else on an operator/admin read (CLIENT_ADMIN, read-only
   * staff) gets the "issued" indicator only. (The member's OWN orders are a separate path.)
   */
  private async canSeeFullVoucherCode(user: JwtPayload): Promise<boolean> {
    if (user.role === 'GIFSY_ADMIN') return true;
    if (user.role === 'GIFSY_STAFF' && this.gifsyRoles) {
      const perms = await this.gifsyRoles.getPermissions(user.gifsyRoleId);
      return perms.has('rewards:manage_orders');
    }
    return false;
  }

  private isGifsy(user: JwtPayload): boolean {
    // RBAC Option-X: GIFSY_STAFF (permission-gated) is a platform operator
    return isGifsyOperator(user);
  }

  /**
   * Data-boundary guard for the DISPATCH-CONSOLE-only reads (listFulfilmentOrders /
   * getFulfilmentOrder) — parity with GiftCatalogueService.assertOperator. The routes
   * are already @Roles('GIFSY_ADMIN') + @RequirePermission; this is defence-in-depth at
   * the service layer. NOT applied to the SHARED transitionOrder/updateOrder, which are
   * also reached by the legacy /rewards/orders GIFSY_ADMIN endpoints and the bulk
   * fulfilment upload — those keep their route-level gate to avoid over-constraining a
   * shared method.
   */
  private assertOperator(user: JwtPayload) {
    if (!isGifsyOperator(user)) {
      throw new ForbiddenException('Gift dispatch console is Gifsy-operator only');
    }
  }

  /** Map a redemption mode to the tenant channel toggle that governs it. */
  private channelKey(mode: PayoutMode): 'physicalGifts' | 'vouchers' | 'bankTransfer' {
    if (mode === 'PHYSICAL_GIFT') return 'physicalGifts';
    if (mode === 'UPI' || mode === 'BANK_TRANSFER') return 'bankTransfer';
    return 'vouchers'; // GIFT_CARD (the only remaining PayoutMode) maps to the voucher channel
  }

  /**
   * The points↔₹ centi-rate to use when freezing valuePaise at CONFIRM time.
   * Prefer the rate SNAPSHOT taken on the order at redeem (so an admin editing the
   * per-tenant rate between redeem and confirm cannot shift the TDS/payout value);
   * fall back to the live tenant rate for pre-migration orders (conversionRateCenti null).
   */
  private async confirmRateCenti(
    order: { conversionRateCenti: number | null },
    clientId: string,
  ): Promise<number> {
    if (order.conversionRateCenti != null && order.conversionRateCenti > 0) {
      return order.conversionRateCenti;
    }
    const live = await this.tenantSettings.getConversionRate(clientId);
    return Math.round(live * 100);
  }

  /** GET /v1/rewards/catalog — active catalog with per-item affordability vs the caller's wallet. */
  async listCatalog(user: JwtPayload, q: ListCatalogQueryDto, requestedPartnerId?: string) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.RewardCatalogWhereInput = {
      status: 'ACTIVE',
      deletedAt: null,
      clientId: user.clientId,
      // Gift Catalogue moderation gate (§4 / review): a PENDING/REJECTED/DRAFT item
      // must NEVER be browsable. Existing platform rows default APPROVED (live), so
      // Deoleo's catalogue is unchanged; vendor rows land PENDING until approved.
      moderationStatus: 'APPROVED',
      // WAVE-2 (review CRITICAL #2) — vendor visibility cascade. A VENDOR row is
      // browsable only while its Vendor is ACTIVE + holds an ACTIVE grant for this
      // tenant; PLATFORM rows are unaffected. Suspend/revoke hides items dynamically.
      ...vendorVisibilityFilter(user.clientId),
    };
    if (q.minPoints !== undefined || q.maxPoints !== undefined) {
      where.pointsCost = {};
      if (q.minPoints !== undefined) where.pointsCost.gte = q.minPoints;
      if (q.maxPoints !== undefined) where.pointsCost.lte = q.maxPoints;
    }

    // Affordability is measured against the ACTIVE partner's wallet (own by default,
    // or a switched sibling named by x-active-partner-id). resolveActive re-authorizes
    // the selector — a forbidden id throws before any balance is read.
    const activePartnerId = await this.resolveActive(user, requestedPartnerId);
    const wallet = activePartnerId
      ? await this.prisma.wallet.findFirst({ where: { partnerId: activePartnerId } })
      : null;
    const userBalance = wallet ? wallet.redeemablePoints : 0;

    // Per-outlet-type Loyalty gate (OutletTypeClientConfig.loyaltyEnabled) — server-enforced
    // (the FE gate is bypassable via a direct API call). When the active outlet's type has
    // Loyalty OFF, the catalogue is EMPTY (same response shape). Missing config → default true.
    if (
      activePartnerId &&
      !(await isLoyaltyEnabledForPartner(this.prisma, user.clientId, activePartnerId))
    ) {
      return {
        items: [],
        userBalance,
        pagination: { page, limit, total: 0, pages: 0 },
      };
    }

    // Per-tenant MRP-slash flag (default OFF, incl. Deoleo). When OFF we neither select the
    // cost-basis columns nor compute/emit slashPoints — the response is cost-basis-free.
    const mrpSlashEnabled = await this.isCatalogueMrpSlashEnabled(user.clientId);

    const [items, total] = await Promise.all([
      this.prisma.rewardCatalog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { pointsCost: 'asc' },
        // Member-safe projection — drops ops/internal columns (vendorId, giftMasterId,
        // giftCategoryId, moderation*, and mrpPaise — see MEMBER_CATALOG_SELECT). sourceType
        // is read to derive requiresConsent; mrpPaise + sellingValuePaise are selected
        // TRANSIENTLY only when the slash flag is ON (to compute slashPoints) and are BOTH
        // stripped below — the member never receives either cost-basis column.
        select: {
          ...MEMBER_CATALOG_SELECT,
          sourceType: true,
          // Read TRANSIENTLY to project the Hubble amount options; the raw blob is stripped below.
          metadata: true,
          ...(mrpSlashEnabled ? { mrpPaise: true, sellingValuePaise: true } : {}),
        },
      }),
      this.prisma.rewardCatalog.count({ where }),
    ]);

    const enriched = items.map((item) => {
      // Flatten the category relation to its label so the partner catalogue UI
      // can display/route by category (the FE expects a flat string, not the
      // nested relation the admin endpoint returns). Derive `requiresConsent`
      // (DPDP consent gate, decision #15) from sourceType, then DROP sourceType so
      // the raw source/vendor origin never reaches the member.
      // Compute the rate-INDEPENDENT MRP-slash (flag ON only) BEFORE stripping the cost basis,
      // then DROP BOTH mrpPaise and sellingValuePaise so neither reaches the member — only the
      // derived slashPoints does. When the flag is OFF the columns were not even selected.
      // Cast to a view with OPTIONAL cost-basis keys: they are present only under the
      // flag-ON select. Destructuring them by name strips BOTH from `rest` (the response)
      // whether or not they were selected (a no-op strip when absent).
      const row = item as typeof item & { mrpPaise?: number | null; sellingValuePaise?: number | null };
      const slashPoints = mrpSlashEnabled ? this.computeSlashPoints(row) : null;
      const { category, sourceType, metadata, mrpPaise: _mrp, sellingValuePaise: _sv, ...rest } = row;
      return {
        ...rest,
        category: category?.name,
        categorySort: category?.sortOrder ?? null,
        requiresConsent: sourceType === 'VENDOR',
        isAffordable: userBalance >= row.pointsCost,
        ...(mrpSlashEnabled ? { slashPoints } : {}),
        // Hubble "choose from amounts" items only ({} otherwise → non-Hubble response unchanged).
        ...memberHubbleFields(metadata, row.redemptionMode),
      };
    });

    return {
      items: enriched,
      userBalance,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  /** GET /v1/rewards/catalog/:id — a single active (non-deleted) catalog item in the tenant. */
  async getCatalogItem(user: JwtPayload, id: string, requestedPartnerId?: string) {
    // Per-tenant MRP-slash flag (default OFF). When OFF: no cost-basis select, no slashPoints.
    const mrpSlashEnabled = await this.isCatalogueMrpSlashEnabled(user.clientId);
    const item = await this.prisma.rewardCatalog.findFirst({
      // Moderation gate: a non-APPROVED item is not viewable even by deep-link/stale
      // cart. status=ACTIVE parity with listCatalog — a DISCONTINUED/OUT_OF_STOCK/
      // INACTIVE row must not be deep-linkable. WAVE-2 (review CRITICAL #2): a VENDOR
      // row also requires vendor ACTIVE + ACTIVE grant (suspend/revoke hides it).
      where: {
        id,
        deletedAt: null,
        clientId: user.clientId,
        status: 'ACTIVE',
        moderationStatus: 'APPROVED',
        ...vendorVisibilityFilter(user.clientId),
      },
      // Member-safe projection (same as listCatalog) — no ops/internal columns and no
      // mrpPaise by default. sourceType derives requiresConsent; mrpPaise + sellingValuePaise
      // are selected TRANSIENTLY only when the slash flag is ON (to compute slashPoints) and
      // are BOTH stripped below (cost-basis leak guard).
      select: {
        ...MEMBER_CATALOG_SELECT,
        sourceType: true,
        // Read TRANSIENTLY to project the Hubble amount options; the raw blob is stripped below.
        metadata: true,
        ...(mrpSlashEnabled ? { mrpPaise: true, sellingValuePaise: true } : {}),
      },
    });
    if (!item) throw new NotFoundException('Reward item not found');
    // The item is tenant-scoped (not partner-scoped), so the response is identical
    // regardless of the active outlet. We still re-authorize the selector so a bogus
    // x-active-partner-id is rejected consistently across every rewards endpoint
    // (never silently accepted on one read) — validation only, result unchanged.
    const activePartnerId = await this.resolveActive(user, requestedPartnerId);
    // Per-outlet-type Loyalty gate — when the active outlet's type has Loyalty OFF, no reward
    // item is available to it (parity with the not-found message so a deep link can't reveal
    // that the item exists). Missing config → default true (never hide on missing config).
    if (
      activePartnerId &&
      !(await isLoyaltyEnabledForPartner(this.prisma, user.clientId, activePartnerId))
    ) {
      throw new NotFoundException('Reward item not found or not available');
    }
    // Compute the rate-independent slash (flag ON only), then DROP sourceType AND both
    // cost-basis columns so the member never sees the raw origin OR the cost basis.
    const row = item as typeof item & { mrpPaise?: number | null; sellingValuePaise?: number | null };
    const slashPoints = mrpSlashEnabled ? this.computeSlashPoints(row) : null;
    const { sourceType, metadata, mrpPaise: _mrp, sellingValuePaise: _sv, ...rest } = row;
    return {
      item: {
        ...rest,
        requiresConsent: sourceType === 'VENDOR',
        ...(mrpSlashEnabled ? { slashPoints } : {}),
        ...memberHubbleFields(metadata, row.redemptionMode),
      },
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PERSISTENT PARTNER WISHLIST (member "save for later").
  //
  // Scoped EXACTLY like the partner-facing catalogue reads: the acting partner is
  // resolved through `resolveActive` (own by default, or an authorized switched
  // sibling named by x-active-partner-id — a bogus id throws 403 there), and every
  // wishlist row is tied to that resolved partnerId + the caller's clientId. A
  // rewardId that is not in the caller's own tenant is REJECTED on add (never
  // silently stored). An empty wishlist (every tenant at rest) is today's behaviour.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * GET /v1/rewards/wishlist — the CALLER's wishlisted items. Returns BOTH the
   * member-safe reward projection (same shape/fields as listCatalog, ops/internal
   * columns stripped) AND a plain `rewardIds` array, so a FE can both render the
   * saved list and answer "is reward X wishlisted" with one call. Newest first.
   */
  async getWishlist(user: JwtPayload, requestedPartnerId?: string) {
    // Re-authorize the active partner (own / authorized sibling); null = no outlet.
    const activePartnerId = await this.resolveActive(user, requestedPartnerId);
    if (!activePartnerId) {
      return { items: [], rewardIds: [] };
    }

    // Per-outlet-type Loyalty gate — parity with listCatalog: when the active outlet's type
    // has Loyalty OFF the whole catalogue (and therefore the wishlist view) is EMPTY. Missing
    // config → default true. The stored rows are kept; they just aren't surfaced.
    if (!(await isLoyaltyEnabledForPartner(this.prisma, user.clientId, activePartnerId))) {
      return { items: [], rewardIds: [] };
    }

    // Per-tenant MRP-slash flag (default OFF). When OFF: no cost-basis select, no slashPoints.
    const mrpSlashEnabled = await this.isCatalogueMrpSlashEnabled(user.clientId);

    const rows = await this.prisma.partnerWishlist.findMany({
      // Tenant + partner scoped — a partner only ever sees its own bookmarks — AND the
      // bookmarked reward must still be MEMBER-VISIBLE (the SAME filter listCatalog applies:
      // ACTIVE + moderation APPROVED + vendor ACTIVE/granted + not soft-deleted). A reward the
      // catalogue is now hiding (suspended vendor / revoked grant / DISCONTINUED|INACTIVE /
      // PENDING|REJECTED moderation / soft-deleted) drops out of BOTH `items` and `rewardIds`;
      // its stored row is retained (not deleted) so it reappears if the reward becomes visible
      // again. Relation filter on the required to-one `reward`.
      where: {
        partnerId: activePartnerId,
        clientId: user.clientId,
        reward: {
          is: {
            deletedAt: null,
            status: 'ACTIVE',
            moderationStatus: 'APPROVED',
            ...vendorVisibilityFilter(user.clientId),
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        rewardId: true,
        createdAt: true,
        // Member-safe reward projection (identical to listCatalog). mrpPaise + sellingValuePaise
        // are selected TRANSIENTLY only when the slash flag is ON (to compute slashPoints) and
        // are BOTH stripped below (never projected to the member). Flattened to `category` below.
        reward: {
          select: {
            ...MEMBER_CATALOG_SELECT,
            metadata: true, // transient — Hubble amount options only; stripped below
            ...(mrpSlashEnabled ? { mrpPaise: true, sellingValuePaise: true } : {}),
          },
        },
      },
    });

    const items = rows.map((r) => {
      // Compute the slash (flag ON only), then DROP BOTH cost-basis columns (leak guard).
      const reward = r.reward as typeof r.reward & {
        mrpPaise?: number | null;
        sellingValuePaise?: number | null;
      };
      const slashPoints = mrpSlashEnabled ? this.computeSlashPoints(reward) : null;
      const { category, metadata, mrpPaise: _mrp, sellingValuePaise: _sv, ...rest } = reward;
      return {
        ...rest,
        category: category?.name,
        wishlistedAt: r.createdAt,
        ...(mrpSlashEnabled ? { slashPoints } : {}),
        ...memberHubbleFields(metadata, reward.redemptionMode),
      };
    });

    return { items, rewardIds: rows.map((r) => r.rewardId) };
  }

  /**
   * POST /v1/rewards/wishlist — add a reward to the caller's wishlist. Idempotent:
   * adding an already-wishlisted reward is a no-op success (upsert on the
   * partnerId×rewardId unique constraint). The reward MUST exist under the caller's
   * own clientId (a cross-tenant id is rejected with 404 — never silently stored).
   */
  async addToWishlist(user: JwtPayload, rewardId: string, requestedPartnerId?: string) {
    const activePartnerId = await this.resolveActive(user, requestedPartnerId);
    if (!activePartnerId) {
      throw new ForbiddenException('No outlet is available to wishlist for.');
    }

    // CROSS-TENANT + MEMBER-VISIBILITY GUARD: the reward must be MEMBER-VISIBLE under the
    // caller's tenant — the SAME filter getCatalogItem/listCatalog apply: in-tenant + ACTIVE
    // + moderation APPROVED + vendor ACTIVE/granted (vendorVisibilityFilter) + not soft-
    // deleted. Without this a cross-tenant id, or a reward the catalogue is actively hiding
    // (vendor suspended / grant revoked / DISCONTINUED|INACTIVE / PENDING|REJECTED moderation
    // / soft-deleted), could be bookmarked. Reject with the same message for every miss so
    // the response is not an existence oracle.
    const reward = await this.prisma.rewardCatalog.findFirst({
      where: {
        id: rewardId,
        clientId: user.clientId,
        deletedAt: null,
        status: 'ACTIVE',
        moderationStatus: 'APPROVED',
        ...vendorVisibilityFilter(user.clientId),
      },
      select: { id: true },
    });
    if (!reward) throw new NotFoundException('Reward item not found');

    // Per-outlet-type Loyalty gate — the SAME server-enforced gate the catalogue reads apply:
    // a reward can't be wishlisted for an outlet whose type has Loyalty OFF. Same message (no
    // existence oracle). Missing config → default true (never hide on missing config).
    if (!(await isLoyaltyEnabledForPartner(this.prisma, user.clientId, activePartnerId))) {
      throw new NotFoundException('Reward item not found');
    }

    await this.prisma.partnerWishlist.upsert({
      where: { partnerId_rewardId: { partnerId: activePartnerId, rewardId } },
      create: { clientId: user.clientId, partnerId: activePartnerId, rewardId },
      update: {}, // already wishlisted → no-op success (idempotent)
    });

    return { success: true, wishlisted: true, rewardId };
  }

  /**
   * DELETE /v1/rewards/wishlist/:rewardId — remove a reward from the caller's
   * wishlist. Idempotent: removing a reward that is not wishlisted is a no-op
   * success. Scoped to the resolved active partner + the caller's clientId.
   */
  async removeFromWishlist(user: JwtPayload, rewardId: string, requestedPartnerId?: string) {
    const activePartnerId = await this.resolveActive(user, requestedPartnerId);
    if (!activePartnerId) {
      // No operable outlet → nothing to remove; treat as a no-op success.
      return { success: true, wishlisted: false, rewardId };
    }

    await this.prisma.partnerWishlist.deleteMany({
      where: { partnerId: activePartnerId, rewardId, clientId: user.clientId },
    });

    return { success: true, wishlisted: false, rewardId };
  }

  /**
   * GET /v1/rewards/orders — paginated redemption orders (own only for partners/sales; the
   * whole tenant for a Gifsy operator; the caller's OWN tenant for a CLIENT_ADMIN, view-only).
   *
   * Two paging modes over ONE stable order (createdAt DESC, id DESC — the id tie-break makes
   * equal-timestamp rows page deterministically):
   *   • page/limit (offset) — the legacy mode the admin Gift-Catalogue console uses; unchanged.
   *   • cursor (keyset)     — the partner My Orders "Load more": rows strictly after the cursor,
   *     so a row added at the top, or one leaving the member view mid-scroll (D4 hide), can never
   *     duplicate or skip a row across pages.
   * Both return `nextCursor` (null on the last page). `pagination.total` always counts the FULL
   * filtered set (cursor excluded) so "N orders" stays the true total.
   */
  async listOrders(user: JwtPayload, q: ListOrdersQueryDto, requestedPartnerId?: string) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const cursor = q.cursor ? decodeOrderCursor(q.cursor) : null;
    if (q.cursor && !cursor) throw new BadRequestException('Invalid cursor');
    const skip = cursor ? 0 : (page - 1) * limit;

    // Tenant scope by the partner's own clientId column (NOT partner.user.clientId):
    // a login-less sibling has no linked user, so a user-relation scope would hide
    // the switched sibling's orders. partner.clientId is authoritative for both.
    // Tenant admin (CLIENT_ADMIN) → the VIEW-ONLY admin list of its OWN tenant's orders (all
    // partners, no D4 exclusion — same rows a Gifsy operator sees for that tenant). Scoped
    // strictly by the JWT clientId; the x-active-partner-id header is ignored. Fail closed on a
    // blank clientId: `partner: { clientId: undefined }` would drop the tenant filter entirely.
    const tenantAdmin = !this.isGifsy(user) && isTenantAdmin(user);
    if (tenantAdmin && !user.clientId) {
      throw new ForbiddenException('No tenant context for this admin.');
    }
    const where: Prisma.RedemptionOrderWhereInput = {
      partner: { clientId: user.clientId },
    };
    if (!this.isGifsy(user) && !tenantAdmin) {
      // Non-admins see only the ACTIVE partner's orders (own by default, or a
      // switched sibling named by x-active-partner-id — re-authorized here).
      const activePartnerId = await this.resolveActive(user, requestedPartnerId);
      where.partnerId = activePartnerId ?? 'none';
      // Order-timeline D4 (owner): hide NEVER-CONFIRMED orders from the partner's My Orders —
      // a CANCELLED order that never reached CONFIRMED (abandoned/superseded OTP, or an ops
      // cancel of a PENDING order), so no points were ever deducted. "Never confirmed" =
      // CANCELLED, no dispatch/delivery stamp, and no history row that proves confirmation.
      // A row proves it when EITHER its toStatus (it moved INTO a reached-confirmed status, e.g.
      // PENDING→CONFIRMED) OR its fromStatus (it moved OUT of one, e.g. CONFIRMED→CANCELLED) is
      // in the set — the second clause covers an order whose PENDING→CONFIRMED row is missing.
      // (The confirm paths have always written PENDING→CONFIRMED in the confirm tx and only
      // redeem/redeemForOutlet create orders, so this holds for legacy rows too.)
      // In the WHERE so findMany + count (pagination) agree. Member branch only: the
      // Gifsy/admin views are unchanged.
      where.NOT = {
        status: RedemptionStatus.CANCELLED,
        dispatchedAt: null,
        deliveredAt: null,
        statusHistory: {
          none: {
            OR: [
              { toStatus: { in: REACHED_CONFIRMED_STATUSES } },
              { fromStatus: { in: REACHED_CONFIRMED_STATUSES } },
            ],
          },
        },
      };
    }
    if (q.status) where.status = q.status;

    // Member-safe projection (§ member view). Deliberately EXCLUDES the ops-only
    // fulfilment fields (fulfilmentChannel, supplierOrderRef, fulfilledByVendorId, POD)
    // and delivery PII, and never returns the BigInt valuePaise. logisticsPartner (the
    // courier name) IS member-safe and included. Also serves the legacy /admin/gifts
    // console, which reads a strict subset of these fields.
    // Keyset predicate lives ONLY on the page query — the count keeps the base `where` so the
    // total is the whole filtered set (and the D4 exclusion still applies to both).
    const pageWhere: Prisma.RedemptionOrderWhereInput = cursor
      ? {
          AND: [
            where,
            {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            },
          ],
        }
      : where;

    const [rows, total] = await Promise.all([
      this.prisma.redemptionOrder.findMany({
        where: pageWhere,
        select: {
          id: true,
          orderNumber: true,
          status: true,
          redemptionMode: true,
          totalPointsCost: true,
          quantity: true,
          voucherCode: true,
          voucherPin: true,
          voucherProvider: true,
          trackingNumber: true,
          trackingUrl: true,
          logisticsPartner: true,
          dispatchedAt: true,
          deliveredAt: true,
          cancelledAt: true,
          createdAt: true,
          updatedAt: true,
          reward: { select: { id: true, name: true, imageUrls: true, redemptionMode: true } },
          partner: { select: { id: true, businessName: true } },
          // Read for the operator-only Hubble reconcile flags below; NEVER returned as-is.
          metadata: true,
          // Read ONLY to derive the operator-only `voucherFillable` below; never returned.
          pointsDeducted: true,
        },
        skip,
        // One extra row tells us whether another page exists (it is never returned).
        take: limit + 1,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.redemptionOrder.count({ where }),
    ]);

    const hasMore = rows.length > limit;
    const orders = hasMore ? rows.slice(0, limit) : rows;
    const last = orders[orders.length - 1];

    // No dedicated returnedAt column — surface it (member-safe) when the order is RETURNED.
    // VOUCHER CODES: a code is a spendable bearer credential. The member's OWN list keeps it; on
    // the operator/admin view only a fulfilling operator (canSeeFullVoucherCode) gets it — every
    // other viewer (CLIENT_ADMIN, read-only staff) gets NO character of it: voucherCode null +
    // voucherIssued/voucherCodeMasked true.
    const memberView = !this.isGifsy(user) && !tenantAdmin;
    // Card number + PIN: member (own) and fulfilling operator only. A SALES rep never — even on the
    // member branch (their login resolves to no partner today; this pins it regardless).
    const hideCodes =
      isSalesViewer(user.role) || (!memberView && !(await this.canSeeFullVoucherCode(user)));
    const mapped = orders.map(({ metadata, pointsDeducted, ...o }) => ({
      ...o,
      ...(hideCodes ? hiddenVoucherFields(o.voucherCode) : {}),
      // Operator console only: a Hubble order stuck for ops ("Needs reconcile" + reason). The raw
      // metadata blob (redeem snapshot etc.) is never returned to anyone from this list.
      ...(memberView ? {} : hubbleReconcileFlags(metadata)),
      // Fulfilling operator only (sees the code): the server would accept a set-once PIN / provider
      // on the stored code (F4 — one rule, canFillStoredVoucher; the console row's PIN box uses it).
      ...(memberView || hideCodes ? {} : { voucherFillable: canFillStoredVoucher({ ...o, pointsDeducted, metadata }) }),
      returnedAt: o.status === 'RETURNED' ? o.updatedAt : null,
    }));

    return {
      orders: mapped,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      nextCursor: hasMore && last ? encodeOrderCursor(last.createdAt, last.id) : null,
    };
  }

  /** GET /v1/rewards/orders/:id — one order; non-admins may only see their own. */
  async getOrder(user: JwtPayload, id: string, requestedPartnerId?: string) {
    // Tenant scope by partner.clientId so a switched sibling's order is visible
    // (a login-less sibling has no linked user → partner.user.clientId would miss it).
    const where = { id, partner: { clientId: user.clientId } };

    // A Gifsy operator may see the full ops detail (this same row is also reachable via
    // the dispatch console). A MEMBER gets the member-safe projection — the same one
    // listOrders uses — so ops-only fields (fulfilmentChannel, supplierOrderRef,
    // fulfilledByVendorId, podUrl, notes, valuePaise) never leak to the partner app.
    if (this.isGifsy(user)) {
      const order = await this.prisma.redemptionOrder.findFirst({
        where,
        include: {
          reward: true,
          partner: { select: { id: true, businessName: true, userId: true } },
        },
      });
      if (!order) throw new NotFoundException('Order not found');
      // Read-only staff get the "issued" indicator, never the code itself.
      if (!(await this.canSeeFullVoucherCode(user))) {
        return { order: { ...order, ...hiddenVoucherFields(order.voucherCode) } };
      }
      return { order };
    }

    const order = await this.prisma.redemptionOrder.findFirst({
      where,
      select: MEMBER_ORDER_SELECT,
    });
    if (!order) throw new NotFoundException('Order not found');

    // Non-admins can only see the ACTIVE partner's order. Authorization is the
    // resolved active partner (own or an authorized sibling) — NOT the raw login's
    // userId, which would 403 a legitimately-switched sibling (userId=null).
    const activePartnerId = await this.resolveActive(user, requestedPartnerId);
    if (!activePartnerId || order.partnerId !== activePartnerId) {
      throw new ForbiddenException('Forbidden');
    }

    // A SALES rep never gets the card number / PIN (defence in depth — see isSalesViewer).
    if (isSalesViewer(user.role)) {
      return { order: { ...order, ...hiddenVoucherFields(order.voucherCode) } };
    }
    return { order };
  }

  /**
   * GET /v1/rewards/orders/:id/track — member ORDER TRACKING view (partner app).
   * Own order only (same scoping as getOrder): status + tracking + the dispatch
   * timeline. A trimmed, member-safe projection (no internal notes/actor ids) so a
   * partner can follow their gift from confirmation to delivery.
   */
  async trackOrder(user: JwtPayload, id: string, requestedPartnerId?: string) {
    const order = await this.prisma.redemptionOrder.findFirst({
      where: { id, partner: { clientId: user.clientId } },
      include: {
        reward: { select: { id: true, name: true, imageUrls: true } },
        statusHistory: {
          orderBy: { createdAt: 'asc' },
          // Member-safe timeline: from/to status + timestamp only. Internal `notes`
          // are ops-only (can carry supplier/vendor context) and must NOT leak here.
          select: { fromStatus: true, toStatus: true, createdAt: true },
        },
      },
    });
    if (!order) throw new NotFoundException('Order not found');

    // Non-admins may only track the ACTIVE partner's order (own or authorized sibling).
    if (!this.isGifsy(user)) {
      const activePartnerId = await this.resolveActive(user, requestedPartnerId);
      if (!activePartnerId || order.partnerId !== activePartnerId) {
        throw new ForbiddenException('Forbidden');
      }
    }

    // Order-timeline D5: when were this order's points refunded, if ever? Every refund goes
    // through wallet.reverse → one CREDIT_REVERSAL row referencing the order (indexed on
    // referenceType+referenceId), scoped to the order's own wallet. null = no refund recorded.
    const refund = await this.prisma.walletTransaction.findFirst({
      where: {
        transactionType: 'CREDIT_REVERSAL',
        referenceType: 'REDEMPTION_ORDER',
        referenceId: order.id,
        wallet: { partnerId: order.partnerId },
      },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });

    // NOTE: `fulfilmentChannel` is an ops-only field and is deliberately NOT surfaced on
    // the member tracking payload (matches the docstring's member-safe promise).
    return {
      tracking: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        reward: order.reward,
        quantity: order.quantity,
        logisticsPartner: order.logisticsPartner,
        trackingNumber: order.trackingNumber,
        trackingUrl: order.trackingUrl,
        dispatchedAt: order.dispatchedAt,
        deliveredAt: order.deliveredAt,
        cancelledAt: order.cancelledAt,
        refundedAt: refund?.createdAt ?? null,
        timeline: order.statusHistory,
      },
    };
  }

  /**
   * PATCH /v1/rewards/orders/:id — GIFSY-only NON-STATUS edits (tracking / notes /
   * voucher). Status changes are NOT accepted here: every status move must go
   * through `transitionOrder` (the guarded edge-map + refund path). 5.4b's bulk
   * fulfilment upload reuses this same non-status write.
   */
  async updateOrder(user: JwtPayload, id: string, dto: UpdateOrderDto) {
    // A lost PIN-add race against an IDENTICAL PIN (double submit) is retried once as a no-op.
    return withPinRaceRetry(() => this.updateOrderOnce(user, id, dto));
  }

  private async updateOrderOnce(user: JwtPayload, id: string, dto: UpdateOrderDto) {
    // GIFSY-only is enforced by @Roles on the controller; tenant scope re-checked
    // here by partner.clientId (§12). platformWide OWNER → cross-tenant console.
    const scope = tenantScope(user);
    const existingOrder = await this.prisma.redemptionOrder.findFirst({
      where: { id, ...(scope ? { partner: { clientId: scope } } : {}) },
      include: { partner: { select: { clientId: true } } },
    });
    if (!existingOrder) throw new NotFoundException('Order not found');
    // The ORDER's tenant (a platform-wide Gifsy caller's own clientId is 'gifsy').
    const orderClientId = existingOrder.partner?.clientId ?? user.clientId;

    // VOUCHER WRITE INVARIANT: no clear / blank, no overwrite of a stored code (only
    // "Voucher cancelled with vendor" clears one), never on a Hubble-handed order (unless a
    // GIFSY_ADMIN's reasoned manual override) or a cash order, never a code cancelled anywhere in
    // the tenant, a new code only on a paid open order.
    const voucherInput = {
      voucherCode: dto.voucherCode,
      voucherProvider: dto.voucherProvider,
      voucherPin: dto.voucherPin,
    };
    const voucherPlan = planVoucherWrite(
      existingOrder,
      voucherInput,
      this.voucherWriteOptions(user, dto),
    );
    const data = {
      trackingNumber: dto.trackingNumber,
      trackingUrl: dto.trackingUrl,
      ...voucherPlan.data,
      notes: dto.notes,
      // Dispatch fields (§5) — non-status console/bulk edits.
      fulfilmentChannel: dto.fulfilmentChannel,
      logisticsPartner: dto.logisticsPartner,
      supplierOrderRef: dto.supplierOrderRef,
      podUrl: dto.podUrl,
    };

    if (!voucherPlan.guard) {
      const order = await this.prisma.redemptionOrder.update({ where: { id }, data });
      return { order };
    }
    // Setting a NEW code: compare-and-set on "no code stored + paid open order + row version" so a
    // concurrent refund / vendor-cancel / other write makes this lose (409) instead of overwriting.
    // The issuance audit row lands in the SAME tx (no code without its audit).
    const guard = voucherPlan.guard;
    const order = await this.prisma.$transaction(async (tx) => {
      // Tenant-wide reuse check INSIDE the tx under a (tenant, code) advisory lock — a concurrent
      // "Voucher cancelled with vendor" of the same code can't slip between check and write.
      if (voucherPlan.issuesNewCode && voucherPlan.data.voucherCode) {
        await assertVoucherCodeReusableInTx(tx, orderClientId, voucherPlan.data.voucherCode);
      }
      const claim = await tx.redemptionOrder.updateMany({ where: { id, ...guard }, data });
      if (claim.count === 0) throw new ConflictException(VOUCHER_WRITE_CONFLICT_MESSAGE);
      if (voucherPlan.issuesNewCode && voucherPlan.data.voucherCode) {
        await recordVoucherIssuedAudit(tx, {
          actorId: user.sub,
          orderId: id,
          code: voucherPlan.data.voucherCode,
          pin: voucherPlan.data.voucherPin ?? null,
          provider: voucherPlan.data.voucherProvider ?? existingOrder.voucherProvider,
          path: 'PATCH /rewards/orders/:id',
          overrideReason: voucherPlan.overridden ? dto.overrideReason?.trim() : null,
        });
      }
      if (voucherPlan.addsPin && existingOrder.voucherCode) {
        // Set-once PIN added to an already-issued code — audited masked (never the PIN).
        await recordVoucherIssuedAudit(tx, {
          actorId: user.sub,
          orderId: id,
          code: existingOrder.voucherCode,
          pin: voucherPlan.data.voucherPin ?? null,
          provider: existingOrder.voucherProvider,
          path: 'PATCH /rewards/orders/:id',
          event: 'VOUCHER_PIN_ADDED_MANUAL',
        });
      }
      return tx.redemptionOrder.findUniqueOrThrow({ where: { id } });
    }).catch((e: unknown) =>
      rethrowUnlessIdempotentPinRace(e, voucherPlan, existingOrder, voucherInput, () =>
        this.prisma.redemptionOrder.findUnique({ where: { id }, select: { voucherCode: true, voucherPin: true } }),
      ),
    );
    // Same member notification transitionOrder sends when a code is first issued — under the
    // ORDER's tenant (branding / templates), never the caller's. A PIN added later to an issued
    // code re-sends it so the owner receives the PIN.
    if (voucherPlan.issuesNewCode || voucherPlan.addsPin) await this.notifyVoucherIssued(id, orderClientId);
    return { order };
  }

  /**
   * The identity half of the voucher guard:
   *  - manual override (the ops exit for a Hubble-handed order): GIFSY_ADMIN only, reason required.
   */
  private voucherWriteOptions(
    user: JwtPayload,
    dto: { manualOverride?: boolean; overrideReason?: string },
  ): VoucherWriteOptions {
    let manualOverride: VoucherWriteOptions['manualOverride'] = null;
    if (dto.manualOverride === true) {
      if (user.role !== 'GIFSY_ADMIN') {
        throw new ForbiddenException('Only a Gifsy admin can manually fulfil an order sent to Hubble.');
      }
      manualOverride = { reason: (dto.overrideReason ?? '').trim(), actorId: user.sub, at: new Date() };
    }
    // The tenant-wide cancelled-code check runs INSIDE each write transaction (under an advisory
    // lock — assertVoucherCodeReusableInTx), not here, so it can't race a concurrent cancel.
    return { manualOverride };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // P5.4a — CORE redemption pipeline.
  //
  // FREE_AMOUNT convention (reconcile §3): a catalog item with `pointsCost === 0`
  // AND both `minRedemptionPoints`/`maxRedemptionPoints` set is a variable-amount
  // voucher. The redeem body then carries `amount` (₹); requiredPoints =
  // round(amount × conversionRate) and MUST fall within [min, max]. A normal
  // (FIXED) item ignores `amount` and costs `pointsCost × quantity`.
  //
  // OTP: a 6-digit REDEMPTION_CONFIRM OtpCode (10-min TTL, maxAttempts 3) reuses
  // the OtpCode model. We do NOT call auth.verifyOtp (it auto-registers users) —
  // verifyRedemptionOtp below is a self-contained check honouring FIXED_OTP.
  //
  // Points only move at CONFIRM time (the OTP step), never at redeem time.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * DPDP consent gate for a VENDOR-sourced redeem (decision #15). A VENDOR item
   * REQUIRES an explicit truthy consent flag — the member agrees their delivery
   * name/address/phone are shared with the fulfilment vendor — otherwise the redeem
   * is blocked with a clear error. Returns the order columns to persist:
   *  - VENDOR: { fulfilledByVendorId, vendorPiiConsentAt: now, consentVersion }
   *  - PLATFORM: {} (no third party → no checkbox, no vendor routing).
   */
  private resolveVendorConsent(
    item: { sourceType: unknown; vendorId: string | null },
    consent: boolean | undefined,
  ): { fulfilledByVendorId?: string; vendorPiiConsentAt?: Date; consentVersion?: string } {
    if (item.sourceType !== 'VENDOR') return {};
    if (consent !== true) {
      throw new BadRequestException(
        'Please agree to share your delivery details with the fulfilment partner to redeem this gift.',
      );
    }
    // A VENDOR-sourced item MUST resolve a fulfilment vendor. Without one the order would
    // stamp consent but route nowhere (no vendor portal, no dispatch) — block it rather
    // than create an orphaned, undispatchable order (Wave-2 audit LOW#7).
    if (!item.vendorId) {
      throw new BadRequestException(
        'This gift is temporarily unavailable — no fulfilment partner is assigned.',
      );
    }
    return {
      fulfilledByVendorId: item.vendorId,
      vendorPiiConsentAt: new Date(),
      consentVersion: VENDOR_PII_CONSENT_VERSION,
    };
  }

  /**
   * BE DEFENSE (Wave-2 audit HIGH#2): a vendor must always get an ADDRESSABLE recipient.
   * The FE supplies the delivery name, but a bug had it sending the gift's brand/name
   * instead of the member. Belt-and-suspenders: fall back to the partner/outlet owner's
   * real profile name when the sent name is blank OR is literally the gift's own name
   * (i.e. a product/brand slipped in), so `deliveryName` always names a person.
   */
  private resolveDeliveryName(
    sentName: string | null | undefined,
    ownerName: string | null | undefined,
    giftName: string | null | undefined,
  ): string | undefined {
    const sent = (sentName ?? '').trim();
    const owner = (ownerName ?? '').trim();
    const gift = (giftName ?? '').trim();
    if (!sent) return owner || undefined;
    if (gift && sent.toLowerCase() === gift.toLowerCase()) return owner || sent;
    return sent;
  }

  /**
   * Hubble redeem-time guard — shared by redeem() and redeemForOutlet(), run BEFORE any
   * order/points move. Returns null for every non-Hubble item WITHOUT a DB read (no
   * productId on the item → short-circuit), so a non-Hubble tenant (Deoleo) is unchanged.
   * For a Hubble-backed GIFT_CARD (productId + tenant flag ON):
   *   - quantity must be 1 (we place ONE voucher of the order value — 2 × ₹500 would be sent
   *     as a single ₹1,000 denomination, which a FIXED brand may not issue);
   *   - a variable-amount item takes whole rupees only, and when the admin chose a list of
   *     amounts (metadata.hubbleDenominations) the amount must be one of them.
   * `amountPaise` is the chosen face value to freeze on the order (so confirm-time valuePaise —
   * and therefore the Hubble order amount — is EXACTLY the chosen amount at any conversion rate).
   * `fromList` = the amount was validated against the admin list (the points band is skipped).
   */
  private async resolveHubbleRedeem(
    clientId: string,
    item: {
      redemptionMode: PayoutMode;
      metadata: Prisma.JsonValue | null;
      pointsCost: number;
      minRedemptionPoints: number | null;
      maxRedemptionPoints: number | null;
      sellingValuePaise?: number | null;
    },
    amount: number | undefined,
    quantity: number,
  ): Promise<{ amountPaise: number | null; fromList: boolean } | null> {
    if (item.redemptionMode !== PayoutMode.GIFT_CARD) return null;
    const productId = this.extractHubbleProductId(item.metadata);
    if (!productId) return null;
    if (!(await this.isHubbleEnabledForTenant(clientId))) return null;
    if (quantity !== 1) {
      throw new BadRequestException('This gift card is issued one per redemption — redeem a quantity of 1.');
    }
    if (!this.isFreeAmount(item)) {
      // Fixed-price item: its face value is the selling value — refuse up front when the brand
      // can't issue it right now (instead of debiting, then failing + refunding at issuance).
      if (item.sellingValuePaise != null && item.sellingValuePaise > 0) {
        await this.assertHubbleCanIssue(productId, item.sellingValuePaise / 100);
      }
      return { amountPaise: null, fromList: false };
    }
    if (amount == null) {
      // The caller's "amount (₹) is required" check reports this.
      return { amountPaise: null, fromList: false };
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BadRequestException('Enter a whole-rupee amount');
    }
    const denoms = extractHubbleDenominations(item.metadata);
    if (denoms.length && !denoms.includes(amount)) {
      throw new BadRequestException(
        `Choose one of the available amounts: ${denoms.map((d) => `₹${d.toLocaleString('en-IN')}`).join(', ')}.`,
      );
    }
    // The LIVE brand (cached): a FIXED brand's current face values / a FLEXIBLE brand's RUPEE
    // min–max — so the member gets a 400 BEFORE any debit, not a refund after it.
    await this.assertHubbleCanIssue(productId, amount);
    return { amountPaise: amount * 100, fromList: denoms.length > 0 };
  }

  /**
   * Redeem-time live-brand check (cached product lookup). Throws a member-readable 400 when the
   * brand can't issue ONE voucher of `amount` rupees right now: FIXED with a KNOWN list → must be
   * on it; FLEXIBLE → within Hubble's rupee min–max. Lookup failure / Hubble not configured / a
   * FIXED brand whose list Hubble didn't return → no block here (issuance + Hubble still validate,
   * and an un-provisioned environment falls back to manual fulfilment).
   */
  private async assertHubbleCanIssue(productId: string, amount: number): Promise<void> {
    // Fast, single-flight, never-throwing lookup (2.5 s budget + 60 s negative cache): null =
    // Hubble slow / down / not configured / not found → skip the check (issuance + Hubble still
    // validate). A member never waits on a Hubble outage at redeem time.
    const product = await this.hubble.getProductForRedeem(productId);
    if (!product) return;
    if (product.denominationType === 'FIXED' && product.denominations.length === 0) return;
    if (isAmountIssuable(product, amount)) return;
    const fmt = (n: number) => `₹${n.toLocaleString('en-IN')}`;
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BadRequestException('This gift card must be a whole-rupee amount.');
    }
    if (product.denominationType === 'FIXED') {
      throw new BadRequestException(
        `${fmt(amount)} isn't available for this gift card right now. Available: ${product.denominations.map(fmt).join(', ')}.`,
      );
    }
    const { minValue, maxValue } = product;
    if (minValue == null && maxValue == null) {
      throw new BadRequestException(`This gift card can't be issued for ${fmt(amount)} right now.`);
    }
    const range =
      minValue != null && maxValue != null
        ? `between ${fmt(minValue)} and ${fmt(maxValue)}`
        : minValue != null
          ? `of at least ${fmt(minValue)}`
          : `of at most ${fmt(maxValue!)}`;
    throw new BadRequestException(`This gift card can only be issued for an amount ${range}.`);
  }

  /** True when the item is a FREE_AMOUNT (variable-amount) voucher. */
  private isFreeAmount(item: { pointsCost: number; minRedemptionPoints: number | null; maxRedemptionPoints: number | null }): boolean {
    return (
      item.pointsCost === 0 &&
      item.minRedemptionPoints != null &&
      item.maxRedemptionPoints != null
    );
  }

  /**
   * Wave 3 login-picker — resolve the PARTNER a partner-self request should ACT ON.
   *
   * SECURITY INVARIANT: this is the ONLY authority for outlet switching on the
   * partner-self money path. `resolveActivePartnerId` re-authorizes the optional
   * `x-active-partner-id` selector against the login's operable set (own partner +
   * login-less same-group same-phone siblings) — an absent/own selector returns the
   * login's own partner (byte-identical fast path), a valid sibling returns that
   * sibling, and anything else is `forbidden`. Callers MUST use the returned
   * partnerId for EVERY downstream partner resolution (wallet, order create, order
   * re-loads inside the confirm $transaction) so a mid-flow re-resolution can never
   * silently switch back to the login's own wallet — the classic money bug.
   *
   * Returns the resolved partnerId (string) or null when the login owns no partner
   * (e.g. a parent-only phone) — the caller treats null as today's no-partner case.
   */
  private async resolveActive(
    user: JwtPayload,
    requestedPartnerId?: string,
  ): Promise<string | null> {
    const res = await resolveActivePartnerId(this.prisma, {
      clientId: user.clientId,
      userSub: user.sub,
      phone: user.phone,
      requestedPartnerId,
    });
    if (res.forbidden) throw new ForbiddenException('You cannot act on that outlet.');
    return res.partnerId;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // B1 / #50-E — SALES-ASSISTED redemption (redeem ON BEHALF OF an outlet).
  //
  // A sales user redeems for an OUTLET actively assigned to them OR to anyone in
  // their reporting downline (the same scope as GET /v1/sales/outlets). Points,
  // the wallet debit, and the order all belong to the OUTLET — the sales user is
  // only the operator (recorded for audit). The OTP is sent to the OUTLET's phone
  // (owner decision: the outlet consents; the rep submits the code the outlet
  // shares). Authorization is the active salesUserAssignment, re-verified on BOTH
  // redeem AND confirm (the confirm never trusts the order alone).
  //
  // Scoping shape is the PROVEN sales-on-behalf guard from schemes.service.ts:
  //   caller SalesUser in tenant → target ChannelPartner in tenant → active
  //   salesUserAssignment(salesUserId ∈ caller's downline + outletId of a live,
  //   non-PARKED outlet of this partner + unassignedAt null) — the outlet-list scope.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Resolve the OUTLET (ChannelPartner) the caller (a SalesUser) may act for, or
   * throw. Returns the partner plus the OTP recipient (the OUTLET's user + phone),
   * which redeem/confirm bind the REDEMPTION_CONFIRM OTP to.
   */
  private async requireAssignedPartner(user: JwtPayload, targetPartnerId: string) {
    // 1. Caller must be a SalesUser in this tenant.
    const callerSalesUser = await this.prisma.salesUser.findFirst({
      where: { userId: user.sub, clientId: user.clientId, deletedAt: null },
      select: { id: true },
    });
    if (!callerSalesUser) {
      throw new ForbiddenException('Only sales users may redeem on behalf of an outlet');
    }

    // 2. Target outlet/partner must belong to this tenant (cross-tenant block).
    const partner = await this.prisma.channelPartner.findFirst({
      where: { id: targetPartnerId, clientId: user.clientId, deletedAt: null },
      include: { user: { select: { id: true, phone: true } } },
    });
    if (!partner) throw new NotFoundException('Outlet not found in this tenant');

    // 3. The outlet must have an ACTIVE assignment to the caller OR to anyone in the
    //    caller's reporting DOWNLINE — EXACTLY the scope GET /v1/sales/outlets
    //    (SalesService.getMyOutlets) lists: same tenant-scoped edge query, same
    //    descendantSalesUserIds walk. A manager may therefore redeem for any outlet
    //    he can see; a leaf rep's subtree is just himself (unchanged). There is no
    //    role-based tenant-wide branch here, mirroring getMyOutlets (MIS_USER is not
    //    a sales role and is already rejected at the controller @Roles gate).
    //    F5 — the ASSIGNMENT must match the list row-for-row (SalesService.buildOutlets):
    //    an OUTLET-keyed assignment (outletId non-null) whose outlet belongs to this
    //    partner, is not deleted and is NOT admin-PARKED (the SAME NOT_PARKED_OUTLET
    //    filter the list uses). A partnerId-only assignment (outletId null — legacy /
    //    seed shape; both live assignment writers key on outletId) never appears in the
    //    list, so it no longer authorizes; nor does a PARKED outlet the rep cannot see.
    //    Same rule for reps and managers.
    const edges = await this.prisma.salesUser.findMany({
      where: { user: { clientId: user.clientId }, deletedAt: null },
      select: { id: true, reportingToId: true },
    });
    const subtreeIds = [...descendantSalesUserIds(callerSalesUser.id, edges)];
    const assignment = await this.prisma.salesUserAssignment.findFirst({
      where: {
        salesUserId: { in: subtreeIds },
        unassignedAt: null,
        outletId: { not: null },
        outlet: { partnerId: targetPartnerId, deletedAt: null, ...NOT_PARKED_OUTLET },
      },
      select: { id: true },
    });
    if (!assignment) {
      throw new ForbiddenException('You are not assigned to this outlet');
    }

    // ChannelPartner.userId is non-nullable in the schema, but guard defensively:
    // an OTP with no recipient cannot be delivered, so fail loudly.
    const otpUserId = partner.userId;
    if (!otpUserId) {
      throw new BadRequestException('Outlet has no linked user for OTP');
    }

    return { partner, otpUserId, otpPhone: partner.user?.phone ?? '' };
  }

  /**
   * POST /v1/rewards/redeem-for-outlet — sales-assisted redeem initiation.
   * Identical pipeline to `redeem()` EXCEPT the partner is the assigned OUTLET
   * (not the caller), and the OTP is bound to + delivered to the OUTLET's phone.
   * The wallet affordability check and the order both target the OUTLET. Writes a
   * SALES_ASSISTED_REDEEM audit log recording the operating sales user.
   */
  async redeemForOutlet(user: JwtPayload, dto: SalesRedeemDto) {
    const quantity = dto.quantity ?? 1;

    // ACTIVE non-deleted catalog item, in-tenant.
    const item = await this.prisma.rewardCatalog.findFirst({
      // Moderation gate on the REDEEM guard too — a non-APPROVED item must never be
      // redeemable via a stale cart / deep link. WAVE-2 (review CRITICAL #2): a VENDOR
      // row also requires vendor ACTIVE + ACTIVE grant → suspend/revoke blocks redeem.
      where: {
        id: dto.rewardId,
        status: 'ACTIVE',
        deletedAt: null,
        clientId: user.clientId,
        moderationStatus: 'APPROVED',
        ...vendorVisibilityFilter(user.clientId),
      },
    });
    if (!item) throw new NotFoundException('Reward item not found or not available');

    // DPDP consent (decision #15): a VENDOR-sourced redeem is BLOCKED without an
    // explicit consent flag; PLATFORM items need none. Returns the consent columns +
    // fulfilledByVendorId to stamp on the order (or {} for platform items).
    const consentData = this.resolveVendorConsent(item, dto.consent);

    // PHYSICAL_GIFT requires a full delivery address; other modes do not.
    if (item.redemptionMode === 'PHYSICAL_GIFT') {
      if (!dto.deliveryAddress) {
        throw new BadRequestException('Delivery address is required for physical gifts');
      }
      // Address quality (§12): validate the pincode at redeem for physical gifts.
      // The DTO already enforces 6 digits; the service adds the real-India rule
      // (first digit 1–9 — no Indian PIN starts with 0) so a syntactically-valid
      // but impossible PIN can't reach dispatch.
      this.assertValidPincode(dto.deliveryAddress.pincode);
    }

    // Per-tenant settings: the points↔₹ rate, channel availability, and the global
    // cash/voucher floor. Server-enforced (the FE gate is bypassable via direct API).
    const settings = await this.tenantSettings.getEffectiveSettings(user.clientId);
    const rate = settings.conversionRate;
    if (!settings.redemptionChannels[this.channelKey(item.redemptionMode)]) {
      throw new BadRequestException('This redemption channel is currently unavailable.');
    }

    // Hubble gift-card guard (quantity 1, whole rupees, one of the admin-chosen amounts) —
    // BEFORE any points move. null (no DB read) for every non-Hubble item.
    const hubbleRedeem = await this.resolveHubbleRedeem(user.clientId, item, dto.amount, quantity);

    // Points cost: FREE_AMOUNT = round(amount × rate) bounded by min/max; else pointsCost × qty.
    let requiredPoints: number;
    if (this.isFreeAmount(item)) {
      if (dto.amount == null) {
        throw new BadRequestException('amount (₹) is required for a variable-amount voucher');
      }
      requiredPoints = Math.round(dto.amount * rate);
      const min = item.minRedemptionPoints as number;
      const max = item.maxRedemptionPoints as number;
      // An amount already validated against the admin's Hubble amount list skips the stored
      // points band (that band only mirrors the list's min/max at the save-time rate, so a later
      // rate change must not lock members out of a listed amount). The global floor still applies.
      if (!hubbleRedeem?.fromList && (requiredPoints < min || requiredPoints > max)) {
        throw new BadRequestException(
          `Amount out of range. Allowed: ${min}–${max} points, requested: ${requiredPoints}`,
        );
      }
      // Global floor: a variable-amount redemption must clear the tenant minimum ₹
      // (bank/DBT vs free-amount voucher). The global floor WINS over the per-item min.
      const isCash = item.redemptionMode === 'UPI' || item.redemptionMode === 'BANK_TRANSFER';
      const floorInr = isCash ? settings.minBankTransferAmount : settings.minVoucherFreeAmount;
      const floorPoints = Math.round(floorInr * rate);
      if (requiredPoints < floorPoints) {
        throw new BadRequestException(
          `Minimum ${isCash ? 'transfer' : 'voucher'} amount is ₹${floorInr} (${floorPoints} points).`,
        );
      }
    } else {
      requiredPoints = item.pointsCost * quantity;
    }
    if (requiredPoints <= 0) {
      throw new BadRequestException('Redemption must cost a positive number of points');
    }

    // Resolve the OUTLET the caller may act for + the OTP recipient (the outlet).
    const { partner, otpUserId, otpPhone } = await this.requireAssignedPartner(
      user,
      dto.targetPartnerId,
    );

    // Per-outlet-type Loyalty gate — checked on the OUTLET being redeemed FOR (not the sales
    // operator). Block a NEW sales-assisted redemption when that outlet's type has Loyalty OFF,
    // BEFORE any wallet debit / order creation. Missing config → default true.
    if (!(await isLoyaltyEnabledForPartner(this.prisma, user.clientId, partner.id))) {
      throw new ForbiddenException('Rewards are not enabled for your outlet type.');
    }

    // Per-outlet-type SALES-ASSISTED REDEMPTION gate — the tenant governs, per outlet type, whether
    // a rep may redeem on an outlet's behalf (OutletTypeClientConfig.salesAssistedRedeemEnabled).
    // Server-enforced (the FE "Redeem for Outlet" button is bypassable via a direct API call), BEFORE
    // any debit/order. Unset → preserve-today default (wholesalers only). See sales-redeem-eligibility.
    if (!(await isSalesRedeemEnabledForPartner(this.prisma, user.clientId, partner.id))) {
      throw new ForbiddenException('Sales-assisted redemption is not enabled for this outlet type.');
    }

    // Affordability checks the OUTLET's wallet (no debit yet).
    const wallet = await this.prisma.wallet.findFirst({ where: { partnerId: partner.id } });
    if (!wallet) throw new NotFoundException('Wallet not found');
    if (wallet.redeemablePoints < requiredPoints) {
      throw new BadRequestException(
        `Insufficient points. Required: ${requiredPoints}, Available: ${wallet.redeemablePoints}`,
      );
    }

    const addr = dto.deliveryAddress;
    const otp = this.generateOtpCode();
    // Order metadata: (a) gift value snapshot (decision §14) — freeze the gift's ₹ selling price
    // so a later price/rate change never re-values it (null for non-gift/variable → confirm falls
    // back to points ÷ rate); (b) salesInitiatedById — mark this as a REP-STAGED order so the
    // self-confirm path (confirmRedeem) can also refuse it once the outlet type's sales-assisted
    // redemption is disabled (closes the disable-mid-flight residual — the OTP sits on the outlet's
    // own phone, so without this the owner could complete a rep-staged order via self-confirm).
    // (c) a Hubble variable-amount gift card freezes the CHOSEN face value instead (see
    // resolveHubbleRedeem) so the Hubble order amount is exactly what the outlet picked.
    const giftMetadata: Prisma.InputJsonValue = {
      ...(hubbleRedeem?.amountPaise != null
        ? { sellingValuePaiseSnapshot: hubbleRedeem.amountPaise }
        : item.sellingValuePaise != null
          ? { sellingValuePaiseSnapshot: item.sellingValuePaise }
          : {}),
      salesInitiatedById: user.sub,
    };

    // Single active OTP per OUTLET: supersede the OUTLET's abandoned PENDING orders
    // (never debited) and clear the OUTLET's unverified REDEMPTION_CONFIRM OTPs so
    // the new OTP can confirm only THIS order. Scope is the OUTLET, not the caller.
    let otpCodeId: string | undefined; // captured for the light D1 OTP delivery-handle write after send
    const order = await this.prisma.$transaction(async (tx) => {
      await supersedePendingOrders(tx, partner.id, user.sub, new Date());
      await tx.otpCode.deleteMany({
        where: { userId: otpUserId, purpose: 'REDEMPTION_CONFIRM', verifiedAt: null },
      });
      const orderAccountId = await ensureOutletAccount(tx, partner.id);
      // Tenant-stamped order number (TENANT-YY-######) via a concurrency-safe
      // per-(tenant,year) advisory-locked sequence. Inside the tx so the lock holds.
      const orderNumber = await generateTenantOrderNumber(tx, user.clientId);
      const created = await tx.redemptionOrder.create({
        data: {
          partnerId: partner.id,
          accountId: orderAccountId, // Employee Rewards Phase 1 — unified account owner (dual-write)
          rewardId: item.id,
          orderNumber,
          metadata: giftMetadata,
          quantity,
          pointsDeducted: 0,
          totalPointsCost: requiredPoints,
          // Snapshot the rate so confirm-time valuePaise/TDS is deterministic even if
          // an admin edits the per-tenant rate before the OTP is confirmed.
          conversionRateCenti: Math.round(rate * 100),
          redemptionMode: item.redemptionMode,
          status: 'PENDING',
          // Belt-and-suspenders (audit HIGH#2): never let a gift brand/product become the
          // ship-to name — fall back to the OUTLET owner's real name.
          deliveryName: this.resolveDeliveryName(addr?.name, partner.ownerName, item.name),
          deliveryPhone: addr?.mobile,
          deliveryAddressLine1: addr?.address,
          deliveryCity: addr?.city,
          deliveryState: addr?.state,
          deliveryPincode: addr?.pincode,
          // VENDOR-sourced order routing + DPDP consent (decisions #14/#15): stamp
          // fulfilledByVendorId (→ the item's vendor portal) + vendorPiiConsentAt +
          // consentVersion. Empty spread for PLATFORM items (no vendor, no consent).
          ...consentData,
        },
      });
      const otpRow = await tx.otpCode.create({
        data: {
          userId: otpUserId,
          phone: otpPhone,
          code: otp,
          purpose: 'REDEMPTION_CONFIRM',
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          maxAttempts: 3,
          // Bind the OTP to THIS order so its confirm can't consume another outlet's OTP
          // (a login/outlet can now hold concurrent PENDING orders — login picker).
          referenceId: created.id,
        },
      });
      otpCodeId = otpRow.id;
      return created;
    });

    // Audit: record the operating sales user behind the OUTLET's order.
    await this.prisma.auditLog
      .create({
        data: {
          action: 'CREATE',
          entityType: 'REDEMPTION_ORDER',
          entityId: order.id,
          actorId: user.sub,
          metadata: {
            event: 'SALES_ASSISTED_REDEEM',
            salesUserId: user.sub,
            partnerId: partner.id,
            orderNumber: order.orderNumber,
          },
        },
      })
      .catch((e) => this.logger.error(`[redeemForOutlet] audit log failed: ${e}`));

    // Send OTP delivery to the OUTLET's phone synchronously (consent). NEVER log the live OTP
    // (the default Nest logger emits debug in prod → it would land in Cloud Logging).
    this.logger.debug(`[redeemForOutlet] OTP generated for order ${order.id}`);
    try {
      // Per-tenant SALES-ASSISTED redemption template; undefined → global env template.
      const tpl = await this.tenantSettings.getOtpTemplateId(user.clientId, 'redemptionSales');
      const sendRes = await this.msg91.sendOtp(otpPhone, otp, 'SMS', tpl);
      // Light D1 OTP delivery tracking — best-effort; NEVER throws, so it cannot trip the
      // send-failure cleanup/503 path below (the catch is only for a real sendOtp failure).
      await captureOtpDeliveryHandle(this.prisma, otpCodeId, sendRes);
    } catch (e) {
      this.logger.error(`[redeemForOutlet] OTP send failed for order ${order.id}: ${e}`);
      // No debit happened at redeem (pointsDeducted:0), so just undo the OTP + order so nothing is orphaned.
      // Best-effort: a stranded PENDING order is superseded by the next redeem; a cleanup failure must
      // NEVER mask the user-facing 503 (audit A-2a F5).
      try {
        await this.prisma.$transaction(async (tx) => {
          // Delete ONLY the OTP row THIS request created (by id). A login/outlet-wide delete
          // would also wipe a CONCURRENT redeem's fresh OTP (created after ours), stranding it.
          // Guarded on a set id: Prisma treats `id: undefined` as NO filter (= delete all).
          if (otpCodeId) {
            await tx.otpCode.deleteMany({ where: { id: otpCodeId, verifiedAt: null } });
          }
          // PENDING-guarded: never cancels (or writes history for) an order that a concurrent
          // confirm already CONFIRMED or a later redeem already superseded.
          await transitionOrderStatus(tx, {
            orderId: order.id,
            guard: { status: RedemptionStatus.PENDING },
            fromStatus: RedemptionStatus.PENDING,
            toStatus: RedemptionStatus.CANCELLED,
            data: { cancelledAt: new Date() },
            changedById: user.sub,
            notes: 'OTP could not be sent',
          });
        });
      } catch (ce) {
        this.logger.error(`[redeemForOutlet] cleanup after OTP-send failure failed for order ${order.id}: ${ce}`);
      }
      throw new ServiceUnavailableException('Could not send the confirmation OTP. Please try again in a moment.');
    }

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      requiredPoints,
      message:
        "OTP sent to the outlet's registered mobile. Ask the outlet to share it to confirm.",
    };
  }

  /**
   * POST /v1/rewards/redeem-for-outlet/confirm — confirm a sales-assisted redeem.
   * Re-verifies the assignment server-side (the assignment IS the authorization —
   * the order alone is never trusted), verifies the OTP bound to the OUTLET's user,
   * then runs the identical confirm transaction as `confirmRedeem` (atomic claim,
   * in-tx OTP consume, OUTLET wallet debit, valuePaise freeze, stock claim, P6
   * payout bridge). The operating sales user is the recorded status-history actor.
   */
  async confirmRedeemForOutlet(user: JwtPayload, dto: SalesRedeemConfirmDto) {
    // Re-verify the assignment server-side — do NOT trust the order alone.
    const { partner } = await this.requireAssignedPartner(user, dto.targetPartnerId);

    // The order must belong to the resolved (assigned) outlet. Benign-by-design:
    // a rep may confirm ANY PENDING order on that outlet — including one the
    // partner created via self-redeem — because the wallet, the debit target and
    // the OTP recipient are all the same outlet, so consent + the money path are
    // unchanged. (The atomic claim below still guarantees a single debit if two
    // assigned reps race.)
    const order = await this.prisma.redemptionOrder.findFirst({
      where: { id: dto.orderId, partnerId: partner.id },
      include: {
        reward: true,
        partner: {
          select: {
            id: true,
            userId: true,
            isActive: true,
            deletedAt: true,
            // Beneficiary rails for the pre-debit presence check (cash modes).
            bankAccountNumber: true,
            ifscCode: true,
            upiId: true,
            // GLB-1b pre-tx gate: fetch all KYC submissions for the canonical
            // resolver (deterministic tiebreak). No take:1 limit — the resolver
            // picks the effective status. See kyc-eligibility.ts for rationale.
            kycSubmissions: {
              orderBy: [{ createdAt: 'desc' }, { updatedAt: 'desc' }, { id: 'desc' }],
              select: { id: true, status: true, createdAt: true, updatedAt: true },
            },
          },
        },
      },
    });
    if (!order) throw new NotFoundException('Redemption order not found');
    if (order.status !== 'PENDING') {
      throw new BadRequestException('Order is not awaiting confirmation');
    }

    // ELIGIBILITY GATE for the OUTLET (pre-transaction, fast path). KYC-APPROVED +
    // active + not-soft-deleted is required for ALL redemption modes (owner decision,
    // 2026-06-27): no value or goods may go to an unverified outlet — vouchers /
    // physical gifts are gated identically to cash. (Previously only cash modes were
    // gated; a pre-KYC outlet that had been credited points could redeem a voucher.)
    // Uses the canonical resolver for a deterministic tiebreak. A second check INSIDE
    // the transaction (TOCTOU guard) ensures no suspension between here and the
    // claim/debit can produce a debit for an ineligible partner.
    const isCashModeForOutlet =
      order.redemptionMode === 'UPI' || order.redemptionMode === 'BANK_TRANSFER';
    const p = order.partner;
    if (!p || p.isActive === false || p.deletedAt != null) {
      throw new BadRequestException(
        'Outlet partner account is inactive or deleted; redemption cannot be confirmed',
      );
    }
    const kycStatus = resolveEffectiveKycStatus(p.kycSubmissions ?? []);
    if (kycStatus !== 'APPROVED') {
      throw new BadRequestException(
        `Outlet partner KYC is not approved (current status: ${kycStatus ?? 'NO_SUBMISSION'}); redemption cannot be confirmed`,
      );
    }
    if (isCashModeForOutlet) {
      // BENEFICIARY-PRESENCE GUARD (pre-debit, CASH only). The outlet needs at least
      // one COMPLETE rail to be payable; otherwise the order becomes an unpayable,
      // UNCANCELLABLE PayoutTransaction. Reject BEFORE any points debit / valuePaise
      // freeze / PayoutTransaction create.
      const hasBank = !!(p.bankAccountNumber && p.ifscCode);
      const hasUpi = !!p.upiId;
      if (!hasBank && !hasUpi) {
        throw new BadRequestException(
          'Add your bank or UPI details (complete KYC) to redeem for cash.',
        );
      }
    }

    // A parent owner (userId nullable) never redeems; a real operating outlet always
    // has a linked user. Guard defensively so a null can't reach OTP/notify below.
    if (!partner.userId) {
      throw new BadRequestException('Outlet has no linked user for redemption.');
    }

    // OTP is bound to the OUTLET's user (it was delivered to the outlet's phone) AND to THIS order.
    const otpId = await this.verifyRedemptionOtp(partner.userId, dto.otp, order.id);

    const requiredPoints = order.totalPointsCost;

    await this.prisma.$transaction(async (tx) => {
      // valuePaise: freeze the ₹-equivalent at confirm time (194R TDS base).
      // value(₹) = points ÷ conversionRate; centi-rate integer math avoids
      // truncating a fractional rate. rate 0 (misconfig) → 0 (guard div-by-zero).
      const rateCenti = await this.confirmRateCenti(order, user.clientId);
      // Canonical value freeze (decision §14): a GIFT item freezes valuePaise =
      // sellingValuePaise × quantity (rate-IMMUNE — a rate change never re-values a
      // placed gift). The selling price is read from the redeem-time snapshot in
      // order.metadata (falls back to the live catalog price for pre-snapshot orders).
      // Cash rails (UPI/BANK_TRANSFER) keep points ÷ rate (= the payout amount).
      const sellingSnap =
        typeof (order.metadata as { sellingValuePaiseSnapshot?: unknown } | null)
          ?.sellingValuePaiseSnapshot === 'number'
          ? (order.metadata as { sellingValuePaiseSnapshot: number }).sellingValuePaiseSnapshot
          : (order.reward?.sellingValuePaise ?? null);
      const valuePaise = computeFrozenValuePaise({
        isCashMode:
          order.redemptionMode === PayoutMode.UPI ||
          order.redemptionMode === PayoutMode.BANK_TRANSFER,
        sellingValuePaiseSnapshot: sellingSnap,
        quantity: order.quantity,
        points: requiredPoints,
        rateCenti,
      });

      // GLB-2 — ZERO-VALUE HARD FAIL for cash modes (inside the transaction so
      // the claim + wallet debit all roll back). Non-cash modes are unaffected.
      if (isCashModeForOutlet && valuePaise === 0n) {
        throw new BadRequestException(
          'Computed payout value is zero (check POINTS_CONVERSION_RATE); cash redemption cannot be confirmed',
        );
      }

      // TOCTOU in-tx eligibility re-check (ALL modes). The pre-tx gate above is the
      // fast path (fail early, clean 400). But a partner can be suspended / un-approved
      // between the pre-tx read and this transaction's start. Re-asserting here ensures
      // the wallet debit never happens for an ineligible partner: a throw inside
      // $transaction triggers a full rollback (no debit, claim reverts). isPartnerPayable
      // = active + not-deleted + KYC-APPROVED, which is exactly the all-mode gate.
      {
        const freshPartner = await tx.channelPartner.findFirst({
          where: { id: order.partnerId },
          select: {
            isActive: true,
            deletedAt: true,
            kycSubmissions: {
              orderBy: [{ createdAt: 'desc' }, { updatedAt: 'desc' }, { id: 'desc' }],
              select: { id: true, status: true, createdAt: true, updatedAt: true },
            },
          },
        });
        const freshKyc = resolveEffectiveKycStatus(freshPartner?.kycSubmissions ?? []);
        if (!isPartnerPayable({ isActive: freshPartner?.isActive, deletedAt: freshPartner?.deletedAt, effectiveKyc: freshKyc })) {
          throw new BadRequestException(
            `Outlet partner is no longer eligible for redemption (status changed after pre-tx check; KYC: ${freshKyc ?? 'NO_SUBMISSION'})`,
          );
        }
      }

      // DEF-3 — TOCTOU item re-check (ALL sources). Mirrors confirmRedeem: the item can
      // be REJECTED / its vendor SUSPENDED / its grant REVOKED / de-activated between the
      // sales-assisted redeem and this confirm. Re-assert the redeem-time filter INSIDE
      // the tx so the debit + CONFIRMED stamp can never land on an unreachable item.
      const liveItem = await tx.rewardCatalog.findFirst({
        where: {
          id: order.rewardId,
          status: 'ACTIVE',
          deletedAt: null,
          clientId: user.clientId,
          moderationStatus: 'APPROVED',
          ...vendorVisibilityFilter(user.clientId),
        },
        select: { id: true },
      });
      if (!liveItem) {
        throw new BadRequestException('This gift is no longer available');
      }

      // TOCTOU loyalty re-check: an admin can disable the outlet type's Loyalty flag
      // between the sales-assisted redeem and this confirm. Points MOVE at the debit
      // below, so re-assert the per-outlet-type gate INSIDE the tx (parity with the
      // freshPartner/DEF-3 guards) — a now loyalty-OFF outlet type can never complete
      // an in-flight redemption. A throw rolls the whole tx back (no debit/claim).
      if (!(await isLoyaltyEnabledForPartner(tx, user.clientId, order.partnerId))) {
        throw new ForbiddenException('Rewards are not enabled for your outlet type.');
      }

      // TOCTOU sales-assisted-redemption re-check: an admin can turn the outlet type's
      // salesAssistedRedeemEnabled flag OFF between the sales-assisted redeem and this confirm.
      // Re-assert the per-outlet-type gate INSIDE the tx so this (rep-assisted) endpoint can never
      // complete a rep-assisted redemption after the type is disabled (parity with the loyalty
      // re-check). Throw → tx rollback. The companion self-confirm path (confirmRedeem) ALSO blocks
      // a rep-staged order (marked via metadata.salesInitiatedById at redeem) under the same gate,
      // so the outlet owner cannot finish it with the OTP sent to their phone either — both confirm
      // paths are closed for a disabled type.
      if (!(await isSalesRedeemEnabledForPartner(tx, user.clientId, order.partnerId))) {
        throw new ForbiddenException('Sales-assisted redemption is not enabled for this outlet type.');
      }

      // Atomic claim: only the tx that flips PENDING→CONFIRMED proceeds → a single
      // order can never be debited twice (double-submit matches 0 rows, aborts).
      // The PENDING→CONFIRMED history row is written by the shared transition, in this tx,
      // only when the claim wins (actor = the confirming user).
      const claim = await transitionOrderStatus(tx, {
        orderId: order.id,
        guard: { status: 'PENDING' },
        fromStatus: RedemptionStatus.PENDING,
        toStatus: RedemptionStatus.CONFIRMED,
        data: { pointsDeducted: requiredPoints, valuePaise },
        changedById: user.sub,
      });
      if (claim.count === 0) {
        throw new ConflictException('Order is no longer awaiting confirmation');
      }

      // Consume the OTP INSIDE the tx so a later failure rolls it back for retry — CONDITIONALLY, so an
      // OTP another request already consumed aborts this tx (no debit).
      if (!(await markOtpUsed(tx, otpId))) {
        throw new UnauthorizedException('No active OTP found. Please restart the redemption.');
      }

      // Debit the OUTLET's wallet via the canonical write-path (passbook + ledger).
      await this.wallet.debitRedeem(
        order.partnerId,
        requiredPoints,
        { referenceId: order.id, description: `Redemption ${order.orderNumber}` },
        tx,
      );

      // Guarded stock claim — concurrent confirms of the last unit can't oversell.
      if (order.reward?.stockQuantity != null) {
        const stockClaim = await tx.rewardCatalog.updateMany({
          where: { id: order.rewardId, stockQuantity: { gte: order.quantity } },
          data: { stockQuantity: { decrement: order.quantity } },
        });
        if (stockClaim.count === 0) {
          throw new BadRequestException('Reward is out of stock');
        }
        const fresh = await tx.rewardCatalog.findFirst({
          where: { id: order.rewardId },
          select: { stockQuantity: true },
        });
        if (fresh?.stockQuantity != null && fresh.stockQuantity <= 0) {
          await tx.rewardCatalog.update({
            where: { id: order.rewardId },
            data: { status: 'OUT_OF_STOCK' },
          });
        }
      }

      // P6 BRIDGE — unbatched PayoutTransaction for cash modes (UPI/BANK_TRANSFER).
      // The exclusive PENDING→CONFIRMED claim above guarantees at most one payout
      // per order. Beneficiary fields are snapshotted from the OUTLET's KYC.
      if (
        order.redemptionMode === 'UPI' ||
        order.redemptionMode === 'BANK_TRANSFER'
      ) {
        const partnerSnap = await tx.channelPartner.findFirst({
          where: { id: order.partnerId },
          select: {
            bankAccountHolder: true,
            ownerName: true,
            upiId: true,
            bankAccountNumber: true,
            ifscCode: true,
            bankName: true,
          },
        });

        // MINOR: this zero-value fallback is only reachable for non-cash modes
        // (GLB-2 above throws first for UPI/BANK_TRANSFER when valuePaise=0n).
        // It is kept for defence-in-depth but must NEVER be reached in cash paths.
        const amountPaise: bigint =
          valuePaise != null && valuePaise > 0n ? valuePaise : (() => {
            this.logger.warn(
              `[confirmRedeemForOutlet] valuePaise null/zero for order ${order.id} — PayoutTransaction created with amountPaise=0; manual correction required (non-cash path only)`,
            );
            return 0n;
          })();

        // MONEY-PATH: the actual payout RAIL follows the partner's ON-FILE
        // beneficiary, NOT the catalogue item's redemptionMode. UPI is preferred
        // when present (mirrors the partner-facing payout target + the credit rail),
        // else the bank rail. This decouples the (now unified "Cash Payout")
        // catalogue mode from the real disbursement channel, so a cash item can
        // never misroute a UPI-only partner onto the bank rail (or vice-versa).
        //
        // CONVENTION (finance / reconciliation): order.redemptionMode (the reward TYPE —
        // "Cash Payout" is stored as BANK_TRANSFER) may now legitimately DIFFER from this
        // payoutMode (the disbursement RAIL). Rail / bank-file questions → read
        // payoutTransaction.payoutMode; reward-type questions → order.redemptionMode.
        // NEVER assume the two are equal.
        const payoutMode: 'UPI' | 'BANK_TRANSFER' = partnerSnap?.upiId
          ? 'UPI'
          : 'BANK_TRANSFER';

        await tx.payoutTransaction.create({
          data: {
            partnerId: order.partnerId,
            redemptionOrderId: order.id,
            payoutMode,
            status: 'PENDING',
            batchId: null,
            amountPaise,
            netAmountPaise: amountPaise,
            tdsPaise: 0n,
            tdsApplicable: false,
            beneficiaryName: partnerSnap?.bankAccountHolder ?? partnerSnap?.ownerName ?? null,
            upiId: partnerSnap?.upiId ?? null,
            bankAccountNumber: partnerSnap?.bankAccountNumber ?? null,
            ifscCode: partnerSnap?.ifscCode ?? null,
            bankName: partnerSnap?.bankName ?? null,
          },
        });

        this.logger.log(
          `[confirmRedeemForOutlet] PayoutTransaction created for order ${order.id} (rail=${payoutMode}, ${amountPaise} paise)`,
        );
      }
    });

    // ── Hubble auto-issuance (Bajaj-only, feature-flagged; default OFF) ───────────
    // Alternate entry path (sales-assisted): same GIFT_CARD confirm, so it must auto-issue
    // identically. Points were already debited inside the committed tx above. Non-Hubble /
    // flag-off → the existing manual path below, byte-identical. The OTP recipient / owner
    // is the OUTLET (not the acting rep), so the notification addresses the outlet owner.
    if (await this.isHubbleEligible(order, user.clientId)) {
      return await this.finishHubbleConfirm(order, {
        clientId: user.clientId,
        actorId: user.sub,
        notifyUserId: partner.userId,
        recipientPhone: partner.phone ?? null,
        ownerName: partner.ownerName ?? 'Partner',
        rewardName: order.reward?.name ?? '',
        points: requiredPoints,
      });
    }

    // Redemption-confirmed notification on commit: bell feed (IN_APP) + PUSH to the outlet's
    // partner user, PLUS the config-driven SMS/WhatsApp to the OUTLET OWNER — via the single
    // canonical notifyUserWithChannels path. The dead direct SMS enqueue is removed; SMS now flows
    // through the config path (default OFF until a tenant enables it). Fire-and-forget.
    await this.notifications.notifyUserWithChannels({
      clientId: user.clientId,
      userId: partner.userId,
      eventKey: 'REDEMPTION_CONFIRMED',
      // Paid-channel recipient = the OUTLET OWNER (partner.phone), consistent with every other
      // event. Previously this addressed the outlet's LOGIN user (partner.user.phone), which can
      // differ from the owner. Free channels still target partner.userId (the acting user) above.
      recipientPhone: partner.phone ?? null,
      vars: {
        ownerName: partner.ownerName ?? 'Partner',
        rewardName: order.reward?.name ?? '',
        points: requiredPoints,
      },
      subject: 'Redemption confirmed',
      body: 'Your redemption is confirmed.',
      url: '/partner/rewards',
      event: 'REDEMPTION_CONFIRMED',
    });

    return {
      orderId: order.id,
      status: 'CONFIRMED',
      message: 'Redemption confirmed. Your order is being processed.',
    };
  }

  /**
   * POST /v1/rewards/redeem — initiate a redemption.
   * Resolves required points (FIXED or FREE_AMOUNT), checks affordability WITHOUT
   * debiting, creates a PENDING order, and issues a REDEMPTION_CONFIRM OTP. The
   * actual wallet debit happens at confirm time.
   */
  async redeem(user: JwtPayload, dto: RedeemDto, requestedPartnerId?: string) {
    const quantity = dto.quantity ?? 1;

    // ACTIVE non-deleted catalog item, in-tenant.
    const item = await this.prisma.rewardCatalog.findFirst({
      // Moderation gate on the REDEEM guard too — a non-APPROVED item must never be
      // redeemable via a stale cart / deep link. WAVE-2 (review CRITICAL #2): a VENDOR
      // row also requires vendor ACTIVE + ACTIVE grant → suspend/revoke blocks redeem.
      where: {
        id: dto.rewardId,
        status: 'ACTIVE',
        deletedAt: null,
        clientId: user.clientId,
        moderationStatus: 'APPROVED',
        ...vendorVisibilityFilter(user.clientId),
      },
    });
    if (!item) throw new NotFoundException('Reward item not found or not available');

    // DPDP consent (decision #15): a VENDOR-sourced redeem is BLOCKED without an
    // explicit consent flag; PLATFORM items need none. Returns the consent columns +
    // fulfilledByVendorId to stamp on the order (or {} for platform items).
    const consentData = this.resolveVendorConsent(item, dto.consent);

    // PHYSICAL_GIFT requires a full delivery address; other modes do not.
    if (item.redemptionMode === 'PHYSICAL_GIFT') {
      if (!dto.deliveryAddress) {
        throw new BadRequestException('Delivery address is required for physical gifts');
      }
      // Address quality (§12): validate the pincode at redeem for physical gifts.
      // The DTO already enforces 6 digits; the service adds the real-India rule
      // (first digit 1–9 — no Indian PIN starts with 0) so a syntactically-valid
      // but impossible PIN can't reach dispatch.
      this.assertValidPincode(dto.deliveryAddress.pincode);
    }

    // Per-tenant settings: the points↔₹ rate, channel availability, and the global
    // cash/voucher floor. Server-enforced (the FE gate is bypassable via direct API).
    const settings = await this.tenantSettings.getEffectiveSettings(user.clientId);
    const rate = settings.conversionRate;
    if (!settings.redemptionChannels[this.channelKey(item.redemptionMode)]) {
      throw new BadRequestException('This redemption channel is currently unavailable.');
    }

    // Hubble gift-card guard (quantity 1, whole rupees, one of the admin-chosen amounts) —
    // BEFORE any points move. null (no DB read) for every non-Hubble item.
    const hubbleRedeem = await this.resolveHubbleRedeem(user.clientId, item, dto.amount, quantity);

    // Points cost: FREE_AMOUNT = round(amount × rate) bounded by min/max; else pointsCost × qty.
    let requiredPoints: number;
    if (this.isFreeAmount(item)) {
      if (dto.amount == null) {
        throw new BadRequestException('amount (₹) is required for a variable-amount voucher');
      }
      requiredPoints = Math.round(dto.amount * rate);
      const min = item.minRedemptionPoints as number;
      const max = item.maxRedemptionPoints as number;
      // An amount already validated against the admin's Hubble amount list skips the stored
      // points band (that band only mirrors the list's min/max at the save-time rate, so a later
      // rate change must not lock members out of a listed amount). The global floor still applies.
      if (!hubbleRedeem?.fromList && (requiredPoints < min || requiredPoints > max)) {
        throw new BadRequestException(
          `Amount out of range. Allowed: ${min}–${max} points, requested: ${requiredPoints}`,
        );
      }
      // Global floor: a variable-amount redemption must clear the tenant minimum ₹
      // (bank/DBT vs free-amount voucher). The global floor WINS over the per-item min.
      const isCash = item.redemptionMode === 'UPI' || item.redemptionMode === 'BANK_TRANSFER';
      const floorInr = isCash ? settings.minBankTransferAmount : settings.minVoucherFreeAmount;
      const floorPoints = Math.round(floorInr * rate);
      if (requiredPoints < floorPoints) {
        throw new BadRequestException(
          `Minimum ${isCash ? 'transfer' : 'voucher'} amount is ₹${floorInr} (${floorPoints} points).`,
        );
      }
    } else {
      requiredPoints = item.pointsCost * quantity;
    }
    if (requiredPoints <= 0) {
      throw new BadRequestException('Redemption must cost a positive number of points');
    }

    // SECURITY INVARIANT: resolve the ACTIVE partner ONCE (own or an authorized
    // switched sibling). This same activePartnerId drives the wallet check, the
    // PENDING supersede AND the order.partnerId — so the whole redemption (and every
    // downstream confirm re-load, which keys off order.partnerId) targets the outlet
    // the login actually switched to, never the login's own wallet. A forbidden
    // selector throws here before any read; null (no partner) → today's 404.
    const activePartnerId = await this.resolveActive(user, requestedPartnerId);
    if (!activePartnerId) throw new NotFoundException('Partner account not found');

    // Per-outlet-type Loyalty gate — server-enforced (the FE gate is bypassable via a direct
    // API call). Block a NEW redemption when the active outlet's type has Loyalty OFF. Placed
    // BEFORE any wallet debit / order creation. Missing config → default true.
    if (!(await isLoyaltyEnabledForPartner(this.prisma, user.clientId, activePartnerId))) {
      throw new ForbiddenException('Rewards are not enabled for your outlet type.');
    }

    const wallet = await this.prisma.wallet.findFirst({ where: { partnerId: activePartnerId } });
    if (!wallet) throw new NotFoundException('Wallet not found');
    if (wallet.redeemablePoints < requiredPoints) {
      throw new BadRequestException(
        `Insufficient points. Required: ${requiredPoints}, Available: ${wallet.redeemablePoints}`,
      );
    }

    // Owner name for the ship-to fallback (audit HIGH#2) — a vendor must get a real
    // recipient name even if the FE mis-sends the gift brand/product as the name.
    const activePartner = await this.prisma.channelPartner.findFirst({
      where: { id: activePartnerId },
      select: { ownerName: true },
    });

    const addr = dto.deliveryAddress;
    const otp = this.generateOtpCode();
    // Gift value snapshot (decision §14): freeze the gift's ₹ selling price onto the
    // order at redeem so a later price/rate change never re-values it. Null for
    // non-gift / variable-amount items → confirm falls back to points ÷ rate.
    // A Hubble variable-amount gift card freezes the CHOSEN face value (resolveHubbleRedeem) so
    // the Hubble order amount is exactly what the member picked, at any conversion rate.
    const giftMetadata =
      hubbleRedeem?.amountPaise != null
        ? ({ sellingValuePaiseSnapshot: hubbleRedeem.amountPaise } as Prisma.InputJsonValue)
        : item.sellingValuePaise != null
          ? ({ sellingValuePaiseSnapshot: item.sellingValuePaise } as Prisma.InputJsonValue)
          : undefined;

    // C2 — bind the OTP to exactly ONE order. A user may have only one redemption
    // awaiting confirmation at a time: superseding any abandoned PENDING orders
    // (none were ever debited → pointsDeducted=0, no refund) and their unverified
    // OTPs guarantees the single active REDEMPTION_CONFIRM OTP can confirm only
    // THIS order — closing the cross-order OTP-confusion the audit flagged.
    let otpCodeId: string | undefined; // captured for the light D1 OTP delivery-handle write after send
    const order = await this.prisma.$transaction(async (tx) => {
      // Supersede the ACTIVE partner's abandoned PENDING orders (never debited). The
      // OTP delete/create stay bound to user.sub — the OTP is LOGIN-level (one active
      // REDEMPTION_CONFIRM per login), while the order/wallet are the active outlet's.
      await supersedePendingOrders(tx, activePartnerId, user.sub, new Date());
      await tx.otpCode.deleteMany({
        where: { userId: user.sub, purpose: 'REDEMPTION_CONFIRM', verifiedAt: null },
      });
      const orderAccountId = await ensureOutletAccount(tx, activePartnerId);
      // Tenant-stamped order number (TENANT-YY-######) via a concurrency-safe
      // per-(tenant,year) advisory-locked sequence. Inside the tx so the lock holds.
      const orderNumber = await generateTenantOrderNumber(tx, user.clientId);
      const created = await tx.redemptionOrder.create({
        data: {
          partnerId: activePartnerId,
          accountId: orderAccountId, // Employee Rewards Phase 1 — unified account owner (dual-write)
          rewardId: item.id,
          orderNumber,
          metadata: giftMetadata,
          quantity,
          pointsDeducted: 0,
          totalPointsCost: requiredPoints,
          // Snapshot the rate so confirm-time valuePaise/TDS is deterministic even if
          // an admin edits the per-tenant rate before the OTP is confirmed.
          conversionRateCenti: Math.round(rate * 100),
          redemptionMode: item.redemptionMode,
          status: 'PENDING',
          // Belt-and-suspenders (audit HIGH#2): never let a gift brand/product become the
          // ship-to name — fall back to the outlet owner's real name.
          deliveryName: this.resolveDeliveryName(addr?.name, activePartner?.ownerName, item.name),
          deliveryPhone: addr?.mobile,
          deliveryAddressLine1: addr?.address,
          deliveryCity: addr?.city,
          deliveryState: addr?.state,
          deliveryPincode: addr?.pincode,
          // VENDOR-sourced order routing + DPDP consent (decisions #14/#15): stamp
          // fulfilledByVendorId (→ the item's vendor portal) + vendorPiiConsentAt +
          // consentVersion. Empty spread for PLATFORM items (no vendor, no consent).
          ...consentData,
        },
      });
      const otpRow = await tx.otpCode.create({
        data: {
          userId: user.sub,
          phone: user.phone,
          code: otp,
          purpose: 'REDEMPTION_CONFIRM',
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          maxAttempts: 3,
          // Bind the OTP to THIS order so its confirm can't consume another order's OTP. The OTP
          // stays LOGIN-level for delivery (userId), but a login can now hold concurrent PENDING
          // orders across outlets (login picker) — the order scope is the new confusion guard.
          referenceId: created.id,
        },
      });
      otpCodeId = otpRow.id;
      return created;
    });

    // Send OTP delivery (SMS) synchronously. NEVER log the live OTP (the default Nest logger
    // emits debug in prod → it would land in Cloud Logging).
    this.logger.debug(`[redeem] OTP generated for order ${order.id}`);
    try {
      // Per-tenant SELF redemption template; undefined → global env template.
      const tpl = await this.tenantSettings.getOtpTemplateId(user.clientId, 'redemptionSelf');
      const sendRes = await this.msg91.sendOtp(user.phone, otp, 'SMS', tpl);
      // Light D1 OTP delivery tracking — best-effort; NEVER throws, so it cannot trip the
      // send-failure cleanup/503 path below (the catch is only for a real sendOtp failure).
      await captureOtpDeliveryHandle(this.prisma, otpCodeId, sendRes);
    } catch (e) {
      this.logger.error(`[redeem] OTP send failed for order ${order.id}: ${e}`);
      // No debit happened at redeem (pointsDeducted:0), so just undo the OTP + order so nothing is orphaned.
      // Best-effort: a stranded PENDING order is superseded by the next redeem; a cleanup failure must
      // NEVER mask the user-facing 503 (audit A-2a F5).
      try {
        await this.prisma.$transaction(async (tx) => {
          // Delete ONLY the OTP row THIS request created (by id). A login-wide delete would
          // also wipe a CONCURRENT redeem's fresh OTP (created after ours), stranding it.
          // Guarded on a set id: Prisma treats `id: undefined` as NO filter (= delete all).
          if (otpCodeId) {
            await tx.otpCode.deleteMany({ where: { id: otpCodeId, verifiedAt: null } });
          }
          // PENDING-guarded: never cancels (or writes history for) an order that a concurrent
          // confirm already CONFIRMED or a later redeem already superseded.
          await transitionOrderStatus(tx, {
            orderId: order.id,
            guard: { status: RedemptionStatus.PENDING },
            fromStatus: RedemptionStatus.PENDING,
            toStatus: RedemptionStatus.CANCELLED,
            data: { cancelledAt: new Date() },
            changedById: user.sub,
            notes: 'OTP could not be sent',
          });
        });
      } catch (ce) {
        this.logger.error(`[redeem] cleanup after OTP-send failure failed for order ${order.id}: ${ce}`);
      }
      throw new ServiceUnavailableException('Could not send the confirmation OTP. Please try again in a moment.');
    }

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      requiredPoints,
      message: 'OTP sent to your registered mobile. Please confirm the redemption.',
    };
  }

  /**
   * POST /v1/rewards/redeem/confirm — confirm a PENDING order with the OTP.
   * Verifies the OTP, then in ONE $transaction re-checks the balance, debits via
   * WalletService.debitRedeem, flips the order to CONFIRMED, decrements stock for
   * stock-tracked items, and writes a status-history row. Notifies on commit.
   */
  async confirmRedeem(user: JwtPayload, dto: RedeemConfirmDto, requestedPartnerId?: string) {
    // SECURITY INVARIANT: resolve the ACTIVE partner FIRST (own or an authorized
    // switched sibling; forbidden → 403). The order must belong to THIS partner — we
    // authorize by order.partnerId === activePartnerId, NOT by order.partner.userId
    // (a switched sibling has userId=null and would be wrongly 403'd). Every in-tx
    // re-load below keys off order.partnerId (== the resolved active partner), so the
    // debit/payout can never drift back to the login's own wallet.
    const activePartnerId = await this.resolveActive(user, requestedPartnerId);

    const order = await this.prisma.redemptionOrder.findFirst({
      // Tenant scope by partner.clientId so a switched sibling's order is found
      // (a login-less sibling has no linked user → partner.user.clientId would miss it).
      where: { id: dto.orderId, partner: { clientId: user.clientId } },
      include: {
        reward: true,
        partner: {
          select: {
            id: true,
            userId: true,
            isActive: true,
            deletedAt: true,
            // Outlet OWNER identity for the paid-channel redemption notification (below).
            phone: true,
            ownerName: true,
            // Beneficiary rails for the pre-debit presence check (cash modes).
            bankAccountNumber: true,
            ifscCode: true,
            upiId: true,
            // GLB-1b pre-tx gate: fetch all KYC submissions for the canonical
            // resolver (deterministic tiebreak). No take:1 limit — the resolver
            // picks the effective status. See kyc-eligibility.ts for rationale.
            kycSubmissions: {
              orderBy: [{ createdAt: 'desc' }, { updatedAt: 'desc' }, { id: 'desc' }],
              select: { id: true, status: true, createdAt: true, updatedAt: true },
            },
          },
        },
      },
    });
    if (!order) throw new NotFoundException('Redemption order not found');
    // Authorize the order against the resolved active partner (own or switched sibling).
    if (!activePartnerId || order.partnerId !== activePartnerId) {
      throw new ForbiddenException('Forbidden');
    }
    if (order.status !== 'PENDING') {
      throw new BadRequestException('Order is not awaiting confirmation');
    }

    // ELIGIBILITY GATE (pre-transaction, fast path). KYC-APPROVED + active +
    // not-soft-deleted is required for ALL redemption modes (owner decision,
    // 2026-06-27): no value or goods to an unverified outlet — vouchers / physical
    // gifts are gated identically to cash. (Previously only cash was gated; a pre-KYC
    // partner credited points could redeem a voucher.) Canonical resolver for a
    // deterministic tiebreak. A second check INSIDE the transaction (TOCTOU guard)
    // ensures a suspension between here and the claim/debit is caught.
    const isCashModeConfirm =
      order.redemptionMode === 'UPI' || order.redemptionMode === 'BANK_TRANSFER';
    const p = order.partner;
    if (!p || p.isActive === false || p.deletedAt != null) {
      throw new BadRequestException(
        'Partner account is inactive or deleted; redemption cannot be confirmed',
      );
    }
    const kycStatus = resolveEffectiveKycStatus(p.kycSubmissions ?? []);
    if (kycStatus !== 'APPROVED') {
      throw new BadRequestException(
        `Partner KYC is not approved (current status: ${kycStatus ?? 'NO_SUBMISSION'}); redemption cannot be confirmed`,
      );
    }
    if (isCashModeConfirm) {
      // BENEFICIARY-PRESENCE GUARD (pre-debit, CASH only). A cash payout needs at least
      // one COMPLETE rail to be payable. Without it the order becomes an unpayable,
      // UNCANCELLABLE PayoutTransaction — so reject BEFORE any points debit / valuePaise
      // freeze / PayoutTransaction create.
      const hasBank = !!(p.bankAccountNumber && p.ifscCode);
      const hasUpi = !!p.upiId;
      if (!hasBank && !hasUpi) {
        throw new BadRequestException(
          'Add your bank or UPI details (complete KYC) to redeem for cash.',
        );
      }
    }

    const otpId = await this.verifyRedemptionOtp(user.sub, dto.otp, order.id);

    const requiredPoints = order.totalPointsCost;

    await this.prisma.$transaction(async (tx) => {
      // C1 — CLAIM the order as the atomic concurrency gate: only the tx that
      // flips PENDING→CONFIRMED proceeds. A concurrent confirm (double-submit)
      // matches 0 rows here and aborts BEFORE any debit, so a single order can
      // never be debited twice. This is the guard, not the pre-tx status read.
      //
      // valuePaise: freeze the ₹-equivalent of the points at confirm time (the
      // 194R TDS base for redemptions). conversionRate can theoretically be 0
      // (misconfigured env) — guard to prevent division-by-zero; in that case
      // valuePaise = 0 (no TDS base, visible in reports for manual correction).
      // value(₹) = points ÷ conversionRate. Work in centi-rate (rate×100) integer math so a
      // fractional conversionRate (e.g. 0.5 pts/₹) isn't truncated: paise = points×10000 ÷ (rate×100).
      const rateCenti = await this.confirmRateCenti(order, user.clientId);
      // Canonical value freeze (decision §14): a GIFT item freezes valuePaise =
      // sellingValuePaise × quantity (rate-IMMUNE — a rate change never re-values a
      // placed gift). The selling price is read from the redeem-time snapshot in
      // order.metadata (falls back to the live catalog price for pre-snapshot orders).
      // Cash rails (UPI/BANK_TRANSFER) keep points ÷ rate (= the payout amount).
      const sellingSnap =
        typeof (order.metadata as { sellingValuePaiseSnapshot?: unknown } | null)
          ?.sellingValuePaiseSnapshot === 'number'
          ? (order.metadata as { sellingValuePaiseSnapshot: number }).sellingValuePaiseSnapshot
          : (order.reward?.sellingValuePaise ?? null);
      const valuePaise = computeFrozenValuePaise({
        isCashMode:
          order.redemptionMode === PayoutMode.UPI ||
          order.redemptionMode === PayoutMode.BANK_TRANSFER,
        sellingValuePaiseSnapshot: sellingSnap,
        quantity: order.quantity,
        points: requiredPoints,
        rateCenti,
      });

      // GLB-2 — ZERO-VALUE HARD FAIL for cash modes (inside the transaction so
      // the whole tx — claim + wallet debit — rolls back). A zero valuePaise means
      // either the conversionRate is 0/misconfigured (caught by the boot check) or
      // the arithmetic produced 0 despite a non-zero rate (e.g. tiny point count).
      // Either way, creating a PayoutTransaction with amountPaise=0 is a silent
      // money-path bug; fail loudly here so ops can correct the root cause.
      // Non-cash modes are NOT affected — they don't create a PayoutTransaction.
      if (isCashModeConfirm && valuePaise === 0n) {
        throw new BadRequestException(
          'Computed payout value is zero (check POINTS_CONVERSION_RATE); cash redemption cannot be confirmed',
        );
      }

      // TOCTOU in-tx eligibility re-check (ALL modes).
      // The pre-tx gate above is the fast path (fail early, clean 400). But a partner
      // can be suspended / un-approved between the pre-tx read and this transaction's
      // start. Re-reading partner state here ensures the wallet debit never happens for
      // an ineligible partner: a throw inside $transaction triggers a full rollback
      // (claim reverts). isPartnerPayable = active + not-deleted + KYC-APPROVED.
      {
        // SECURITY INVARIANT: re-load by order.partnerId (== the resolved active
        // partner) + clientId — NEVER re-resolve from user.sub here, which would
        // silently switch a switched-outlet confirm back to the login's own partner.
        const freshPartner = await tx.channelPartner.findFirst({
          where: { id: order.partnerId, clientId: user.clientId },
          select: {
            isActive: true,
            deletedAt: true,
            kycSubmissions: {
              orderBy: [{ createdAt: 'desc' }, { updatedAt: 'desc' }, { id: 'desc' }],
              select: { id: true, status: true, createdAt: true, updatedAt: true },
            },
          },
        });
        const freshKyc = resolveEffectiveKycStatus(freshPartner?.kycSubmissions ?? []);
        if (!isPartnerPayable({ isActive: freshPartner?.isActive, deletedAt: freshPartner?.deletedAt, effectiveKyc: freshKyc })) {
          throw new BadRequestException(
            `Partner is no longer eligible for redemption (status changed after pre-tx check; KYC: ${freshKyc ?? 'NO_SUBMISSION'})`,
          );
        }
      }

      // DEF-3 — TOCTOU item re-check (ALL sources). The moderation + vendor-visibility
      // gate is applied at redeem (pre-auth), but the item can be REJECTED / its vendor
      // SUSPENDED / its grant REVOKED / the item de-activated between redeem and this
      // confirm. Re-assert the SAME filter used at redeem, INSIDE the tx, so the debit +
      // CONFIRMED stamp can never land on an item that is no longer reachable (an
      // orphaned order pinned to an unreachable vendor). A throw here rolls the tx back.
      const liveItem = await tx.rewardCatalog.findFirst({
        where: {
          id: order.rewardId,
          status: 'ACTIVE',
          deletedAt: null,
          clientId: user.clientId,
          moderationStatus: 'APPROVED',
          ...vendorVisibilityFilter(user.clientId),
        },
        select: { id: true },
      });
      if (!liveItem) {
        throw new BadRequestException('This gift is no longer available');
      }

      // TOCTOU loyalty re-check: an admin can disable the outlet type's Loyalty flag
      // between redeem and this confirm. Points MOVE at the debit below, so re-assert the
      // per-outlet-type gate INSIDE the tx (parity with the freshPartner/DEF-3 guards) —
      // a now loyalty-OFF outlet type can never complete an in-flight redemption. A throw
      // rolls the whole tx back (no debit/claim).
      if (!(await isLoyaltyEnabledForPartner(tx, user.clientId, order.partnerId))) {
        throw new ForbiddenException('Rewards are not enabled for your outlet type.');
      }

      // Finding-1 close: a REP-STAGED order (created via redeem-for-outlet, marked with
      // metadata.salesInitiatedById) must NOT complete via THIS self-confirm path either once the
      // outlet type's sales-assisted redemption is disabled — otherwise the outlet owner could finish
      // a rep-staged order with the OTP that was sent to their own phone, bypassing the rep-path gate.
      // Only rep-staged orders are gated here; a genuine self-redeem (no marker) is unaffected.
      const salesInitiated =
        (order.metadata as { salesInitiatedById?: unknown } | null)?.salesInitiatedById != null;
      if (salesInitiated && !(await isSalesRedeemEnabledForPartner(tx, user.clientId, order.partnerId))) {
        throw new ForbiddenException('Sales-assisted redemption is not enabled for this outlet type.');
      }

      // The PENDING→CONFIRMED history row is written by the shared transition, in this tx,
      // only when the claim wins (actor = the confirming user).
      const claim = await transitionOrderStatus(tx, {
        orderId: order.id,
        guard: { status: 'PENDING' },
        fromStatus: RedemptionStatus.PENDING,
        toStatus: RedemptionStatus.CONFIRMED,
        data: { pointsDeducted: requiredPoints, valuePaise },
        changedById: user.sub,
      });
      if (claim.count === 0) {
        throw new ConflictException('Order is no longer awaiting confirmation');
      }

      // M1 — consume the OTP INSIDE the tx so a later failure (insufficient
      // balance, oversold stock) rolls the OTP back and the user can retry. CONDITIONAL: an OTP
      // another request already consumed aborts this tx (no debit).
      if (!(await markOtpUsed(tx, otpId))) {
        throw new UnauthorizedException('No active OTP found. Please restart the redemption.');
      }

      // Debit via the canonical wallet write-path (passbook + ledger). Throws 400
      // on insufficient balance → whole tx (incl. the claim) rolls back.
      await this.wallet.debitRedeem(
        order.partnerId,
        requiredPoints,
        { referenceId: order.id, description: `Redemption ${order.orderNumber}` },
        tx,
      );

      // H1 — guarded stock claim: only decrement if enough stock remains, so
      // concurrent confirms of the last unit can't oversell. If the claim fails,
      // the whole tx (incl. debit) rolls back → order stays PENDING, no debit.
      if (order.reward?.stockQuantity != null) {
        const stockClaim = await tx.rewardCatalog.updateMany({
          where: { id: order.rewardId, stockQuantity: { gte: order.quantity } },
          data: { stockQuantity: { decrement: order.quantity } },
        });
        if (stockClaim.count === 0) {
          throw new BadRequestException('Reward is out of stock');
        }
        const fresh = await tx.rewardCatalog.findFirst({
          where: { id: order.rewardId },
          select: { stockQuantity: true },
        });
        if (fresh?.stockQuantity != null && fresh.stockQuantity <= 0) {
          await tx.rewardCatalog.update({
            where: { id: order.rewardId },
            data: { status: 'OUT_OF_STOCK' },
          });
        }
      }

      // P6 BRIDGE — create an unbatched PayoutTransaction for cash redemptions
      // (UPI / BANK_TRANSFER) so the payout engine can settle the INR later.
      //
      // GATE: only UPI and BANK_TRANSFER modes carry real money; GIFT_CARD,
      // PHYSICAL_GIFT, VOUCHER, and any future non-cash mode are fulfilled by
      // the rewards engine itself and do NOT need a payout.
      //
      // DOUBLE-PAYOUT GUARD: this create runs ONLY inside the tx that won the
      // PENDING→CONFIRMED claim (the `updateMany` above). A concurrent confirm
      // matches 0 rows in that claim and throws ConflictException before it ever
      // reaches here, so a single RedemptionOrder can produce at most one
      // PayoutTransaction. No extra findFirst guard is needed; we rely on the
      // exclusive claim. (If a future retry somehow reaches here after a partial
      // write, the DB-level unique-ish on redemptionOrderId is not enforced by
      // schema, but the claim gate prevents the scenario in practice.)
      //
      // AMOUNT: amountPaise = valuePaise frozen in the claim above. valuePaise
      // may be null if the order was created before the freeze column existed; we
      // fall back to 0n and log a warning so an admin can correct it.
      //
      // BENEFICIARY SNAPSHOT: we snapshot the partner's KYC-verified bank/UPI
      // fields at confirm time so the payout record is self-contained and immune
      // to later KYC edits.
      if (
        order.redemptionMode === 'UPI' ||
        order.redemptionMode === 'BANK_TRANSFER'
      ) {
        // Fetch full partner for bank snapshot inside the tx. SECURITY INVARIANT:
        // keyed by order.partnerId (== the resolved active partner) + clientId — the
        // payout beneficiary is the switched outlet, never re-resolved from user.sub.
        const partnerSnap = await tx.channelPartner.findFirst({
          where: { id: order.partnerId, clientId: user.clientId },
          select: {
            bankAccountHolder: true,
            ownerName: true,
            upiId: true,
            bankAccountNumber: true,
            ifscCode: true,
            bankName: true,
          },
        });

        // valuePaise is set by the claim update just above; the re-read is not
        // needed — we computed it in `valuePaise` (BigInt) in this scope.
        //
        // MINOR: this zero-value fallback is only reachable for non-cash modes
        // (GLB-2 throws first for UPI/BANK_TRANSFER when valuePaise=0n). It is kept
        // for defence-in-depth but must NEVER be reached in cash paths.
        const amountPaise: bigint =
          valuePaise != null && valuePaise > 0n ? valuePaise : (() => {
            this.logger.warn(
              `[confirmRedeem] valuePaise null/zero for order ${order.id} — PayoutTransaction created with amountPaise=0; manual correction required (non-cash path only)`,
            );
            return 0n;
          })();

        // MONEY-PATH: the actual payout RAIL follows the partner's ON-FILE
        // beneficiary, NOT the catalogue item's redemptionMode. UPI is preferred
        // when present (mirrors the partner-facing payout target + the credit rail),
        // else the bank rail. This decouples the (now unified "Cash Payout")
        // catalogue mode from the real disbursement channel, so a cash item can
        // never misroute a UPI-only partner onto the bank rail (or vice-versa).
        //
        // CONVENTION (finance / reconciliation): order.redemptionMode (the reward TYPE —
        // "Cash Payout" is stored as BANK_TRANSFER) may now legitimately DIFFER from this
        // payoutMode (the disbursement RAIL). Rail / bank-file questions → read
        // payoutTransaction.payoutMode; reward-type questions → order.redemptionMode.
        // NEVER assume the two are equal.
        const payoutMode: 'UPI' | 'BANK_TRANSFER' = partnerSnap?.upiId
          ? 'UPI'
          : 'BANK_TRANSFER';

        await tx.payoutTransaction.create({
          data: {
            partnerId: order.partnerId,
            redemptionOrderId: order.id,
            payoutMode,
            status: 'PENDING',
            batchId: null,           // unbatched — GIFSY admin assigns to a batch later
            amountPaise,
            netAmountPaise: amountPaise,  // TDS computed later by payouts.processBatch
            tdsPaise: 0n,
            tdsApplicable: false,
            beneficiaryName: partnerSnap?.bankAccountHolder ?? partnerSnap?.ownerName ?? null,
            upiId: partnerSnap?.upiId ?? null,
            bankAccountNumber: partnerSnap?.bankAccountNumber ?? null,
            ifscCode: partnerSnap?.ifscCode ?? null,
            bankName: partnerSnap?.bankName ?? null,
          },
        });

        this.logger.log(
          `[confirmRedeem] PayoutTransaction created for order ${order.id} (rail=${payoutMode}, ${amountPaise} paise)`,
        );
      }
    });

    // ── Hubble auto-issuance (Bajaj-only, feature-flagged; default OFF) ───────────
    // When the confirmed item is a GIFT_CARD carrying a Hubble productId AND the tenant
    // has features.hubbleVoucherEnabled, issue the Amazon Pay voucher automatically now
    // (points were already debited inside the committed tx above — never issue without a
    // successful debit). Deoleo / flag-off / non-Hubble items short-circuit to the EXACT
    // existing manual-fulfilment path below — BYTE-IDENTICAL (isHubbleEligible checks the
    // productId with NO DB read first, so a non-Hubble GIFT_CARD never even reads the flag).
    if (await this.isHubbleEligible(order, user.clientId)) {
      return await this.finishHubbleConfirm(order, {
        clientId: user.clientId,
        actorId: user.sub,
        notifyUserId: user.sub,
        recipientPhone: order.partner?.phone ?? user.phone ?? null,
        ownerName: order.partner?.ownerName ?? user.name ?? 'Partner',
        rewardName: order.reward?.name ?? '',
        points: requiredPoints,
      });
    }

    // Redemption-confirmed notification on commit: bell feed (IN_APP) + PUSH to the redeeming
    // partner user, PLUS the config-driven SMS/WhatsApp to the OWNER — via the single canonical
    // notifyUserWithChannels path. The dead direct SMS enqueue is removed; SMS now flows through
    // the config path (default OFF until a tenant enables it). Fire-and-forget.
    await this.notifications.notifyUserWithChannels({
      clientId: user.clientId,
      // Free channels (IN_APP + PUSH) still address the acting user (self-redeem submitter).
      userId: user.sub,
      eventKey: 'REDEMPTION_CONFIRMED',
      // Paid-channel recipient = the OUTLET OWNER, consistent with every other event. For a
      // switched-sibling redemption the acting login (user.phone/name) can differ from the outlet
      // owner; the paid message must reach the owner. Falls back to the acting user if the owner
      // fields are somehow absent.
      recipientPhone: order.partner?.phone ?? user.phone ?? null,
      vars: {
        ownerName: order.partner?.ownerName ?? user.name ?? 'Partner',
        rewardName: order.reward?.name ?? '',
        points: requiredPoints,
      },
      subject: 'Redemption confirmed',
      body: 'Your redemption is confirmed.',
      url: '/partner/rewards',
      event: 'REDEMPTION_CONFIRMED',
    });

    return {
      orderId: order.id,
      status: 'CONFIRMED',
      message: 'Redemption confirmed. Your order is being processed.',
    };
  }

  /**
   * POST /v1/rewards/orders/:id/transition — GIFSY-only guarded status change.
   *
   * Allowed edges (anything else → 400):
   *   PENDING    → CANCELLED
   *   CONFIRMED  → PROCESSING | CANCELLED | RETURNED
   *   PROCESSING → DISPATCHED | FAILED | CANCELLED
   *   DISPATCHED → DELIVERED | RETURNED
   *
   * REFUND GUARD: when leaving a state where points were already debited
   * (pointsDeducted > 0) into CANCELLED/RETURNED/FAILED, re-credit via
   * WalletService.reverse and zero pointsDeducted in the SAME tx, so a
   * double-cancel can never double-refund.
   *
   * Inline voucher/tracking entry rides on this call (per-order fulfilment).
   */
  async transitionOrder(user: JwtPayload, id: string, dto: TransitionOrderDto) {
    // A lost PIN-add race against an IDENTICAL PIN (double submit) is retried once: the PIN is then
    // an idempotent no-op, and the status move either already happened (→ the skipped path) or runs.
    return withPinRaceRetry(() => this.transitionOrderOnce(user, id, dto));
  }

  private async transitionOrderOnce(user: JwtPayload, id: string, dto: TransitionOrderDto) {
    // Tenant scope by partner.clientId (§12 — partner.user.clientId misses login-less
    // sibling outlets). platformWide (un-assumed OWNER) → cross-tenant, which powers
    // the Gifsy fulfilment console; an assumed operator is pinned to that tenant.
    const scope = tenantScope(user);
    const order = await this.prisma.redemptionOrder.findFirst({
      where: { id, ...(scope ? { partner: { clientId: scope } } : {}) },
      include: { partner: { select: { clientId: true } } },
    });
    if (!order) throw new NotFoundException('Order not found');
    // The ORDER's tenant — notifications/templates + the tenant-wide cancelled-code lookup.
    const orderClientId = order.partner?.clientId ?? user.clientId;

    const toStatus = dto.toStatus as unknown as RedemptionStatus;

    // IDEMPOTENT (§12): a request for the CURRENT state is a no-op — skip the
    // transition AND the member notification (de-dupes bulk re-uploads / retries).
    // Fill values supplied alongside (voucher code/provider, tracking number/URL — e.g. a bulk sheet
    // row whose New Status is the current one) are NOT silently dropped: they are applied through
    // the guarded non-status write (updateOrder — same voucher invariant, audit + notification).
    if (order.status === toStatus) {
      if (
        dto.voucherCode !== undefined ||
        dto.voucherPin !== undefined ||
        dto.voucherProvider !== undefined ||
        dto.trackingNumber !== undefined ||
        dto.trackingUrl !== undefined
      ) {
        const res = await this.updateOrder(user, id, {
          voucherCode: dto.voucherCode,
          voucherPin: dto.voucherPin,
          voucherProvider: dto.voucherProvider,
          trackingNumber: dto.trackingNumber,
          trackingUrl: dto.trackingUrl,
          manualOverride: dto.manualOverride,
          overrideReason: dto.overrideReason,
        });
        return { order: res.order, skipped: true as const };
      }
      return { order, skipped: true as const };
    }

    const allowed: Record<string, RedemptionStatus[]> = {
      PENDING: [RedemptionStatus.CANCELLED],
      CONFIRMED: [RedemptionStatus.PROCESSING, RedemptionStatus.CANCELLED, RedemptionStatus.RETURNED],
      PROCESSING: [RedemptionStatus.DISPATCHED, RedemptionStatus.FAILED, RedemptionStatus.CANCELLED],
      DISPATCHED: [RedemptionStatus.DELIVERED, RedemptionStatus.RETURNED],
      // DELIVERED→RETURNED (Gifsy-only) — the v1 value-reversal edge (§12). Gated to
      // gifts by the cash-mode block below; refunds points + zeroes valuePaise.
      DELIVERED: [RedemptionStatus.RETURNED],
    };
    const fromStatus = order.status;
    if (!(allowed[fromStatus] ?? []).includes(toStatus)) {
      throw new BadRequestException(`Illegal status transition: ${fromStatus} → ${toStatus}`);
    }

    const isRefundTarget =
      toStatus === RedemptionStatus.CANCELLED ||
      toStatus === RedemptionStatus.RETURNED ||
      toStatus === RedemptionStatus.FAILED;

    // INR (cash) redemptions cannot be manually reversed once OTP-confirmed: the
    // bank transfer happens offline and reversal is driven ONLY by an uploaded
    // UTR=FAILED (payouts.uploadPayoutUtr, which marks the order FAILED + refunds
    // points + flips the PayoutTransaction together). A manual transitionOrder to
    // ANY refund target (CANCELLED / RETURNED / FAILED) would re-credit the points
    // while leaving the PayoutTransaction PENDING and still payable → double-payout
    // (BUG-1). So block every refund-target edge for cash modes, not just CANCELLED.
    // Non-refund progressions (PROCESSING/DISPATCHED/DELIVERED) and non-cash
    // redemptions (gift card / physical gift) are unaffected.
    const isCashMode =
      order.redemptionMode === PayoutMode.UPI ||
      order.redemptionMode === PayoutMode.BANK_TRANSFER;
    if (isCashMode && isRefundTarget) {
      throw new BadRequestException(
        'INR redemptions cannot be cancelled, returned or failed manually once confirmed; ' +
          'reversal is driven only by an uploaded UTR=FAILED.',
      );
    }

    // C-3 — cash redemptions are OUT of the dispatch module. The forward dispatch edges
    // (→PROCESSING/DISPATCHED/DELIVERED) are otherwise mode-agnostic, so an operator could
    // manually march a CASH-mode order (UPI/BANK_TRANSFER) to DELIVERED via the console,
    // wrongly pulling it into 194R Source-2 (which sums DELIVERED valuePaise). Cash settles
    // ONLY via the UTR/payout rail (payouts.service sets DELIVERED directly, NOT through
    // this method), so reject forward dispatch moves here. Refund targets are already
    // blocked above; this closes the forward direction.
    const isForwardDispatchTarget =
      toStatus === RedemptionStatus.PROCESSING ||
      toStatus === RedemptionStatus.DISPATCHED ||
      toStatus === RedemptionStatus.DELIVERED;
    if (isCashMode && isForwardDispatchTarget) {
      throw new BadRequestException(
        'Cash redemptions are settled via payout, not the dispatch workflow.',
      );
    }

    // AUDIT-FIX (money / double-benefit): a Hubble-issued digital voucher is irreversible —
    // Hubble has no cancel/clawback, so once issued the member holds a live Amazon Pay
    // voucher, exactly like a completed cash payout. A manual refund-target transition
    // (CANCELLED / RETURNED / FAILED) would re-credit the points while the voucher stays
    // live → double benefit; it would also clobber a DELIVERED order under a confirm↔webhook
    // race. Block it: Hubble failures auto-refund via the issuance path, never here.
    // (Deoleo / non-Hubble orders carry no Hubble marker → unaffected.)
    // Any Hubble marker (not just provider='Hubble'): an order handed to Hubble may hold a live
    // voucher Hubble issued (INDETERMINATE / PROCESSING_NOT_FOUND …) — never refund it by hand.
    // Ops exits: "Retry with Hubble" (reconcile) or a GIFSY_ADMIN "Fulfil manually" override.
    // EXCEPT an order whose only Hubble trace proves nothing was ever placed (NOT_CONFIGURED /
    // INVALID_AMOUNT, no code): Hubble never held a voucher, so a manual refund is safe.
    if (hasHubbleMarkers(order) && isRefundTarget && !isHubbleNeverPlaced(order)) {
      throw new BadRequestException(
        'An order sent to Hubble cannot be cancelled, returned or failed manually ' +
          '(a Hubble voucher may exist). Retry with Hubble, or fulfil it manually.',
      );
    }

    // ISSUED-VOUCHER REFUND BLOCK (owner money rule, ALL providers): a refund edge on an order
    // holding a voucher code (stored, or supplied on this very call) would refund the points
    // while the member keeps a live code. Ops must record "Voucher cancelled with vendor" first
    // (clears the code under audit). Covers the console, the dispatch controller and the bulk
    // fulfilment upload — all three route through here. The claim below re-checks it atomically.
    if (isRefundTarget && (hasIssuedVoucher(order.voucherCode) || hasIssuedVoucher(dto.voucherCode))) {
      throw new BadRequestException(VOUCHER_ISSUED_REFUND_BLOCK_MESSAGE);
    }

    // VOUCHER WRITE INVARIANT (every edge): no clear / blank, no overwrite of a stored code, a new
    // code only on a paid open order — and the status claim carries the voucher CAS.
    const voucherInput = {
      voucherCode: dto.voucherCode,
      voucherProvider: dto.voucherProvider,
      voucherPin: dto.voucherPin,
    };
    const voucherPlan = planVoucherWrite(
      order,
      voucherInput,
      this.voucherWriteOptions(user, dto),
    );

    // BUG-1 — a DIGITAL_VOUCHER order cannot be marked DELIVERED without an actual voucher
    // code to deliver. The effective channel is the stored one unless this transition
    // overrides it (same precedence the update below uses: dto value wins, else unchanged);
    // likewise the effective code is the one supplied on this call or already stored.
    const effectiveChannel = dto.fulfilmentChannel ?? order.fulfilmentChannel;
    const effectiveVoucherCode = dto.voucherCode ?? order.voucherCode;
    if (
      toStatus === RedemptionStatus.DELIVERED &&
      effectiveChannel === GiftFulfilmentChannel.DIGITAL_VOUCHER &&
      !effectiveVoucherCode?.trim()
    ) {
      throw new BadRequestException(
        'A voucher code is required before a digital voucher order can be marked delivered.',
      );
    }

    const now = new Date();
    const data: Omit<Prisma.RedemptionOrderUpdateManyMutationInput, 'status'> = {
      ...voucherPlan.data, // only a validated NEW code/provider — never a clear or an overwrite
      trackingNumber: dto.trackingNumber,
      trackingUrl: dto.trackingUrl,
      notes: dto.notes,
      // Dispatch fields (§5) — the fulfilment console stamps these alongside a status
      // move. All optional; undefined leaves the stored value unchanged.
      fulfilmentChannel: dto.fulfilmentChannel,
      logisticsPartner: dto.logisticsPartner,
      supplierOrderRef: dto.supplierOrderRef,
      podUrl: dto.podUrl,
    };
    if (toStatus === RedemptionStatus.DISPATCHED) data.dispatchedAt = now;
    if (toStatus === RedemptionStatus.DELIVERED) data.deliveredAt = now;
    if (toStatus === RedemptionStatus.CANCELLED) data.cancelledAt = now;
    // RETURNED value-reversal (§12): zero valuePaise so 194R Source-2 (sums DELIVERED
    // valuePaise per PAN) and the Gift Disbursal report drop it — no permanent
    // over-count. Points are refunded by the isRefundTarget claim below.
    if (toStatus === RedemptionStatus.RETURNED) data.valuePaise = 0n;

    const updated = await this.prisma.$transaction(async (tx) => {
      // Tenant-wide cancelled-code check under the (tenant, code) advisory lock (no row write).
      if (voucherPlan.issuesNewCode && voucherPlan.data.voucherCode) {
        await assertVoucherCodeReusableInTx(tx, orderClientId, voucherPlan.data.voucherCode);
      }
      // RACE GUARD (FIRST write in the tx): compare-and-set the status on the `fromStatus` we
      // read + validated above. A concurrent transition / stale read that already moved the
      // order makes this claim match 0 rows → 409, rolling back the whole tx — so the loser
      // writes NO history row and runs NO refund. The winner holds the row lock from here on.
      const moved = await transitionOrderStatusOrConflict(tx, {
        orderId: id,
        expectedFrom: fromStatus,
        // A refund only lands if NO voucher code is on the row at write time (a code set
        // concurrently after our read → 0 rows → 409, no refund).
        extraGuard: combineGuards(isRefundTarget ? noIssuedVoucherGuard(order.voucherCode) : null, voucherPlan.guard),
        toStatus,
        data,
        changedById: user.sub,
        notes: dto.notes,
      });
      if (voucherPlan.issuesNewCode && voucherPlan.data.voucherCode) {
        await recordVoucherIssuedAudit(tx, {
          actorId: user.sub,
          orderId: id,
          code: voucherPlan.data.voucherCode,
          pin: voucherPlan.data.voucherPin ?? null,
          provider: voucherPlan.data.voucherProvider ?? order.voucherProvider,
          path: 'POST /rewards/orders/:id/transition',
          overrideReason: voucherPlan.overridden ? dto.overrideReason?.trim() : null,
        });
      }
      if (voucherPlan.addsPin && order.voucherCode) {
        await recordVoucherIssuedAudit(tx, {
          actorId: user.sub,
          orderId: id,
          code: order.voucherCode,
          pin: voucherPlan.data.voucherPin ?? null,
          provider: order.voucherProvider,
          path: 'POST /rewards/orders/:id/transition',
          event: 'VOUCHER_PIN_ADDED_MANUAL',
        });
      }

      // M2 — refund at most ONCE: atomically claim the debited points
      // (pointsDeducted > 0 → 0). Only the tx that wins the claim re-credits, so
      // two concurrent refund-bound transitions can't double-refund. The amount is the
      // in-tx value read under the row lock (not the pre-tx read).
      // STOCK: intentionally NOT restored here (owner decision 2026-08-19) — a
      // confirmed redemption consumes its stock unit permanently; cancel / return
      // / failed refunds POINTS only. See the STOCK RULE note near the catalog CRUD.
      if (isRefundTarget && moved.pointsDeducted > 0) {
        const refundClaim = await tx.redemptionOrder.updateMany({
          where: { id, pointsDeducted: { gt: 0 } },
          data: { pointsDeducted: 0 },
        });
        if (refundClaim.count > 0) {
          await this.wallet.reverse(
            order.partnerId,
            moved.pointsDeducted,
            { referenceId: id, description: `Refund ${order.orderNumber}` },
            tx,
          );
          return { ...moved, pointsDeducted: 0 };
        }
      }
      return moved;
    }).catch((e: unknown) =>
      rethrowUnlessIdempotentPinRace(e, voucherPlan, order, voucherInput, () =>
        this.prisma.redemptionOrder.findUnique({ where: { id }, select: { voucherCode: true, voucherPin: true } }),
      ),
    );

    // A voucher code assigned on THIS transition (null → set) — computed before the milestone notify
    // so a single action never fires BOTH a generic milestone bell AND the VOUCHER_ISSUED code bell
    // (the code message supersedes the milestone). A set-once PIN ADDED to an already-issued code is
    // different: the code was already delivered, so the member gets BOTH the re-sent voucher (now
    // with the PIN) AND the normal milestone (with tracking) for the status change.
    const voucherNewlyIssued = !order.voucherCode && !!updated.voucherCode;
    const voucherResent = voucherNewlyIssued || voucherPlan.addsPin;

    // Notify the partner on the customer-visible milestones — UNLESS this same transition just issued
    // the voucher code, in which case the VOUCHER_ISSUED message below supersedes the generic milestone.
    if (
      !voucherNewlyIssued &&
      (toStatus === RedemptionStatus.DISPATCHED ||
        toStatus === RedemptionStatus.DELIVERED ||
        toStatus === RedemptionStatus.CANCELLED)
    ) {
      const partner = await this.prisma.channelPartner.findFirst({
        where: { id: order.partnerId },
        select: { userId: true, phone: true, ownerName: true },
      });
      if (partner?.userId) {
        // Fan the customer-visible milestone out to the bell feed (IN_APP) + PUSH AND the
        // config-driven SMS/WhatsApp to the OWNER — via the single canonical path. The dead
        // direct SMS enqueue is removed; the ORDER_* paid channels default OFF until a tenant
        // enables them. Best-effort: never throws into the transition path.
        await this.notifications.notifyUserWithChannels({
          clientId: orderClientId, // the ORDER's tenant (a platform-wide Gifsy caller is 'gifsy')
          userId: partner.userId,
          eventKey: `ORDER_${toStatus}` as EventKey,
          recipientPhone: partner.phone ?? null,
          vars: {
            ownerName: partner.ownerName ?? 'Partner',
            orderId: order.orderNumber,
            trackingId: dto.trackingNumber ?? '',
            reason: dto.notes ?? '',
          },
          subject: 'Redemption update',
          body: `Your redemption ${order.orderNumber} is now ${toStatus}.`,
          url: '/partner/rewards',
          event: `REDEMPTION_${toStatus}`,
        });
      }
    }

    // Manual voucher fulfilment: a code was JUST assigned (null → set) on this transition, at
    // whatever status ops issues it — or a PIN was just added to the issued code. Send the owner the
    // code (bell + WhatsApp `voucher_code`). Fires once (guarded on the prior value / the set-once
    // PIN claim) and only for the outlet owner. Best-effort.
    if (voucherResent) {
      await this.notifyVoucherIssued(id, orderClientId);
    }

    return { order: updated };
  }

  /**
   * POST /v1/rewards/orders/:id/voucher-cancelled — "Voucher cancelled with vendor" (GIFSY_ADMIN).
   *
   * Records that ops cancelled the issued voucher with its vendor, CLEARING the code (+ provider)
   * so the issued-voucher refund block lifts and a refund transition becomes possible. One tx:
   *   1. compare-and-set on the CURRENT code (`updateMany where { id, voucherCode: <read> }`):
   *      a double-click / concurrent edit makes the loser match 0 rows → 409, no audit row;
   *   2. an AuditLog row (who = actorId, when = createdAt, reason, last 4 of the cleared code —
   *      NEVER the full code; it is a bearer credential).
   * Status is NOT changed (the refund is a separate, normal transition), so no member timeline row.
   * Hubble-issued vouchers are refused: Hubble has no cancel/clawback (they stay non-reversible).
   */
  async voucherCancelledWithVendor(user: JwtPayload, id: string, reason: string) {
    // Owner rule: GIFSY_ADMIN only (the route's @Roles would otherwise admit a permissioned
    // GIFSY_STAFF via RolesGuard deferral) — never CLIENT_ADMIN / vendors.
    if (user.role !== 'GIFSY_ADMIN') {
      throw new ForbiddenException('Only a Gifsy admin can record a vendor voucher cancellation.');
    }
    const why = (reason ?? '').trim();
    if (!why) throw new BadRequestException('A reason is required.');

    const scope = tenantScope(user);
    const order = await this.prisma.redemptionOrder.findFirst({
      where: { id, ...(scope ? { partner: { clientId: scope } } : {}) },
      select: {
        id: true, orderNumber: true, status: true, voucherCode: true, voucherProvider: true, metadata: true,
        partner: { select: { clientId: true } },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (!hasIssuedVoucher(order.voucherCode)) {
      throw new ConflictException('This order has no voucher code to cancel — refresh and try again.');
    }
    // Only a code HUBBLE ISSUED is non-reversible. A MANUAL code on an order whose only Hubble
    // trace is an ops flag (HUBBLE_SUCCESS_MANUAL_CODE_PRESENT / HUBBLE_FAILED_VOUCHER_PRESENT, or
    // a manual-fulfilment override) is a normal vendor voucher and may be cancelled.
    if (isHubbleIssuedCode(order)) {
      throw new BadRequestException(
        'A Hubble-issued voucher cannot be cancelled with the vendor; it is non-reversible once issued.',
      );
    }
    const orderClientId = order.partner?.clientId ?? user.clientId;
    const meta = (order.metadata && typeof order.metadata === 'object' && !Array.isArray(order.metadata)
      ? order.metadata
      : {}) as Record<string, unknown>;
    const releaseHubble: Prisma.InputJsonValue | null =
      meta.hubbleReconcileReason === 'HUBBLE_FAILED_VOUCHER_PRESENT'
        ? ({
            ...meta,
            hubbleNeedsReconcile: false,
            hubbleStatus: 'RELEASED',
            hubbleReleasedAt: new Date().toISOString(),
            hubbleReleasedBy: user.sub,
          } as Prisma.InputJsonValue)
        : null;

    const code = order.voucherCode as string;
    // Never the full code anywhere (audit / logs): the same last-4 mask the tenant-admin list uses.
    const masked = maskVoucherCode(code);
    const updated = await this.prisma.$transaction(async (tx) => {
      // Same (tenant, code) advisory lock every issuance takes before its reuse check — so an
      // issuance racing this cancel either sees the recorded hash or finishes before it.
      await lockVoucherCode(tx, orderClientId, code);
      const claim = await tx.redemptionOrder.updateMany({
        // CAS on the code read AND never a Hubble voucher (a provider stamped concurrently loses).
        // OR-wrapped: a bare `{ not: 'Hubble' }` would also drop NULL-provider rows (SQL NULL).
        where: {
          id,
          voucherCode: code,
          OR: [
            { voucherProvider: null },
            // Case-insensitive "not Hubble" (NULL handled by the branch above).
            { NOT: { voucherProvider: { equals: 'hubble', mode: 'insensitive' } } },
          ],
        },
        data: {
          voucherCode: null,
          // The PIN belongs to the cancelled card — cleared with it (never reuse-checked).
          voucherPin: null,
          voucherProvider: null,
          // HUBBLE_FAILED_VOUCHER_PRESENT: Hubble definitively FAILED (no Hubble voucher exists) and
          // the only code was this manual one — once it is cancelled the order is a plain order
          // again, so release the Hubble flag (otherwise the refund block would dead-end it).
          // HUBBLE_SUCCESS_MANUAL_CODE_PRESENT stays flagged: Hubble DID issue a voucher.
          ...(releaseHubble ? { metadata: releaseHubble } : {}),
        },
      });
      if (claim.count === 0) {
        throw new ConflictException('The voucher code changed — refresh and try again.');
      }
      // Remember the cancelled code TENANT-WIDE (sha256 of the normalised code — never the code)
      // so no stale sheet / request can re-issue it on ANY order of this tenant.
      await tx.cancelledVoucherCode.createMany({
        data: [{ clientId: orderClientId, codeHash: hashVoucherCode(code), orderId: id, cancelledById: user.sub }],
        skipDuplicates: true,
      });
      await tx.auditLog.create({
        data: {
          actorId: user.sub,
          action: 'UPDATE',
          entityType: 'REDEMPTION_ORDER',
          entityId: id,
          metadata: {
            event: 'VOUCHER_CANCELLED_WITH_VENDOR',
            orderNumber: order.orderNumber,
            status: order.status,
            reason: why,
            clearedVoucherCode: masked, // "••••" + last 4 (fully masked if < 12 chars)
            clearedVoucherProvider: order.voucherProvider ?? null,
          },
        },
      });
      // The response never carries the code (cleared anyway) — no voucherCode in the select.
      return tx.redemptionOrder.findUniqueOrThrow({
        where: { id },
        select: { id: true, status: true, voucherProvider: true, updatedAt: true },
      });
    });

    this.logger.log(
      `order ${order.orderNumber}: voucher (${masked}) recorded cancelled with vendor by ${user.sub}`,
    );
    // voucherCode: null states the post-condition explicitly (the row's code was just cleared).
    return { order: { ...updated, voucherCode: null, voucherPin: null } };
  }

  /**
   * POST /v1/rewards/orders/:id/hubble-reconcile — "Retry with Hubble" (GIFSY_ADMIN only): the ops
   * exit for an order flagged hubbleNeedsReconcile. Runs the EXISTING webhook reconcile
   * (get-by-reference → apply the authoritative Hubble state idempotently; never places a new
   * Hubble order, never refunds off a miss) for this one order, and audits who ran it + the outcome.
   */
  async retryHubbleReconcile(user: JwtPayload, id: string) {
    if (user.role !== 'GIFSY_ADMIN') {
      throw new ForbiddenException('Only a Gifsy admin can retry a Hubble reconcile.');
    }
    const scope = tenantScope(user);
    const order = await this.prisma.redemptionOrder.findFirst({
      where: { id, ...(scope ? { partner: { clientId: scope } } : {}) },
      select: { id: true, orderNumber: true, status: true, metadata: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    const before = (order.metadata as Record<string, unknown> | null)?.hubbleReconcileReason ?? null;
    const outcome = await this.reconcileHubbleOrder(order.id);
    await this.prisma.auditLog.create({
      data: {
        actorId: user.sub,
        action: 'UPDATE',
        entityType: 'REDEMPTION_ORDER',
        entityId: order.id,
        metadata: {
          event: 'HUBBLE_RECONCILE_RETRY',
          orderNumber: order.orderNumber,
          statusBefore: order.status,
          reconcileReasonBefore: before as Prisma.InputJsonValue,
          outcome,
        },
      },
    });
    return { orderId: order.id, outcome };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // P5.4b — BULK fulfilment (Gifsy-ops download → fill → upload), mirroring the
  // payout/target download→fill→upload flow and reusing the shared xlsx helper
  // (src/common/xlsx.ts is the multi-sheet builder; this single-sheet template +
  // its parser live in rewards-fulfilment.helpers.ts, matching the P4
  // targets.helpers.ts split: a pure, DI-free build/parse pair).
  //
  // The upload APPLIES each row through the EXISTING guarded transitionOrder /
  // updateOrder — no status logic is reimplemented here, so every row inherits
  // the edge-map validation, RedemptionStatusHistory, timestamp stamping,
  // refund-on-cancel and partner notification. One bad row never aborts the batch.
  //
  // The fulfilment-actionable set (orders that NEED a voucher or tracking):
  //   GIFT_CARD     → CONFIRMED / PROCESSING       (need a voucherCode)
  //   PHYSICAL_GIFT → CONFIRMED / PROCESSING / DISPATCHED (need tracking)
  // A `?status=` or `?mode=` query narrows it further.
  // ───────────────────────────────────────────────────────────────────────────

  /** PayoutMode → the statuses that are actionable for fulfilment. */
  private fulfilmentStatusesFor(mode: PayoutMode): RedemptionStatus[] {
    if (mode === PayoutMode.PHYSICAL_GIFT) {
      return [RedemptionStatus.CONFIRMED, RedemptionStatus.PROCESSING, RedemptionStatus.DISPATCHED];
    }
    // GIFT_CARD / VOUCHER (and any cash mode that still surfaces here) → voucher entry.
    return [RedemptionStatus.CONFIRMED, RedemptionStatus.PROCESSING];
  }

  /**
   * GET /v1/admin/rewards/fulfilment/template — download an .xlsx of the tenant's
   * orders awaiting fulfilment. Tenant-scoped; default rows = the per-mode
   * actionable set, narrowable by `?status=` and `?mode=`.
   */
  async getFulfilmentTemplate(user: JwtPayload, q: FulfilmentTemplateQueryDto): Promise<Buffer> {
    // Tenant scope by partner.clientId (§12); platformWide OWNER → all tenants.
    const scope = tenantScope(user);
    const where: Prisma.RedemptionOrderWhereInput = {
      ...(scope ? { partner: { clientId: scope } } : {}),
    };
    if (q.mode) where.redemptionMode = q.mode;

    if (q.status) {
      where.status = q.status;
    } else {
      // Union of the actionable statuses across the relevant mode(s).
      const modes: PayoutMode[] = q.mode
        ? [q.mode]
        : [PayoutMode.GIFT_CARD, PayoutMode.PHYSICAL_GIFT];
      const statuses = new Set<RedemptionStatus>();
      for (const m of modes) for (const s of this.fulfilmentStatusesFor(m)) statuses.add(s);
      where.status = { in: [...statuses] };
    }

    const orders = await this.prisma.redemptionOrder.findMany({
      where,
      include: { reward: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return buildFulfilmentTemplateBuffer(
      orders.map((o) => ({
        orderNumber: o.orderNumber,
        reward: o.reward?.name ?? '',
        mode: o.redemptionMode,
        currentStatus: o.status,
      })),
    );
  }

  /**
   * POST /v1/admin/rewards/fulfilment/upload — parse a filled fulfilment sheet
   * and apply each row.
   *
   * Per row:
   *   • Match `Order Number` → the tenant's RedemptionOrder (cross-tenant / unknown
   *     → collected as an error, batch continues).
   *   • `New Status` PRESENT → apply via the guarded `transitionOrder` (carries the
   *     voucher/tracking from the row). NEW-STATUS-BLANK DECISION: a blank New
   *     Status means "no status change" → we route through the non-status
   *     `updateOrder` path to set voucherCode/voucherProvider/tracking only (so an
   *     ops user can stamp a voucher code without forcing a transition).
   *   • An unknown / illegal New Status value, an illegal edge, or any per-row
   *     throw is caught and collected; the batch is NOT aborted.
   *
   * Returns { processed, succeeded, failed, errors:[{ row, orderNumber, message }] }
   * (mirrors the P4 achievement-upload result shape).
   */
  async uploadFulfilment(user: JwtPayload, file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded');

    // A malformed/corrupt/non-template workbook → clean 400 (like the P4 parser).
    let parsed: ReturnType<typeof parseFulfilmentUploadBuffer>;
    try {
      parsed = parseFulfilmentUploadBuffer(file.buffer);
    } catch {
      throw new BadRequestException(
        'Invalid or unrecognized fulfilment file — download the template, fill it, and re-upload',
      );
    }

    const validStatuses = new Set<string>(Object.values(UpdatableOrderStatus));
    const errors: { row: number; orderNumber: string; message: string }[] = [];
    let succeeded = 0;
    let skipped = 0;
    // Tenant scope by partner.clientId (§12); platformWide OWNER → cross-tenant.
    const scope = tenantScope(user);

    for (const r of parsed.rows) {
      // A parse-level row error (e.g. a Voucher Code / PIN cell Excel stored as a NUMBER — its
      // leading zeros / digits may already be lost) — collected, the row is NOT applied.
      if (r.error) {
        errors.push({ row: r.rowIndex, orderNumber: r.orderNumber, message: r.error });
        continue;
      }
      try {
        // Resolve the order in-scope; collect (don't throw) on a miss/cross-tenant.
        const order = await this.prisma.redemptionOrder.findFirst({
          where: { orderNumber: r.orderNumber, ...(scope ? { partner: { clientId: scope } } : {}) },
          select: { id: true },
        });
        if (!order) {
          errors.push({
            row: r.rowIndex,
            orderNumber: r.orderNumber,
            message: 'Order not found in this tenant',
          });
          continue;
        }

        if (r.newStatus) {
          if (!validStatuses.has(r.newStatus)) {
            errors.push({
              row: r.rowIndex,
              orderNumber: r.orderNumber,
              message: `Unknown New Status "${r.newStatus}"`,
            });
            continue;
          }
          // Guarded transition — reuses the edge-map, history, timestamps,
          // refund-on-cancel and partner notification.
          await this.transitionOrder(user, order.id, {
            toStatus: r.newStatus as UpdatableOrderStatus,
            voucherCode: r.voucherCode,
            voucherPin: r.voucherPin,
            voucherProvider: r.voucherProvider,
            trackingNumber: r.trackingNumber,
            trackingUrl: r.trackingUrl,
          });
        } else {
          // No status change → non-status write (voucher/tracking only). If every
          // fill column is blank too, the row changes nothing (e.g. an unmodified
          // template re-uploaded) — skip it so the success count isn't inflated.
          if (
            !r.voucherCode &&
            !r.voucherPin &&
            !r.voucherProvider &&
            !r.trackingNumber &&
            !r.trackingUrl
          ) {
            skipped++;
            continue;
          }
          await this.updateOrder(user, order.id, {
            voucherCode: r.voucherCode,
            voucherPin: r.voucherPin,
            voucherProvider: r.voucherProvider,
            trackingNumber: r.trackingNumber,
            trackingUrl: r.trackingUrl,
          });
        }
        succeeded++;
      } catch (e) {
        errors.push({
          row: r.rowIndex,
          orderNumber: r.orderNumber,
          message: e instanceof Error ? e.message : 'Unknown error',
        });
      }
    }

    return {
      processed: parsed.rows.length,
      succeeded,
      skipped,
      failed: errors.length,
      // Memory-safety (2026-11-13): the error list is capped at 500 (failed = true total).
      ...cappedFulfilmentErrors(errors),
    };
  }

  /**
   * GET /v1/admin/gift-catalogue/dispatch/orders — GIFSY fulfilment console list.
   *
   * Cross-tenant for an un-assumed OWNER (platformWide); scoped to the assumed tenant
   * otherwise (tenantScope). Filters: status, fulfilmentChannel, a specific clientId,
   * an orderNumber search, and a createdAt date range. Each order is annotated with a
   * channel-aware dispatch-SLA (GIFSY_WAREHOUSE/BRAND age against the business-hours
   * clock; Amazon/DIGITAL are exempt). Reuses the platform holiday calendar.
   */
  async listFulfilmentOrders(user: JwtPayload, q: FulfilmentOrdersQueryDto) {
    this.assertOperator(user);
    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    const skip = (page - 1) * limit;

    const scope = tenantScope(user);
    // A platformWide OWNER (scope undefined) may narrow to one tenant via q.clientId.
    // An ASSUMED operator is HARD-pinned to `scope` — q.clientId must NOT override it
    // (that would be a cross-tenant leak), so it is ignored for a scoped caller.
    const effectiveClientId = scope ?? q.clientId;
    const where: Prisma.RedemptionOrderWhereInput = {
      ...(effectiveClientId ? { partner: { clientId: effectiveClientId } } : {}),
    };
    if (q.status) where.status = q.status;
    if (q.channel) where.fulfilmentChannel = q.channel;
    if (q.q) where.orderNumber = { contains: q.q, mode: 'insensitive' };
    // WAVE-2 SEAM: a `vendorId` filter (where.fulfilledByVendorId) lands here for the
    // vendor-scoped console once vendor fulfilment ships.
    // Date-only FE `<input type="date">` bounds are treated as FULL INCLUSIVE IST days
    // (a raw `new Date("YYYY-MM-DD")` is 05:30 IST → would skew the start and truncate the
    // last IST day). A full ISO datetime is used as-given.
    const createdAtRange = istDayRangeFilter(q.from, q.to);
    if (createdAtRange) where.createdAt = createdAtRange;

    const [orders, total, holidays] = await Promise.all([
      this.prisma.redemptionOrder.findMany({
        where,
        include: {
          reward: { select: { id: true, name: true, sourceType: true } },
          partner: { select: { id: true, businessName: true, clientId: true } },
          statusHistory: {
            where: { toStatus: 'CONFIRMED' },
            orderBy: { createdAt: 'asc' },
            take: 1,
            select: { createdAt: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.redemptionOrder.count({ where }),
      loadHolidaySet(this.prisma),
    ]);

    // Tenant display names for the cross-tenant console (clientId → Client.internalName).
    const clientIds = [...new Set(orders.map((o) => o.partner?.clientId).filter(Boolean))] as string[];
    const clients = clientIds.length
      ? await this.prisma.client.findMany({
          where: { id: { in: clientIds } },
          select: { id: true, internalName: true },
        })
      : [];
    const tenantName = new Map(clients.map((c) => [c.id, c.internalName]));

    const nowMs = Date.now();
    const items = orders.map((o) => {
      const confirmedAt = o.statusHistory[0]?.createdAt ?? null;
      const sla = computeDispatchSla({
        fulfilmentChannel: o.fulfilmentChannel,
        status: o.status,
        confirmedAtMs: confirmedAt ? confirmedAt.getTime() : null,
        dispatchedAtMs: o.dispatchedAt ? o.dispatchedAt.getTime() : null,
        nowMs,
        slaBusinessHours: DISPATCH_SLA_BUSINESS_HOURS,
        holidays,
      });
      const clientId = o.partner?.clientId ?? null;
      // GiftOrderSummary — flat wire shape the FE console reads (renamed/derived fields).
      // valuePaise is BigInt → serialise to string for the JSON envelope.
      return {
        id: o.id,
        orderNumber: o.orderNumber,
        clientId,
        tenantName: clientId ? tenantName.get(clientId) ?? clientId : null,
        status: o.status,
        redemptionMode: o.redemptionMode,
        fulfilmentChannel: o.fulfilmentChannel,
        rewardName: o.reward?.name ?? null,
        partnerName: o.partner?.businessName ?? null,
        totalPointsCost: o.totalPointsCost,
        valuePaise: o.valuePaise != null ? o.valuePaise.toString() : null,
        trackingNumber: o.trackingNumber,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
        dispatchSla: sla,
      };
    });

    return {
      items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  /**
   * GET /v1/admin/gift-catalogue/dispatch/orders/:id — GIFSY console order detail.
   * Cross-tenant for a platformWide OWNER; assumed-tenant-scoped otherwise. Includes
   * the full status timeline + the internal "fulfilled by" context (§12).
   */
  async getFulfilmentOrder(user: JwtPayload, id: string) {
    this.assertOperator(user);
    const scope = tenantScope(user);
    const order = await this.prisma.redemptionOrder.findFirst({
      where: { id, ...(scope ? { partner: { clientId: scope } } : {}) },
      include: {
        reward: { select: { id: true, name: true, sourceType: true, giftMasterId: true, vendorId: true } },
        partner: { select: { id: true, businessName: true, clientId: true } },
        fulfilledByVendor: { select: { id: true, name: true, status: true } },
        statusHistory: {
          orderBy: { createdAt: 'asc' },
          select: { fromStatus: true, toStatus: true, changedById: true, notes: true, createdAt: true },
        },
      },
    });
    if (!order) throw new NotFoundException('Order not found');

    // Resolve actor display names for the status timeline (changedById → User.name).
    const actorIds = [...new Set(order.statusHistory.map((h) => h.changedById).filter(Boolean))] as string[];
    const actors = actorIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })
      : [];
    const actorName = new Map(actors.map((a) => [a.id, a.name]));

    // Tenant display name (clientId → Client.internalName).
    const clientId = order.partner?.clientId ?? null;
    const client = clientId
      ? await this.prisma.client.findUnique({ where: { id: clientId }, select: { internalName: true } })
      : null;

    // Delivery PII as a single flat block (ops-visible; never on the member tile).
    const addressLine = [
      order.deliveryAddressLine1,
      order.deliveryAddressLine2,
      order.deliveryCity,
      order.deliveryState,
      order.deliveryPincode,
    ]
      .filter(Boolean)
      .join(', ');
    const delivery =
      order.deliveryName || addressLine || order.deliveryPhone
        ? {
            name: order.deliveryName ?? null,
            address: addressLine || null,
            phone: order.deliveryPhone ?? null,
          }
        : null;

    const statusHistory = order.statusHistory.map((h) => ({
      status: h.toStatus,
      at: h.createdAt,
      note: h.notes ?? null,
      byName: h.changedById ? actorName.get(h.changedById) ?? null : null,
    }));

    // Derive the milestone timestamps the FE reads (no dedicated columns for
    // confirmed/processed/returned — sourced from the authoritative status history).
    const stampFor = (status: string) =>
      order.statusHistory.find((h) => h.toStatus === status)?.createdAt ?? null;
    const canSeeCodes = await this.canSeeFullVoucherCode(user);

    return {
      id: order.id,
      orderNumber: order.orderNumber,
      clientId,
      tenantName: client?.internalName ?? clientId,
      status: order.status,
      redemptionMode: order.redemptionMode,
      rewardName: order.reward?.name ?? null,
      partnerName: order.partner?.businessName ?? null,
      totalPointsCost: order.totalPointsCost,
      quantity: order.quantity,
      valuePaise: order.valuePaise != null ? order.valuePaise.toString() : null,
      fulfilmentChannel: order.fulfilmentChannel,
      logisticsPartner: order.logisticsPartner,
      trackingNumber: order.trackingNumber,
      trackingUrl: order.trackingUrl,
      supplierOrderRef: order.supplierOrderRef,
      voucherCode: order.voucherCode,
      voucherPin: order.voucherPin,
      voucherProvider: order.voucherProvider,
      // The server would accept a set-once PIN / provider on the stored code (F4 — one rule; the
      // console offers the "Add the PIN…" box only then).
      voucherFillable: canFillStoredVoucher(order),
      fulfilledByVendorId: order.fulfilledByVendorId,
      // The route already requires rewards:manage_orders (= canSeeFullVoucherCode); defence in
      // depth: any other operator gets neither the card number nor the PIN.
      ...(canSeeCodes ? {} : hiddenVoucherFields(order.voucherCode)),
      fulfilledByVendorName: order.fulfilledByVendor?.name ?? null,
      delivery,
      statusHistory,
      confirmedAt: stampFor('CONFIRMED'),
      processedAt: stampFor('PROCESSING'),
      dispatchedAt: order.dispatchedAt,
      deliveredAt: order.deliveredAt,
      cancelledAt: order.cancelledAt,
      returnedAt: stampFor('RETURNED') ?? (order.status === 'RETURNED' ? order.updatedAt : null),
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
  }

  /**
   * Validate the unverified REDEMPTION_CONFIRM OTP issued for a SPECIFIC order and return its id.
   * Self-contained (does NOT reuse auth.verifyOtp, which auto-registers users).
   * Claims an attempt atomically before comparing (401 on a miss; a correct code gets it back). Does NOT set verifiedAt — the caller marks it
   * INSIDE the confirm transaction so a failed debit rolls the OTP back (M1).
   * FIXED_OTP is honoured ONLY outside production — a dev backdoor on a money
   * confirm must never be live in prod (H2).
   *
   * AUDIT FIX (MED): scoped to `orderId` (OtpCode.referenceId). A login can now hold concurrent
   * PENDING orders across outlets (login picker) whose OTPs share the same login user, so a
   * user-level lookup could let one order's confirm consume another order's OTP. The referenceId
   * filter binds the confirm to the OTP issued for THIS order.
   */
  private async verifyRedemptionOtp(userId: string, otp: string, orderId: string): Promise<string> {
    const record = await this.prisma.otpCode.findFirst({
      where: { userId, purpose: 'REDEMPTION_CONFIRM', verifiedAt: null, referenceId: orderId },
      orderBy: { createdAt: 'desc' },
    });
    if (!record) {
      await this.throwIfOrderAlreadyConfirmed(orderId);
      throw new UnauthorizedException('No active OTP found. Please restart the redemption.');
    }
    if (record.attempts >= record.maxAttempts) {
      throw new UnauthorizedException('Too many attempts — please restart the redemption.');
    }
    if (new Date() > record.expiresAt) {
      throw new UnauthorizedException('OTP expired — please restart the redemption.');
    }

    // Claim-before-compare (common/otp-attempt): claim one attempt ATOMICALLY before comparing, so
    // parallel guesses that all read the same `attempts` can't exceed maxAttempts; a losing claim is
    // refused with the existing "too many attempts" error and its code is never compared.
    const claimed = await claimOtpAttempt(this.prisma, record);
    if (claimed === null) {
      await this.throwIfOrderAlreadyConfirmed(orderId);
      // Refused: re-read so a code superseded/expired or pruned meanwhile gets the honest message (L1).
      const why = await whyOtpClaimRefused(this.prisma, record.id);
      if (why === 'EXPIRED') throw new UnauthorizedException('OTP expired — please restart the redemption.');
      if (why === 'GONE') throw new UnauthorizedException('No active OTP found. Please restart the redemption.');
      throw new UnauthorizedException('Too many attempts — please restart the redemption.');
    }

    const fixedOtp = isFixedOtpAllowed() ? process.env.FIXED_OTP : undefined;
    const isCorrect = fixedOtp ? otp === fixedOtp : otp === record.code;
    if (!isCorrect) {
      // From the atomic claim's post-increment value — exact under parallel guesses (not the stale read).
      const remaining = Math.max(0, record.maxAttempts - claimed);
      throw new UnauthorizedException(
        `Invalid OTP. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`,
      );
    }

    // A correct code did not consume an attempt before (verifiedAt is only set inside the confirm
    // transaction, so a failed debit leaves the OTP retryable) — give the claimed attempt back.
    await refundOtpAttempt(this.prisma, record.id);
    return record.id;
  }

  /**
   * Double-tap: the OTP is gone / its claim lost because a parallel confirm of the SAME order already
   * consumed it. If that order has left PENDING, answer with the confirm's own conflict (what the
   * winner's twin would have hit at the order claim) instead of a misleading "too many attempts".
   * The order was already loaded + authorised by the caller; this re-read only picks the message.
   */
  private async throwIfOrderAlreadyConfirmed(orderId: string): Promise<void> {
    const current = await this.prisma.redemptionOrder.findFirst({ where: { id: orderId }, select: { status: true } });
    if (current && current.status !== 'PENDING') {
      throw new ConflictException('Order is no longer awaiting confirmation');
    }
  }

  /** 6-digit OTP (100000–999999) via CSPRNG — see common/otp.ts (AF-10). */
  private generateOtpCode(): string {
    return generateNumericOtp();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // HUBBLE MONEY — auto-issuance of the Amazon Pay voucher for a GIFT_CARD
  // redemption. Bajaj-only, behind features.hubbleVoucherEnabled (default OFF);
  // fires ONLY after a successful points debit at confirm.
  //
  // MONEY-SAFETY INVARIANTS (owner-set):
  //   • never issue without a committed points debit  → issuance runs only AFTER the
  //     confirm tx commits (status CONFIRMED, pointsDeducted set).
  //   • never leave points debited without a voucher OR a refund → every order ends
  //     DELIVERED (voucher stored), FAILED (points refunded), or PROCESSING /
  //     pending-reconcile (webhook / get-by-reference completes it).
  //   • idempotent on referenceId (= the RedemptionOrder id): a retry recovers the
  //     existing Hubble order via get-by-reference; voucher-store + refund both use
  //     atomic status/pointsDeducted claims so neither can double-apply.
  //
  // CONSERVATIVE DEVIATION (flagged for owner): on an INDETERMINATE outcome (the
  // place-order call throws AND get-by-reference also throws — we cannot tell whether
  // a voucher was issued) we do NOT auto-refund. Refunding then could double-pay a
  // voucher that was actually issued (Hubble has no cancel). We leave the order
  // PROCESSING + flagged for reconcile; the webhook or an ops reconcile resolves it.
  // ───────────────────────────────────────────────────────────────────────────

  /** Map a HubbleService product-lookup error to an admin-readable HTTP error. */
  private hubbleProductHttpError(e: unknown, productId: string): Error {
    if (e instanceof HubbleNotConfiguredError) {
      return new ServiceUnavailableException(
        'Hubble is not configured in this environment, so the brand and its amounts cannot be loaded.',
      );
    }
    if (e instanceof HubbleProductNotFoundError) {
      return new NotFoundException(
        `No active Hubble product with ID "${productId}". Check the product ID in the Hubble partner portal.`,
      );
    }
    this.logger.error(`[hubble] product lookup failed for ${productId}: ${e}`);
    return new ServiceUnavailableException('Could not reach Hubble to load this brand — try again in a minute.');
  }

  /**
   * GET /v1/admin/rewards/hubble-products/:productId — the catalogue editor's "Load from
   * Hubble". Returns the normalised product plus the tenant conversion rate + minimum voucher
   * amount (so the editor can show points per amount and grey out amounts below the floor).
   * Hubble-enabled tenants only.
   */
  async getHubbleProductForAdmin(user: JwtPayload, productId: string) {
    if (!(await this.isHubbleEnabledForTenant(user.clientId))) {
      throw new BadRequestException('Hubble gift cards are not enabled for this program.');
    }
    let product: HubbleProduct;
    try {
      product = await this.hubble.getProduct(productId);
    } catch (e) {
      throw this.hubbleProductHttpError(e, productId);
    }
    const settings = await this.tenantSettings.getEffectiveSettings(user.clientId);
    return {
      product,
      conversionRate: settings.conversionRate,
      minVoucherFreeAmount: settings.minVoucherFreeAmount,
    };
  }

  /**
   * Save-time check of a Hubble GIFT_CARD item against the LIVE product (see
   * validateHubbleItemAmounts). Returns the derived points band for an amounts list, else null.
   * Hubble not configured in this environment: an amounts list is refused (it can't be
   * verified); an item WITHOUT a list is saved unchecked, as before (an un-provisioned
   * environment falls back to manual fulfilment at confirm anyway).
   */
  private async checkHubbleItemAgainstProduct(
    clientId: string,
    productId: string,
    input: {
      denominations: number[] | null;
      minRedemptionPoints: number | null | undefined;
      maxRedemptionPoints: number | null | undefined;
      sellingValuePaise: number | null | undefined;
    },
  ): Promise<{ minRedemptionPoints: number; maxRedemptionPoints: number } | null> {
    let product: HubbleProduct;
    try {
      product = await this.hubble.getProduct(productId);
    } catch (e) {
      if (e instanceof HubbleNotConfiguredError && !input.denominations?.length) return null;
      throw this.hubbleProductHttpError(e, productId);
    }
    const settings = await this.tenantSettings.getEffectiveSettings(clientId);
    return validateHubbleItemAmounts(product, {
      ...input,
      conversionRate: settings.conversionRate,
      minVoucherFreeAmount: settings.minVoucherFreeAmount,
    });
  }

  /** Pull a non-empty Hubble productId out of a RewardCatalog.metadata blob. */
  private extractHubbleProductId(metadata: unknown): string | null {
    if (!metadata || typeof metadata !== 'object') return null;
    const v = (metadata as Record<string, unknown>).hubbleProductId;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  }

  /** Read the per-tenant Hubble feature flag (clients.features.hubbleVoucherEnabled). */
  private async isHubbleEnabledForTenant(clientId: string): Promise<boolean> {
    const client = await this.prisma.client.findFirst({
      where: { id: clientId },
      select: { features: true },
    });
    return (client?.features as Record<string, unknown> | null)?.hubbleVoucherEnabled === true;
  }

  /**
   * Read the per-tenant catalogue MRP-slash feature flag (clients.features.catalogueMrpSlash,
   * default OFF). Mirrors isHubbleEnabledForTenant. Gates the SERVER-SIDE slashPoints computation:
   * when OFF (incl. Deoleo), the member catalogue reads neither compute nor emit slashPoints AND do
   * not even transiently select the cost-basis columns (mrpPaise/sellingValuePaise) — so a flag-OFF
   * member response carries no slash and no cost-basis columns at all (defense-in-depth).
   */
  private async isCatalogueMrpSlashEnabled(clientId: string): Promise<boolean> {
    const client = await this.prisma.client.findFirst({
      where: { id: clientId },
      select: { features: true },
    });
    return (client?.features as Record<string, unknown> | null)?.catalogueMrpSlash === true;
  }

  /**
   * Eligibility for auto-issuance. ORDER MATTERS for byte-identical behaviour: the
   * cheap, DB-free checks (GIFT_CARD + a productId on the item) run FIRST, so a
   * Deoleo / non-Hubble item never even reads the tenant flag. Only a GIFT_CARD that
   * actually carries a Hubble productId pays for the one flag lookup.
   */
  private async isHubbleEligible(
    order: { redemptionMode: PayoutMode; reward?: { metadata?: unknown } | null },
    clientId: string,
  ): Promise<boolean> {
    if (order.redemptionMode !== PayoutMode.GIFT_CARD) return false;
    if (!this.extractHubbleProductId(order.reward?.metadata)) return false;
    return this.isHubbleEnabledForTenant(clientId);
  }

  /**
   * Finish a Hubble-eligible GIFT_CARD confirm: run the auto-issuance, send the
   * outcome-appropriate notification, and return the confirm response. Shared by both
   * confirm entry points (self-redeem + sales-assisted). NEVER throws — a thrown
   * issuance is swallowed to pending-reconcile (points are already safely debited).
   */
  private async finishHubbleConfirm(
    order: { id: string; orderNumber: string },
    ctx: {
      clientId: string;
      actorId: string;
      notifyUserId: string | null;
      recipientPhone: string | null;
      ownerName: string;
      rewardName: string;
      points: number;
    },
  ): Promise<{ orderId: string; status: string; message: string }> {
    const outcome = await this.issueHubbleVoucherForOrder(order.id, ctx.clientId, ctx.actorId);

    // Map the outcome to a member-facing status + message + notification event.
    const isDelivered = outcome === 'DELIVERED';
    const isFailed = outcome === 'FAILED_REFUNDED';
    const status = isDelivered ? 'DELIVERED' : isFailed ? 'FAILED' : 'CONFIRMED';
    const message = isDelivered
      ? 'Redemption confirmed. Your voucher has been issued — view it in your orders.'
      : isFailed
        ? 'We could not issue your voucher, so your points have been refunded. Please try again.'
        : 'Redemption confirmed. Your voucher is being issued and will appear shortly.';

    if (isDelivered) {
      // Voucher is live — send the OWNER their CODE (in-app bell + config-driven WhatsApp via the
      // `voucher_code` template). Owner-only, self-loading, best-effort (never throws out of a
      // confirm whose points are already debited and whose voucher is already DELIVERED).
      await this.notifyVoucherIssued(order.id, ctx.clientId);
    } else if (ctx.notifyUserId) {
      // AUDIT-FIX: best-effort. A notification failure must NEVER throw out of a confirm whose
      // points are already debited — that would 500 a redemption and block retry. Log + swallow.
      try {
        await this.notifications.notifyUserWithChannels({
          clientId: ctx.clientId,
          userId: ctx.notifyUserId,
          eventKey: isFailed ? ('REDEMPTION_FAILED' as EventKey) : 'REDEMPTION_CONFIRMED',
          recipientPhone: ctx.recipientPhone,
          vars: {
            ownerName: ctx.ownerName,
            rewardName: ctx.rewardName,
            points: ctx.points,
          },
          subject: isFailed ? 'Redemption refunded' : 'Redemption confirmed',
          body: message,
          url: '/partner/rewards',
          event: isFailed ? 'REDEMPTION_FAILED' : 'REDEMPTION_CONFIRMED',
        });
      } catch (notifyErr) {
        this.logger.error(
          `[hubble] confirm notification failed for order ${order.id} (non-fatal): ${notifyErr}`,
        );
      }
    }

    return { orderId: order.id, status, message };
  }

  /**
   * "<Tenant brand> Loyalty" — the {{3}} `program` variable of the voucher_code WhatsApp template.
   * Reads the client's branding display name (falls back to internalName, then the slug).
   */
  private async programLabel(clientId: string): Promise<string> {
    return programLabelFor(this.prisma, clientId);
  }

  /**
   * Send the outlet OWNER their voucher code once it is issued — in-app bell + the config-driven
   * WhatsApp `voucher_code` template (VOUCHER_ISSUED event). Fired from BOTH issue paths: Hubble
   * auto-issue (finishHubbleConfirm, DELIVERED) and manual fulfilment (transitionOrder, when a
   * code is first assigned). Self-loading from the order id so the two call sites stay trivial.
   *
   * OWNER-ONLY by construction: the recipient is the order's partner (`partner.userId` for the bell,
   * `partner.phone` for WhatsApp) — never the acting sales rep or any sales view. Best-effort: a
   * notification failure must never throw into a flow whose voucher is already live.
   */
  private async notifyVoucherIssued(orderId: string, clientId: string): Promise<void> {
    // Shared with the vendor portal (voucher-issuance.ts) so every issuance path notifies alike.
    await notifyVoucherIssuedShared(
      { prisma: this.prisma, notifications: this.notifications, logger: this.logger },
      orderId,
      clientId,
    );
  }

  /** The outcome of an auto-issuance attempt. */
  private readonly HUBBLE_OUTCOME = {
    DELIVERED: 'DELIVERED',
    PROCESSING: 'PROCESSING',
    FAILED_REFUNDED: 'FAILED_REFUNDED',
    PENDING_RECONCILE: 'PENDING_RECONCILE',
    SKIPPED: 'SKIPPED',
  } as const;

  /**
   * Place the Hubble order for a confirmed GIFT_CARD redemption and apply the result
   * idempotently. Entry point from the confirm path. NEVER throws (catches everything
   * → PENDING_RECONCILE) so a confirm can never 500 after the debit has committed.
   *
   * @returns one of HUBBLE_OUTCOME.
   */
  async issueHubbleVoucherForOrder(
    orderId: string,
    clientId: string,
    actorId?: string,
  ): Promise<string> {
    try {
      const order = await this.loadHubbleOrder(orderId, clientId);
      if (!order) return this.HUBBLE_OUTCOME.SKIPPED;

      // Idempotency: an order already resolved (delivered with a voucher, or
      // refunded/failed/cancelled) needs no issuance.
      if (this.isHubbleOrderResolved(order)) return this.HUBBLE_OUTCOME.SKIPPED;

      const productId = this.extractHubbleProductId(order.reward?.metadata);
      if (order.redemptionMode !== PayoutMode.GIFT_CARD || !productId) {
        return this.HUBBLE_OUTCOME.SKIPPED;
      }

      if (!this.hubble.isConfigured()) {
        // Flag ON but environment un-provisioned: do NOT refund (nothing was placed and
        // ops may still fulfil manually) — leave CONFIRMED + flag for reconcile. Loud log.
        this.logger.error(
          `[hubble] order ${order.orderNumber} eligible but Hubble is not configured — left for manual/ops fulfilment`,
        );
        await this.markHubblePendingReconcile(order.id, 'HUBBLE_NOT_CONFIGURED');
        return this.HUBBLE_OUTCOME.PENDING_RECONCILE;
      }

      const amount = this.hubbleAmountRupees(order);
      if (amount == null || amount <= 0) {
        this.logger.error(
          `[hubble] order ${order.orderNumber} has no issuable whole-rupee value (valuePaise=${order.valuePaise}) — cannot issue; left for ops`,
        );
        await this.markHubblePendingReconcile(order.id, 'HUBBLE_INVALID_AMOUNT');
        return this.HUBBLE_OUTCOME.PENDING_RECONCILE;
      }

      // AUDIT-FIX (double-issue, future-proofing): if this order is already PROCESSING we
      // have ALREADY sent Hubble a placeOrder for this referenceId. Never place again (a
      // 2nd call with the same referenceId risks a 2nd Amazon voucher — our only guard
      // would be Hubble's own idempotency, which we don't verify). Recover by reference
      // only, exactly like the webhook reconcile. Protects any future caller (ops "retry
      // issuance", a reconcile sweep) that points at a PROCESSING order.
      if (order.status === RedemptionStatus.PROCESSING) {
        let recovered: HubbleOrderResult | null;
        try {
          recovered = await this.hubble.getOrderByReference(order.id);
        } catch (recoverErr) {
          this.logger.error(
            `[hubble] recover (already PROCESSING) failed for order ${order.orderNumber}: ${recoverErr}`,
          );
          await this.markHubblePendingReconcile(order.id, 'HUBBLE_INDETERMINATE');
          return this.HUBBLE_OUTCOME.PENDING_RECONCILE;
        }
        if (recovered === null) {
          // PROCESSING locally but Hubble has no record — anomalous; do NOT refund off a
          // single miss (could double with a later success). Leave for reconcile.
          await this.markHubblePendingReconcile(order.id, 'HUBBLE_PROCESSING_NOT_FOUND');
          return this.HUBBLE_OUTCOME.PENDING_RECONCILE;
        }
        return await this.applyHubbleBody(order, recovered, actorId);
      }

      // DEFENCE IN DEPTH (per-brand denominations): never send Hubble an amount it can't
      // issue. Checks the ORDER (its frozen face value — never the item's CURRENT list, which an
      // admin may have edited since) against the brand's live FIXED denominations. A miss means
      // NOTHING reached Hubble, so refund NOW (the same atomic refund as a Hubble FAILED) — the
      // member sees "could not issue, points refunded", never a stuck "being issued". A product
      // lookup FAILURE (or a FIXED brand whose list Hubble didn't return) never blocks issuance —
      // Hubble itself still validates (FAILED → refund).
      if (!(await this.isHubbleAmountIssuable(productId, amount, order))) {
        this.logger.error(
          `[hubble] order ${order.orderNumber} amount ₹${amount} is not an issuable amount for product ${productId} — not placed; refunding`,
        );
        const refunded = await this.refundAndFailHubble(
          order,
          `₹${amount} is not an amount this brand can issue right now (not sent to Hubble)`,
          actorId,
        );
        return refunded ? this.HUBBLE_OUTCOME.FAILED_REFUNDED : this.HUBBLE_OUTCOME.PENDING_RECONCILE;
      }

      // Place the order (referenceId = our order id = the idempotency key). On ANY
      // thrown error, recover authoritative state by referenceId before deciding.
      let body: HubbleOrderResult | null;
      try {
        body = await this.hubble.placeOrder({
          productId,
          referenceId: order.id,
          amount,
          denominationDetails: [{ denomination: amount, quantity: 1 }],
          customerDetails: null, // B2B
        });
      } catch (placeErr) {
        this.logger.warn(
          `[hubble] placeOrder threw for order ${order.orderNumber}; recovering by reference: ${placeErr}`,
        );
        try {
          body = await this.hubble.getOrderByReference(order.id);
        } catch (recoverErr) {
          // INDETERMINATE — may or may not have been placed. Do NOT refund (double-pay
          // risk). Leave pending; the webhook / ops reconcile resolves it.
          this.logger.error(
            `[hubble] indeterminate state for order ${order.orderNumber} (place + recover both failed): ${recoverErr}`,
          );
          await this.markHubblePendingReconcile(order.id, 'HUBBLE_INDETERMINATE');
          return this.HUBBLE_OUTCOME.PENDING_RECONCILE;
        }
        if (body === null) {
          // Definitively never placed (404 on recovery) → safe to refund.
          // Blocked (a voucher code is on the order) → NOT refunded: report pending, never
          // "points refunded" to the member.
          const refunded = await this.refundAndFailHubble(
            order,
            'Hubble order was not placed (not found on recovery)',
            actorId,
          );
          return refunded ? this.HUBBLE_OUTCOME.FAILED_REFUNDED : this.HUBBLE_OUTCOME.PENDING_RECONCILE;
        }
      }

      return await this.applyHubbleBody(order, body, actorId);
    } catch (e) {
      // Unexpected error anywhere above (e.g. a DB blip while storing a voucher AFTER a
      // successful placement): do NOT refund — we cannot be sure a voucher wasn't issued.
      // Leave pending; the webhook / ops reconcile (get-by-reference) re-applies idempotently.
      this.logger.error(`[hubble] issueHubbleVoucherForOrder(${orderId}) unexpected error: ${e}`);
      await this.markHubblePendingReconcile(orderId, 'HUBBLE_UNEXPECTED').catch(() => undefined);
      return this.HUBBLE_OUTCOME.PENDING_RECONCILE;
    }
  }

  /**
   * Webhook / ops reconcile: given OUR referenceId (= order id), fetch the
   * authoritative Hubble state by reference and apply the terminal transition
   * idempotently. Does NOT place a new order. NEVER throws (returns an outcome string).
   */
  async reconcileHubbleOrder(referenceId: string): Promise<string> {
    try {
      // Resolve the tenant from the order itself (the webhook carries no clientId).
      const owner = await this.prisma.redemptionOrder.findFirst({
        where: { id: referenceId },
        select: { partner: { select: { clientId: true } } },
      });
      const clientId = owner?.partner?.clientId;
      if (!clientId) return this.HUBBLE_OUTCOME.SKIPPED;

      const order = await this.loadHubbleOrder(referenceId, clientId);
      if (!order) return this.HUBBLE_OUTCOME.SKIPPED;
      if (this.isHubbleOrderResolved(order)) return this.HUBBLE_OUTCOME.SKIPPED;

      // AUDIT-FIX (gating asymmetry): re-assert the SAME eligibility the issue path uses
      // (GIFT_CARD + a Hubble productId on the item + tenant flag ON) before applying any
      // Hubble body. Without this, a webhook/ops reconcile for a non-GIFT_CARD / flag-off /
      // Deoleo order id that Hubble happens to hold a record for could stamp it DELIVERED
      // (voucher) or refund+zero it — corrupting a cash/physical order.
      if (!(await this.isHubbleEligible(order, clientId))) return this.HUBBLE_OUTCOME.SKIPPED;

      if (!this.hubble.isConfigured()) {
        this.logger.error('[hubble] reconcile called but Hubble is not configured');
        return this.HUBBLE_OUTCOME.PENDING_RECONCILE;
      }

      let body: HubbleOrderResult | null;
      try {
        body = await this.hubble.getOrderByReference(referenceId);
      } catch (e) {
        this.logger.error(`[hubble] reconcile get-by-reference failed for ${referenceId}: ${e}`);
        return this.HUBBLE_OUTCOME.PENDING_RECONCILE;
      }
      if (body === null) {
        // A webhook/reconcile for an order Hubble has no record of is anomalous — do NOT
        // refund off a reconcile miss (a transient 404 could double with a later success).
        this.logger.warn(`[hubble] reconcile: no Hubble order for reference ${referenceId}`);
        return this.HUBBLE_OUTCOME.PENDING_RECONCILE;
      }
      return await this.applyHubbleBody(order, body);
    } catch (e) {
      this.logger.error(`[hubble] reconcileHubbleOrder(${referenceId}) unexpected error: ${e}`);
      return this.HUBBLE_OUTCOME.PENDING_RECONCILE;
    }
  }

  /** The RedemptionOrder shape the Hubble helpers operate on. */
  private async loadHubbleOrder(orderId: string, clientId: string) {
    return this.prisma.redemptionOrder.findFirst({
      where: { id: orderId, partner: { clientId } },
      include: { reward: { select: { metadata: true } } },
    });
  }

  /** An order that already reached a Hubble terminal/resolved state needs no (re)issue. */
  private isHubbleOrderResolved(order: {
    status: RedemptionStatus;
    voucherCode: string | null;
    pointsDeducted: number;
  }): boolean {
    if (order.status === RedemptionStatus.DELIVERED && !!order.voucherCode) return true;
    // A refunded/cancelled/failed order (points already returned) must not be re-issued.
    if (
      (order.status === RedemptionStatus.FAILED ||
        order.status === RedemptionStatus.CANCELLED ||
        order.status === RedemptionStatus.RETURNED) &&
      order.pointsDeducted === 0
    ) {
      return true;
    }
    return false;
  }

  /**
   * Issuance-time amount check (see issueHubbleVoucherForOrder). false ⇒ do NOT call Hubble.
   * Reads the ORDER only: (a) the amount must equal the face value frozen on the order at
   * redeem (sellingValuePaiseSnapshot, when present) — a mismatch means the value drifted and
   * must not be sent; (b) for a FIXED brand with a KNOWN live list, the amount must be on it.
   * Not pre-checked (Hubble validates; FAILED → auto-refund): FLEXIBLE brands, a FIXED brand
   * whose list Hubble didn't return, or any lookup error.
   */
  private async isHubbleAmountIssuable(
    productId: string,
    amount: number,
    order: { metadata: Prisma.JsonValue | null; quantity?: number | null },
  ): Promise<boolean> {
    const meta = order.metadata;
    const snap =
      meta && typeof meta === 'object' && !Array.isArray(meta)
        ? (meta as Record<string, unknown>).sellingValuePaiseSnapshot
        : undefined;
    const qty = order.quantity && order.quantity > 0 ? order.quantity : 1;
    if (typeof snap === 'number' && snap > 0 && snap * qty !== amount * 100) return false;
    let product: HubbleProduct;
    try {
      product = await this.hubble.getProduct(productId);
    } catch (e) {
      this.logger.warn(`[hubble] product lookup failed for ${productId} (issuance proceeds; Hubble validates): ${e}`);
      return true;
    }
    if (
      product.denominationType === 'FIXED' &&
      product.denominations.length > 0 &&
      !isAmountIssuable(product, amount)
    ) {
      return false;
    }
    return true;
  }

  /** valuePaise → whole rupees for the Hubble order amount (Amazon free-denomination). */
  private hubbleAmountRupees(order: { valuePaise: bigint | null }): number | null {
    if (order.valuePaise == null) return null;
    const paise = Number(order.valuePaise);
    if (!Number.isFinite(paise) || paise <= 0) return null;
    // AUDIT-FIX (money leak): issue the EXACT face value only. A fractional rupee (paise
    // not a multiple of 100) must NOT be silently rounded — rounding would issue a voucher
    // that diverges from both the points debited and the 194R / gift-disbursal base stored
    // on the order. Return null so the caller leaves it for ops rather than shorting /
    // over-issuing. (For Bajaj, conversionRate=1 → valuePaise is always whole-rupee.)
    // ⚠️ OWNER-VERIFY the Hubble `amount`/`denomination` unit (rupees assumed, per the
    // contract examples).
    if (paise % 100 !== 0) return null;
    return paise / 100;
  }

  /** Branch on the Hubble body status and apply the matching idempotent transition. */
  private async applyHubbleBody(
    order: HubbleLoadedOrder,
    body: HubbleOrderResult,
    actorId?: string,
  ): Promise<string> {
    const status = (body.status ?? '').toUpperCase();
    if (status === 'SUCCESS') {
      await this.storeHubbleSuccess(order, body, actorId);
      return this.HUBBLE_OUTCOME.DELIVERED;
    }
    if (status === 'PROCESSING') {
      await this.markHubbleProcessing(order, body, actorId);
      return this.HUBBLE_OUTCOME.PROCESSING;
    }
    if (status === 'FAILED') {
      const refunded = await this.refundAndFailHubble(
        order,
        body.failureReason ?? 'Hubble reported FAILED',
        actorId,
      );
      return refunded ? this.HUBBLE_OUTCOME.FAILED_REFUNDED : this.HUBBLE_OUTCOME.PENDING_RECONCILE;
    }
    // Unknown status → treat as still-pending (safer than refunding).
    this.logger.warn(
      `[hubble] order ${order.orderNumber} unknown Hubble status "${body.status}" — left pending`,
    );
    await this.markHubblePendingReconcile(order.id, `HUBBLE_UNKNOWN_STATUS:${body.status}`);
    return this.HUBBLE_OUTCOME.PENDING_RECONCILE;
  }

  /**
   * SUCCESS — store the voucher(s) and mark the order DELIVERED. Idempotent via an
   * atomic status claim (CONFIRMED/PROCESSING → DELIVERED): a webhook racing the
   * confirm issuance can only win once. Card data is stored on the order
   * (voucherCode) + metadata; the response contract is unchanged (the partner/rep UI
   * already renders voucherCode for GIFT_CARD fulfilment).
   */
  private async storeHubbleSuccess(
    order: HubbleLoadedOrder,
    body: HubbleOrderResult,
    actorId?: string,
  ): Promise<void> {
    const voucher = (body.vouchers ?? [])[0];
    const { code: voucherCode, pin: voucherPin } = hubbleVoucherCredentials(voucher);
    if (!voucherCode) {
      // SUCCESS with no usable code is anomalous — do NOT flip to DELIVERED without a
      // code (would break the DIGITAL_VOUCHER delivered invariant). Leave pending.
      this.logger.error(
        `[hubble] order ${order.orderNumber} SUCCESS but no voucher code in payload — left pending`,
      );
      await this.markHubblePendingReconcile(order.id, 'HUBBLE_SUCCESS_NO_CODE');
      return;
    }

    const now = new Date();
    const won = await this.prisma.$transaction(async (tx) => {
      // Shared transition: claim + the (fromStatus null) DELIVERED history row, only when won.
      // NO_ISSUED_VOUCHER_GUARD: never overwrite a code already on the order (e.g. ops issued one
      // manually) — that would silently double-issue. A lost claim is checked below.
      return transitionOrderStatus(tx, {
        orderId: order.id,
        guard: {
          status: { in: [RedemptionStatus.CONFIRMED, RedemptionStatus.PROCESSING] },
          ...noIssuedVoucherGuard(order.voucherCode),
        },
        fromStatus: null,
        toStatus: RedemptionStatus.DELIVERED,
        changedById: actorId ?? null,
        notes: 'Hubble voucher issued',
        data: {
          fulfilmentChannel: GiftFulfilmentChannel.DIGITAL_VOUCHER,
          voucherCode,
          // Card+PIN product (e.g. CARD_AND_PIN_NO_SECURED): the PIN rides in the SAME guarded
          // claim as the card number — never one without the other. Null for number-/PIN-only cards.
          voucherPin,
          voucherProvider: 'Hubble',
          supplierOrderRef: body.id ?? body.orderId ?? null,
          deliveredAt: now,
          // MERGE onto existing metadata so the redeem-time snapshot (sellingValuePaise,
          // salesInitiatedById) is preserved alongside the Hubble voucher detail.
          metadata: this.mergeOrderMetadata(
            order.metadata,
            this.buildHubbleVoucherMetadata(voucher, body),
          ),
        },
      }); // count 0 = already resolved by a concurrent apply — no-op (no history row)
    });
    if (won.count === 0) {
      // Lost: either a concurrent apply already delivered it (fine), or a MANUAL code is on the
      // still-open order — Hubble issued a 2nd voucher. Never overwrite; flag it for ops loudly.
      const now2 = await this.prisma.redemptionOrder.findFirst({
        where: { id: order.id },
        select: { status: true, voucherCode: true, voucherProvider: true },
      });
      if (
        now2 &&
        hasIssuedVoucher(now2.voucherCode) &&
        (now2.status === RedemptionStatus.CONFIRMED || now2.status === RedemptionStatus.PROCESSING)
      ) {
        this.logger.error(
          `[hubble] order ${order.orderNumber}: Hubble SUCCESS but a manual voucher code is already on the order — NOT overwritten; flagged for ops (possible double issuance)`,
        );
        await this.markHubblePendingReconcile(order.id, 'HUBBLE_SUCCESS_MANUAL_CODE_PRESENT');
      }
      return;
    }
    this.logger.log(`[hubble] order ${order.orderNumber} voucher issued + marked DELIVERED`);
  }

  /** PROCESSING — mark the order PROCESSING (pending external); the webhook completes it. */
  private async markHubbleProcessing(
    order: HubbleLoadedOrder,
    body: HubbleOrderResult,
    actorId?: string,
  ): Promise<void> {
    // Ops already took this order over (manual override / release) or a code is already on it:
    // Hubble reporting PROCESSING now must NOT re-stamp provider='Hubble' over the manual state —
    // flag it for ops (possible double issuance) instead.
    const meta = (order.metadata && typeof order.metadata === 'object' && !Array.isArray(order.metadata)
      ? order.metadata
      : {}) as Record<string, unknown>;
    if (hasIssuedVoucher(order.voucherCode) || meta.hubbleStatus === 'MANUAL_OVERRIDE' || meta.hubbleStatus === 'RELEASED') {
      this.logger.error(
        `[hubble] order ${order.orderNumber}: Hubble PROCESSING but the order was taken over manually / holds a code — NOT re-stamped; flagged for ops`,
      );
      await this.markHubblePendingReconcile(order.id, 'HUBBLE_PROCESSING_AFTER_MANUAL');
      return;
    }
    const claim = await this.prisma.$transaction(async (tx) => {
      return transitionOrderStatus(tx, {
        orderId: order.id,
        // No code on the row (as read), and the row unchanged since that read (updatedAt CAS): a
        // concurrent manual override / release / code write — which would change the hubbleStatus
        // or code this decision was based on — makes the claim lose instead of being overwritten.
        guard: {
          status: RedemptionStatus.CONFIRMED,
          ...noIssuedVoucherGuard(order.voucherCode),
          ...(order.updatedAt ? { updatedAt: order.updatedAt } : {}),
        },
        fromStatus: RedemptionStatus.CONFIRMED,
        toStatus: RedemptionStatus.PROCESSING,
        changedById: actorId ?? null,
        notes: 'Hubble voucher processing',
        data: {
          fulfilmentChannel: GiftFulfilmentChannel.DIGITAL_VOUCHER,
          supplierOrderRef: body.id ?? body.orderId ?? null,
          voucherProvider: 'Hubble',
          metadata: this.mergeOrderMetadata(order.metadata, {
            hubbleStatus: 'PROCESSING',
            hubbleOrderId: body.id ?? body.orderId ?? null,
          }),
        },
      });
    });
    if (claim.count === 0) {
      // Lost: benign if a concurrent apply already moved it on; otherwise something changed under
      // us (manual takeover, a code, a status move) — never overwrite, flag for ops.
      const now = await this.prisma.redemptionOrder.findFirst({
        where: { id: order.id },
        select: { status: true },
      });
      if (now?.status !== RedemptionStatus.PROCESSING && now?.status !== RedemptionStatus.DELIVERED) {
        this.logger.error(
          `[hubble] order ${order.orderNumber}: Hubble PROCESSING claim lost (order changed meanwhile) — flagged for ops`,
        );
        await this.markHubblePendingReconcile(order.id, 'HUBBLE_PROCESSING_CLAIM_LOST');
      }
      return;
    }
    this.logger.log(`[hubble] order ${order.orderNumber} marked PROCESSING (awaiting Hubble)`);
  }

  /**
   * FAILED — refund the points (reusing the canonical reversal path) and mark the
   * order FAILED. Idempotent: the atomic pointsDeducted (>0 → 0) claim guarantees the
   * reversal fires AT MOST ONCE even under a confirm/webhook race or a double webhook.
   * valuePaise is zeroed so the 194R / gift-disbursal reports never count a failed order.
   */
  private async refundAndFailHubble(
    order: HubbleLoadedOrder,
    reason: string,
    actorId?: string,
  ): Promise<boolean> {
    // Returns true when THIS call moved the order to FAILED (points refunded if still debited);
    // false when it did not (already terminal, or BLOCKED by an issued voucher code).
    const flip = await this.prisma.$transaction(async (tx) => {
      // AUDIT-FIX (money): refund ONLY while the order is still non-terminal. Folding the
      // status predicate into the SAME atomic claim as the pointsDeducted zeroing means a
      // voucher already DELIVERED (points legitimately spent) can never also be refunded —
      // closing the "delivered voucher + points refunded" double-benefit window.
      const refundClaim = await tx.redemptionOrder.updateMany({
        where: {
          id: order.id,
          pointsDeducted: { gt: 0 },
          status: {
            in: [
              RedemptionStatus.CONFIRMED,
              RedemptionStatus.PROCESSING,
              RedemptionStatus.PENDING,
            ],
          },
          // Issued-voucher refund block: never refund while a code is on the order.
          ...noIssuedVoucherGuard(order.voucherCode),
        },
        data: { pointsDeducted: 0 },
      });
      if (refundClaim.count > 0) {
        await this.wallet.reverse(
          order.partnerId,
          order.pointsDeducted,
          { referenceId: order.id, description: `Refund ${order.orderNumber} (Hubble failed)` },
          tx,
        );
      }
      // Flip to FAILED (from any non-terminal state) + zero the value + record the reason.
      // Shared transition: the FAILED history row is now written only when the flip wins
      // (previously unconditional → a repeat failure on an already-terminal order added a
      // stray FAILED row, even on a DELIVERED voucher).
      return transitionOrderStatus(tx, {
        orderId: order.id,
        guard: {
          status: {
            in: [
              RedemptionStatus.CONFIRMED,
              RedemptionStatus.PROCESSING,
              RedemptionStatus.PENDING,
            ],
          },
          // …and never mark it FAILED either (it would strand a live code on a "failed" order).
          ...noIssuedVoucherGuard(order.voucherCode),
        },
        fromStatus: null,
        toStatus: RedemptionStatus.FAILED,
        changedById: actorId ?? null,
        notes: `Hubble failed — points refunded: ${reason}`.slice(0, 500),
        data: {
          valuePaise: 0n,
          voucherProvider: 'Hubble',
          cancelReason: reason.slice(0, 500),
          notes: `Hubble issuance failed: ${reason}`.slice(0, 500),
        },
      });
    });
    if (flip.count === 0) {
      // Not flipped: already terminal (idempotent repeat — fine), OR a voucher code is on the
      // still-open order (the guarded claims refused to refund/fail it) → flag for ops, loudly.
      const now = await this.prisma.redemptionOrder.findFirst({
        where: { id: order.id },
        select: { status: true, voucherCode: true },
      });
      if (
        now &&
        hasIssuedVoucher(now.voucherCode) &&
        (now.status === RedemptionStatus.CONFIRMED ||
          now.status === RedemptionStatus.PROCESSING ||
          now.status === RedemptionStatus.PENDING)
      ) {
        this.logger.error(
          `[hubble] order ${order.orderNumber}: Hubble failure (${reason}) but a voucher code is on the order — NOT refunded/failed; flagged for ops`,
        );
        await this.markHubblePendingReconcile(order.id, 'HUBBLE_FAILED_VOUCHER_PRESENT');
      }
      return false;
    }
    this.logger.warn(`[hubble] order ${order.orderNumber} FAILED + points refunded: ${reason}`);
    return true;
  }

  /** Flag an order as needing reconcile (money held pending webhook / ops), no status flip. */
  private async markHubblePendingReconcile(orderId: string, reason: string): Promise<void> {
    try {
      const existing = await this.prisma.redemptionOrder.findFirst({
        where: { id: orderId },
        select: { metadata: true },
      });
      const prevMeta =
        existing?.metadata && typeof existing.metadata === 'object'
          ? (existing.metadata as Record<string, unknown>)
          : {};
      await this.prisma.redemptionOrder.update({
        where: { id: orderId },
        data: {
          metadata: {
            ...prevMeta,
            hubbleNeedsReconcile: true,
            hubbleReconcileReason: reason,
            hubbleReconcileAt: new Date().toISOString(),
          },
        },
      });
    } catch (e) {
      this.logger.error(`[hubble] failed to flag order ${orderId} for reconcile: ${e}`);
    }
  }

  /** Merge a patch onto an order's existing JSON metadata (preserving prior keys). */
  private mergeOrderMetadata(
    existing: Prisma.JsonValue,
    patch: Record<string, unknown>,
  ): Prisma.InputJsonValue {
    const base =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? (existing as Record<string, unknown>)
        : {};
    return { ...base, ...patch } as Prisma.InputJsonValue;
  }

  /** Build the metadata blob persisted on a delivered Hubble order (full card detail). */
  private buildHubbleVoucherMetadata(
    voucher: HubbleVoucher | undefined,
    body: HubbleOrderResult,
  ): Record<string, unknown> {
    return {
      hubbleStatus: 'SUCCESS',
      hubbleOrderId: body.id ?? body.orderId ?? null,
      hubbleVoucher: {
        id: voucher?.id ?? null,
        cardType: voucher?.cardType ?? null,
        // AUDIT-FIX (PII): the card number / PIN are the SPENDABLE secret. The member
        // receives them via the order's voucherCode + voucherPin columns (member-scoped
        // select; card+PIN products store the PIN in voucherPin — hubbleVoucherCredentials).
        // We deliberately do NOT duplicate either into metadata, which operator order-reads
        // return in full. Non-sensitive fields only here.
        validTill: voucher?.validTill ?? null,
        amount: voucher?.amount ?? null,
      },
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // P5.3 — Admin Reward Catalog CRUD (real RewardCategory / RewardCatalog).
  // Supersedes the World-B `admin/gift-config` JSON blob (retired with the FE in
  // 5.5). Every query is tenant-scoped by clientId from the JWT.
  //
  // STOCK RULE (the simplest coherent choice): `stockQuantity` null/absent =
  // untracked (always purchasable). When a write sets stockQuantity === 0, the
  // service forces status = OUT_OF_STOCK so the partner read (filters
  // status='ACTIVE') drops the item; setting stock > 0 again does NOT auto-flip
  // status back to ACTIVE — an admin re-activates explicitly (avoids resurrecting
  // a DISCONTINUED item). Stock is NOT decremented on this CRUD path — the
  // CONFIRM path does it: confirmRedeem / confirmRedeemForOutlet atomically
  // decrement stockQuantity (guarded `updateMany` WHERE stockQuantity >= quantity
  // → rejects the last-unit race, oversell-safe) and flip status to OUT_OF_STOCK
  // when it reaches 0.
  //
  // ⚠️ DELIBERATE, NON-OBVIOUS (owner decision 2026-08-19): a confirmed
  // redemption CONSUMES its stock unit PERMANENTLY. Stock is intentionally NOT
  // restored on cancel/return/failed — `transitionOrder` refunds the POINTS only
  // and never re-increments stockQuantity. An item that flipped OUT_OF_STOCK
  // stays out until an admin explicitly re-stocks / re-activates it. This is by
  // design (not a gap) — do NOT add a stock-restore to the refund path.
  // ───────────────────────────────────────────────────────────────────────────

  /** POST /v1/admin/rewards/categories — create a tenant-scoped category. */
  async createCategory(user: JwtPayload, dto: CreateRewardCategoryDto) {
    // A parent, if given, must belong to the same tenant.
    if (dto.parentId) {
      const parent = await this.prisma.rewardCategory.findFirst({
        where: { id: dto.parentId, clientId: user.clientId },
      });
      if (!parent) throw new BadRequestException('Parent category not found in this tenant');
    }

    // `code` is the human key — keep it unique within the tenant.
    const clash = await this.prisma.rewardCategory.findFirst({
      where: { clientId: user.clientId, code: dto.code },
    });
    if (clash) throw new ConflictException('A category with this code already exists');

    const category = await this.prisma.rewardCategory.create({
      data: {
        clientId: user.clientId,
        parentId: dto.parentId ?? null,
        code: dto.code,
        name: dto.name,
        description: dto.description,
        imageUrl: dto.imageUrl,
        sortOrder: dto.sortOrder ?? 0,
        isActive: dto.isActive ?? true,
      },
    });
    return { category };
  }

  /** GET /v1/admin/rewards/categories — list ALL tenant categories (incl. inactive). */
  async listCategories(user: JwtPayload) {
    const categories = await this.prisma.rewardCategory.findMany({
      where: { clientId: user.clientId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return { categories };
  }

  /**
   * GET /v1/admin/rewards/catalog — admin catalogue list (ALL statuses, non-deleted),
   * tenant-scoped, with the category name. Unlike the partner `listCatalog`, this is
   * NOT filtered to ACTIVE — admins manage inactive/out-of-stock/discontinued items.
   */
  async adminListCatalog(user: JwtPayload, q: AdminListCatalogQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    const skip = (page - 1) * limit;

    const where: Prisma.RewardCatalogWhereInput = {
      clientId: user.clientId,
      deletedAt: null,
    };
    if (q.status) where.status = q.status;
    if (q.categoryId) where.categoryId = q.categoryId;

    const [items, total] = await Promise.all([
      this.prisma.rewardCatalog.findMany({
        where,
        include: { category: { select: { id: true, name: true, code: true } } },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        skip,
        take: limit,
      }),
      this.prisma.rewardCatalog.count({ where }),
    ]);

    return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  /** PATCH /v1/admin/rewards/categories/:id — tenant-scoped update. */
  async updateCategory(user: JwtPayload, id: string, dto: UpdateRewardCategoryDto) {
    const existing = await this.prisma.rewardCategory.findFirst({
      where: { id, clientId: user.clientId },
    });
    if (!existing) throw new NotFoundException('Category not found');

    if (dto.parentId !== undefined && dto.parentId !== null) {
      if (dto.parentId === id) {
        throw new BadRequestException('A category cannot be its own parent');
      }
      const parent = await this.prisma.rewardCategory.findFirst({
        where: { id: dto.parentId, clientId: user.clientId },
      });
      if (!parent) throw new BadRequestException('Parent category not found in this tenant');
    }

    if (dto.code !== undefined && dto.code !== existing.code) {
      const clash = await this.prisma.rewardCategory.findFirst({
        where: { clientId: user.clientId, code: dto.code },
      });
      if (clash) throw new ConflictException('A category with this code already exists');
    }

    const category = await this.prisma.rewardCategory.update({
      where: { id },
      data: {
        code: dto.code,
        name: dto.name,
        description: dto.description,
        parentId: dto.parentId,
        imageUrl: dto.imageUrl,
        sortOrder: dto.sortOrder,
        isActive: dto.isActive,
      },
    });
    return { category };
  }

  /**
   * DELETE /v1/admin/rewards/categories/:id — DEACTIVATE via isActive=false.
   * `RewardCategory` has no `deletedAt` column: this is a reversible toggle, not a
   * soft-delete. Re-deleting an already-inactive category is a harmless no-op, and
   * PATCH { isActive: true } intentionally reactivates it (catalog items, by
   * contrast, ARE soft-deleted via deletedAt). Blocked if the category still has
   * non-deleted catalog items (prevents orphaning the items' FK + a dangling
   * partner-facing category).
   */
  async deleteCategory(user: JwtPayload, id: string) {
    const existing = await this.prisma.rewardCategory.findFirst({
      where: { id, clientId: user.clientId },
    });
    if (!existing) throw new NotFoundException('Category not found');

    const itemCount = await this.prisma.rewardCatalog.count({
      where: { categoryId: id, clientId: user.clientId, deletedAt: null },
    });
    if (itemCount > 0) {
      throw new ConflictException(
        'Category has active catalog items; remove or re-home them first',
      );
    }

    const category = await this.prisma.rewardCategory.update({
      where: { id },
      data: { isActive: false },
    });
    return { category };
  }

  /**
   * POST /v1/admin/rewards/catalog — create a catalog item.
   * Validates: categoryId belongs to the tenant; min <= max when both set.
   * (pointsCost >= 0 is enforced by the DTO.)
   */
  async createCatalogItem(user: JwtPayload, dto: CreateRewardCatalogDto) {
    const category = await this.prisma.rewardCategory.findFirst({
      where: { id: dto.categoryId, clientId: user.clientId },
    });
    if (!category) throw new BadRequestException('Category not found in this tenant');

    // ── Hubble per-brand amounts (GIFT_CARD + Hubble-enabled tenant only) ──────────────
    // The productId is honoured ONLY for a Hubble-enabled tenant (byte-identical guard below);
    // the flag is read ONLY when a productId was actually sent, so a non-Hubble tenant's create
    // does no extra read. A Hubble GIFT_CARD is validated against the LIVE Hubble product, and an
    // admin amounts list derives the points band (overriding any client-sent band).
    const hubbleProductId = dto.hubbleProductId?.trim() || null;
    const hubbleOn = hubbleProductId ? await this.isHubbleEnabledForTenant(user.clientId) : false;
    const isHubbleGiftCard = !!hubbleProductId && hubbleOn && dto.redemptionMode === PayoutMode.GIFT_CARD;
    const hubbleDenoms = dto.hubbleDenominations?.length
      ? normaliseHubbleDenominations(dto.hubbleDenominations)
      : null;
    if (hubbleDenoms && !isHubbleGiftCard) {
      throw new BadRequestException(
        'Gift card amounts can only be chosen for a Hubble gift card (Hubble enabled for this program and a Hubble product ID set).',
      );
    }
    let minRedemptionPoints = dto.minRedemptionPoints;
    let maxRedemptionPoints = dto.maxRedemptionPoints;
    if (isHubbleGiftCard) {
      const band = await this.checkHubbleItemAgainstProduct(user.clientId, hubbleProductId!, {
        denominations: hubbleDenoms,
        minRedemptionPoints,
        maxRedemptionPoints,
        sellingValuePaise: dto.sellingValuePaise ?? null,
      });
      if (band) ({ minRedemptionPoints, maxRedemptionPoints } = band);
    }

    this.assertRedemptionRange(minRedemptionPoints, maxRedemptionPoints);

    // Selling value can't exceed MRP when both are supplied (price integrity + an honest
    // slash: slashPoints only shows when mrp > selling, so an inverted pair is a config error).
    this.assertSellingValueBounds(dto.sellingValuePaise, dto.mrpPaise);

    // PURE DERIVE: pointsCost is no longer a client input. A FREE_AMOUNT (variable-amount)
    // item carries a min/max band and keeps pointsCost 0; everything else is FIXED and its
    // pointsCost is DERIVED from the ₹ selling value × the tenant conversion rate.
    const pointsCost = await this.resolveAdminPointsCost(user.clientId, {
      minRedemptionPoints,
      maxRedemptionPoints,
      deriveFromSellingValuePaise: dto.sellingValuePaise ?? null,
      // No stored fallback on CREATE: a FIXED item MUST supply a selling value.
      keepPointsCost: null,
      requireSellingValueWhenFixed: true,
    });

    // A pointsCost-0 item is only ever a FREE_AMOUNT voucher, and it MUST carry a
    // complete [min, max] range — reject a half-configured one (see the helper).
    this.assertFreeAmountComplete(
      pointsCost,
      minRedemptionPoints,
      maxRedemptionPoints,
    );

    // Code unique within the tenant (among non-deleted items).
    const clash = await this.prisma.rewardCatalog.findFirst({
      where: { clientId: user.clientId, code: dto.code, deletedAt: null },
    });
    if (clash) throw new ConflictException('A catalog item with this code already exists');

    // Stock rule: explicit 0 forces OUT_OF_STOCK regardless of requested status.
    const status =
      dto.stockQuantity === 0 ? 'OUT_OF_STOCK' : dto.status ?? 'ACTIVE';

    // Stock decrement lives in the CONFIRM path (confirmRedeem /
    // confirmRedeemForOutlet): guarded atomic decrement + OUT_OF_STOCK flip at 0.
    // This CRUD path only sets the initial value. By design, stock is NOT restored
    // on cancel/return/failed (owner 2026-08-19) — see the STOCK RULE note above.
    // AUDIT-FIX (byte-identical / defense-in-depth): persist a Hubble productId ONLY for a
    // tenant with the Hubble flag ON (Bajaj). A non-Hubble tenant (Deoleo) can therefore
    // never carry a hubbleProductId, so isHubbleEligible short-circuits for its items with
    // NO tenant-flag DB read — keeping the query profile identical, not just the behaviour.
    const hubbleMetadata =
      hubbleProductId && hubbleOn
        ? ({
            hubbleProductId,
            ...(hubbleDenoms ? { hubbleDenominations: hubbleDenoms } : {}),
          } as Prisma.InputJsonValue)
        : undefined;

    const item = await this.prisma.rewardCatalog.create({
      data: {
        clientId: user.clientId,
        categoryId: dto.categoryId,
        code: dto.code,
        name: dto.name,
        description: dto.description,
        imageUrls: (dto.imageUrls ?? undefined) as Prisma.InputJsonValue | undefined,
        // DERIVED (pure derive) — FIXED: round(sellingValue/100 × rate); FREE_AMOUNT: 0.
        pointsCost,
        mrpPaise: dto.mrpPaise,
        // Cost basis for the rate-independent slash + rate-immune 194R freeze (+ the FIXED
        // price driver the pointsCost above is derived from).
        sellingValuePaise: dto.sellingValuePaise,
        redemptionMode: dto.redemptionMode,
        status,
        // = the DTO band, except a Hubble amounts list derives it (see above).
        minRedemptionPoints,
        maxRedemptionPoints,
        stockQuantity: dto.stockQuantity,
        termsAndConditions: dto.termsAndConditions,
        sortOrder: dto.sortOrder ?? 0,
        // Hubble auto-issuance config (GIFT_CARD only, Bajaj-only — see hubbleMetadata above).
        metadata: hubbleMetadata,
      },
    });
    return { item };
  }

  /** PATCH /v1/admin/rewards/catalog/:id — tenant-scoped, non-deleted item. */
  async updateCatalogItem(user: JwtPayload, id: string, dto: UpdateRewardCatalogDto) {
    const existing = await this.prisma.rewardCatalog.findFirst({
      where: { id, clientId: user.clientId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Reward item not found');

    if (dto.categoryId !== undefined) {
      const category = await this.prisma.rewardCategory.findFirst({
        where: { id: dto.categoryId, clientId: user.clientId },
      });
      if (!category) throw new BadRequestException('Category not found in this tenant');
    }

    // Validate the EFFECTIVE values Prisma will actually persist. `undefined` in the
    // DTO means "leave unchanged" (Prisma skips it); an explicit null/value is written —
    // so mirror that here (a bare `??` would collapse an explicit null into the stored
    // value and let a max-clearing PATCH slip a free-amount voucher into a broken state).
    let effMin =
      dto.minRedemptionPoints !== undefined ? dto.minRedemptionPoints : existing.minRedemptionPoints;
    let effMax =
      dto.maxRedemptionPoints !== undefined ? dto.maxRedemptionPoints : existing.maxRedemptionPoints;

    // Validate the EFFECTIVE selling value vs MRP (payload value if present, else stored),
    // so a PATCH that raises selling value above MRP — or lowers MRP below it — is rejected.
    const effSellingValue =
      dto.sellingValuePaise !== undefined ? dto.sellingValuePaise : existing.sellingValuePaise;
    const effMrp = dto.mrpPaise !== undefined ? dto.mrpPaise : existing.mrpPaise;

    // ── Hubble per-brand amounts (see createCatalogItem) ────────────────────────────────
    // Resolve the EFFECTIVE productId / mode / amounts list after this PATCH. The tenant flag is
    // read only when a productId is being set or one is already stored (never for a non-Hubble
    // item). The live-product check runs only when a Hubble-relevant value actually CHANGES, so
    // an unrelated edit (name, stock, T&C) never depends on Hubble being reachable.
    const existingProductId = this.extractHubbleProductId(existing.metadata);
    const existingDenoms = extractHubbleDenominations(existing.metadata);
    let hubbleOn: boolean | null = null;
    let effProductId: string | null;
    if (dto.hubbleProductId !== undefined) {
      const v = dto.hubbleProductId.trim();
      hubbleOn = v ? await this.isHubbleEnabledForTenant(user.clientId) : false;
      effProductId = v && hubbleOn ? v : null;
    } else {
      effProductId = existingProductId;
    }
    const effMode = dto.redemptionMode ?? existing.redemptionMode;
    // An explicit FIXED-PRICE payload (min AND max explicitly null + a selling value) with no
    // amounts field means "this is a fixed-price item now" → the list is cleared, consistently
    // with the band being cleared (otherwise a stale list would re-derive a band over it).
    const explicitFixedPrice =
      dto.hubbleDenominations === undefined &&
      dto.minRedemptionPoints === null &&
      dto.maxRedemptionPoints === null &&
      dto.sellingValuePaise != null;
    let effDenoms: number[] =
      dto.hubbleDenominations === undefined
        ? explicitFixedPrice ? [] : existingDenoms
        : dto.hubbleDenominations.length
          ? normaliseHubbleDenominations(dto.hubbleDenominations)
          : [];
    if (effProductId && hubbleOn === null && (effDenoms.length || dto.hubbleDenominations !== undefined)) {
      hubbleOn = await this.isHubbleEnabledForTenant(user.clientId);
    }
    const isHubbleGiftCard = !!effProductId && effMode === PayoutMode.GIFT_CARD;
    if (dto.hubbleDenominations?.length && !(isHubbleGiftCard && hubbleOn)) {
      throw new BadRequestException(
        'Gift card amounts can only be chosen for a Hubble gift card (Hubble enabled for this program and a Hubble product ID set).',
      );
    }
    // An amounts list only lives alongside a Hubble GIFT_CARD productId — drop it otherwise.
    if (!isHubbleGiftCard) effDenoms = [];
    const sameList = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);
    const hubbleRelevantChange =
      effProductId !== existingProductId ||
      !sameList(effDenoms, existingDenoms) ||
      effMin !== existing.minRedemptionPoints ||
      effMax !== existing.maxRedemptionPoints ||
      effSellingValue !== existing.sellingValuePaise ||
      effMode !== existing.redemptionMode;
    if (isHubbleGiftCard && hubbleRelevantChange) {
      if (hubbleOn === null) hubbleOn = await this.isHubbleEnabledForTenant(user.clientId);
      if (hubbleOn) {
        const band = await this.checkHubbleItemAgainstProduct(user.clientId, effProductId!, {
          denominations: effDenoms.length ? effDenoms : null,
          minRedemptionPoints: effMin,
          maxRedemptionPoints: effMax,
          sellingValuePaise: effSellingValue,
        });
        if (band) {
          effMin = band.minRedemptionPoints;
          effMax = band.maxRedemptionPoints;
        }
      }
    }
    // The band to WRITE: a derived Hubble band overrides; otherwise the DTO value as before
    // (undefined = leave unchanged).
    const bandDerived = effDenoms.length > 0 && isHubbleGiftCard && hubbleRelevantChange && hubbleOn === true;
    const writeMin = bandDerived ? effMin : dto.minRedemptionPoints;
    const writeMax = bandDerived ? effMax : dto.maxRedemptionPoints;

    this.assertRedemptionRange(effMin, effMax);
    this.assertSellingValueBounds(effSellingValue, effMrp);

    // PURE DERIVE (non-breaking transition). FREE_AMOUNT (a min/max band) keeps pointsCost 0.
    // A FIXED item re-derives pointsCost ONLY when the admin EXPLICITLY sets/changes the
    // selling value in THIS update (dto.sellingValuePaise present + non-null); an unrelated
    // edit (name/status/stock/T&C) leaves the stored pointsCost untouched and never reads the
    // rate — so there is no silent re-price on drift and no 0/unset-rate edit lockout.
    const sellingValueProvided =
      dto.sellingValuePaise !== undefined && dto.sellingValuePaise !== null;
    const pointsCost = await this.resolveAdminPointsCost(user.clientId, {
      minRedemptionPoints: effMin,
      maxRedemptionPoints: effMax,
      deriveFromSellingValuePaise: sellingValueProvided ? dto.sellingValuePaise! : null,
      keepPointsCost: existing.pointsCost ?? null,
      requireSellingValueWhenFixed: false,
    });
    this.assertFreeAmountComplete(pointsCost, effMin, effMax);

    if (dto.code !== undefined && dto.code !== existing.code) {
      const clash = await this.prisma.rewardCatalog.findFirst({
        where: { clientId: user.clientId, code: dto.code, deletedAt: null },
      });
      if (clash) throw new ConflictException('A catalog item with this code already exists');
    }

    // Stock rule: an item can never read as ACTIVE while its EFFECTIVE stock
    // (payload value if present, else the stored value) is 0 — otherwise a bare
    // `{ status: 'ACTIVE' }` PATCH would re-list a genuinely out-of-stock item.
    // Setting stock to 0 also forces OUT_OF_STOCK. Raising stock does NOT
    // auto-reactivate (admin re-activates explicitly).
    const effectiveStock =
      dto.stockQuantity !== undefined ? dto.stockQuantity : existing.stockQuantity;
    let status = dto.status;
    if (effectiveStock === 0 && (status === 'ACTIVE' || dto.stockQuantity === 0)) {
      status = 'OUT_OF_STOCK';
    }

    // Hubble auto-issuance config patch (GIFT_CARD only). `undefined` = leave metadata
    // unchanged; a non-empty value sets metadata.hubbleProductId; an empty string
    // removes it (merge-preserving any other metadata keys). No schema change.
    let metadataUpdate: Prisma.InputJsonValue | undefined;
    const denomsChanged = !sameList(effDenoms, existingDenoms);
    if (dto.hubbleProductId !== undefined || denomsChanged) {
      const base =
        existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
          ? { ...(existing.metadata as Record<string, unknown>) }
          : {};
      if (dto.hubbleProductId !== undefined) {
        // AUDIT-FIX (byte-identical): SET a productId only for a Hubble-enabled tenant (Bajaj);
        // for any other tenant, or an empty value, CLEAR it. Clearing is always allowed, so a
        // non-Hubble tenant can never end up with a hubbleProductId on an item. (effProductId
        // already encodes exactly that rule.)
        if (effProductId) base.hubbleProductId = effProductId;
        else delete base.hubbleProductId;
      }
      if (denomsChanged) {
        if (effDenoms.length) base.hubbleDenominations = effDenoms;
        else delete base.hubbleDenominations;
      }
      metadataUpdate = base as Prisma.InputJsonValue;
    }

    const item = await this.prisma.rewardCatalog.update({
      where: { id },
      data: {
        metadata: metadataUpdate,
        categoryId: dto.categoryId,
        code: dto.code,
        name: dto.name,
        description: dto.description,
        imageUrls: (dto.imageUrls ?? undefined) as Prisma.InputJsonValue | undefined,
        // DERIVED (pure derive). FIXED: round(effective sellingValue/100 × rate), or the
        // kept stored value when no selling value is available; FREE_AMOUNT: 0.
        pointsCost,
        mrpPaise: dto.mrpPaise,
        // Cost basis + FIXED price driver (optional). undefined = leave unchanged (Prisma skips it).
        sellingValuePaise: dto.sellingValuePaise,
        redemptionMode: dto.redemptionMode,
        status,
        // Bounds are meaningful ONLY for a FREE_AMOUNT item (pointsCost === 0). On a
        // FIXED item (or a FREE→FIXED transition) force them null so a direct-API PATCH
        // can't leave stale [min,max] on the row; for a FREE item write the DTO value
        // (undefined = keep existing, which the guard has already validated as complete).
        // (A Hubble amounts list writes its derived band — writeMin/writeMax.)
        minRedemptionPoints: pointsCost === 0 ? writeMin : null,
        maxRedemptionPoints: pointsCost === 0 ? writeMax : null,
        stockQuantity: dto.stockQuantity,
        termsAndConditions: dto.termsAndConditions,
        sortOrder: dto.sortOrder,
      },
    });
    return { item };
  }

  /**
   * DELETE /v1/admin/rewards/catalog/:id — soft delete (sets deletedAt),
   * mirroring the read filter `deletedAt: null` so the item drops from the
   * active catalog immediately.
   */
  async deleteCatalogItem(user: JwtPayload, id: string) {
    const existing = await this.prisma.rewardCatalog.findFirst({
      where: { id, clientId: user.clientId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Reward item not found');

    const item = await this.prisma.rewardCatalog.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { item };
  }

  /**
   * Address quality (§12) — validate a delivery pincode for a physical gift at
   * redeem. The DTO already enforces 6 digits; this adds the real-India rule (first
   * digit 1–9 — no Indian PIN starts with 0). Serviceability lookup is out of scope
   * (no serviceability dataset in v1); this is format/plausibility only.
   */
  private assertValidPincode(pincode?: string | null) {
    if (!pincode || !/^[1-9]\d{5}$/.test(pincode)) {
      throw new BadRequestException(
        'A valid 6-digit delivery pincode is required for physical gifts.',
      );
    }
  }

  /**
   * sellingValuePaise <= mrpPaise when BOTH are provided (a selling price can't exceed MRP).
   * Both are OPTIONAL on an admin item, so a missing value skips the check (nothing to bound).
   * A 0 is a real value and still participates (0 <= mrp always holds).
   */
  private assertSellingValueBounds(
    sellingValuePaise?: number | null,
    mrpPaise?: number | null,
  ) {
    if (
      sellingValuePaise != null &&
      mrpPaise != null &&
      sellingValuePaise > mrpPaise
    ) {
      throw new BadRequestException('sellingValuePaise must be <= mrpPaise');
    }
  }

  /**
   * Rate-INDEPENDENT catalogue MRP-slash, computed member-side from the item's cost basis.
   * Returns the struck-through "list price" in POINTS, or null when the slash must not show.
   *
   * slashPoints = round(pointsCost × mrpPaise ÷ sellingValuePaise), returned ONLY when ALL hold:
   *   - sellingValuePaise is a real positive value (the cost basis anchor);
   *   - mrpPaise is a real positive value;
   *   - pointsCost > 0 (a fixed-price item — excludes FREE_AMOUNT / cash-band items); AND
   *   - the result is STRICTLY greater than pointsCost (never equal/inverted — an honest slash).
   * Unlike the retired FE `mrpPaise × rate` math, this is INDEPENDENT of the tenant conversion
   * rate, so it never drifts when the rate changes after the item was priced.
   */
  private computeSlashPoints(item: {
    pointsCost: number;
    mrpPaise?: number | null;
    sellingValuePaise?: number | null;
  }): number | null {
    const { pointsCost, mrpPaise, sellingValuePaise } = item;
    if (sellingValuePaise == null || sellingValuePaise <= 0) return null;
    if (mrpPaise == null || mrpPaise <= 0) return null;
    if (!(pointsCost > 0)) return null;
    const slash = Math.round((pointsCost * mrpPaise) / sellingValuePaise);
    return slash > pointsCost ? slash : null;
  }

  /** min <= max when both bounds are provided (FREE_AMOUNT voucher range). */
  private assertRedemptionRange(min?: number | null, max?: number | null) {
    if (min != null && max != null && min > max) {
      throw new BadRequestException(
        'minRedemptionPoints must be <= maxRedemptionPoints',
      );
    }
  }

  /**
   * A `pointsCost === 0` catalog item is only ever a FREE_AMOUNT (variable-amount)
   * voucher, and isFreeAmount() treats an item as free-amount ONLY when BOTH bounds
   * are set. A half-configured one (a min but no max, or neither) silently degrades
   * to a "fixed, cost 0" item that every redeem rejects with "Redemption must cost a
   * positive number of points" — an un-redeemable voucher that still looks fine in the
   * catalogue. Reject it at write time so a broken voucher can never be saved.
   */
  private assertFreeAmountComplete(
    pointsCost: number | null | undefined,
    min?: number | null,
    max?: number | null,
  ) {
    if (pointsCost !== 0) return;
    if (min == null || max == null) {
      throw new BadRequestException(
        'A variable-amount (FREE_AMOUNT) voucher requires both minRedemptionPoints and maxRedemptionPoints.',
      );
    }
    if (min < 1) {
      throw new BadRequestException(
        'A variable-amount (FREE_AMOUNT) voucher must have minRedemptionPoints >= 1',
      );
    }
  }

  /**
   * PURE DERIVE resolver for the admin catalogue (/admin/gifts) create/update paths.
   * `pointsCost` is NO LONGER a client input — the service sets it:
   *   - FREE_AMOUNT (a min/max band is present) → 0. The admin still enters the points
   *     band; the redeem-time ₹ amount drives the actual spend. Derivation does NOT apply.
   *     A partial band (only min, or only max) is still routed here as free-amount so the
   *     caller's assertFreeAmountComplete rejects it with the precise "requires both" message.
   *   - FIXED with a selling value available (sent, or — on UPDATE — already stored) →
   *     round(sellingValue/100 × tenant conversion rate). A result that rounds to 0 (rate
   *     unset/0, or the value too small) is REJECTED (mirrors gift-catalogue publish).
   *   - FIXED with NO selling value available:
   *       · CREATE (no stored fallback) → 400: a selling value is REQUIRED (the price driver).
   *       · UPDATE (a positive stored pointsCost) → KEEP it (non-breaking transition: a legacy
   *         item priced before pure-derive stays redeemable until a selling value is set).
   */
  private async resolveAdminPointsCost(
    clientId: string,
    input: {
      minRedemptionPoints?: number | null;
      maxRedemptionPoints?: number | null;
      /**
       * The ₹ selling value to DERIVE from, or null to NOT derive. On CREATE this is the
       * supplied value; on UPDATE it is non-null ONLY when the admin is explicitly
       * setting/changing the selling value (dto.sellingValuePaise present + non-null) — a
       * benign edit passes null so pointsCost is NEVER silently re-priced (and the rate is
       * never even read, so a 0/unset rate can't lock an item out of editing).
       */
      deriveFromSellingValuePaise: number | null;
      /** UPDATE only: the stored pointsCost to PRESERVE when not deriving. null on CREATE. */
      keepPointsCost: number | null;
      /** CREATE only: a FIXED item with no selling value is rejected (the price driver). */
      requireSellingValueWhenFixed: boolean;
    },
  ): Promise<number> {
    const isFreeAmount =
      input.minRedemptionPoints != null || input.maxRedemptionPoints != null;
    if (isFreeAmount) return 0;

    // Derive ONLY when a selling value is actually being set/changed.
    if (input.deriveFromSellingValuePaise != null) {
      const rate = await this.tenantSettings.getConversionRate(clientId);
      const pointsCost = derivePointsCost(input.deriveFromSellingValuePaise, rate);
      if (pointsCost < 1) {
        throw new BadRequestException(
          "This reward's points cost resolves to 0 — set a higher selling value, or the tenant conversion rate is not configured.",
        );
      }
      return pointsCost;
    }

    // Not deriving: UPDATE preserves the stored price verbatim — no rate read, no re-price,
    // no derived-<1 error — so an unrelated edit never re-prices and a 0/unset rate never
    // 400s (matches gift-catalogue's preserve-on-rate-drift).
    if (input.keepPointsCost != null) return input.keepPointsCost;

    // CREATE FIXED with no selling value → the price driver is required.
    if (input.requireSellingValueWhenFixed) {
      throw new BadRequestException(
        'A selling value (₹) is required for a fixed-price reward.',
      );
    }
    // No stored price and no new selling value (not expected for a real row): leave 0 —
    // assertFreeAmountComplete then rejects a 0-cost item that carries no band.
    return 0;
  }
}
