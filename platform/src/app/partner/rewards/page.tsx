'use client';

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Gift, Search, CheckCircle,
  Shield, Package, Truck, Zap, Heart,
  Banknote, CreditCard, Tag,
  AlertCircle, Phone,
  Upload, FileText, Loader2, X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast } from '@/components/ui/toast';
import { formatPoints, maskAccountNumber } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api-client';
import { usePartnerIdentity, type DeliveryDefaults } from '@/lib/partner-identity';
import { applyAddressPrefill, type AddressForm, type TouchedFields } from './address-prefill';
import { getGifsySettings } from '@/lib/gifsy-settings';
import { useTenantFeatures } from '@/lib/tenant-features';
import { BankOrUpiSection, type PaymentMode } from '@/components/bank-or-upi-section';
import { pinnedPaymentMode, type OutletPaymentType } from '@/lib/payment-type';

/* ─── Partner cash beneficiary (from GET /api/auth/me) ─────────────────────────
   The partner's real, on-file KYC payout details + the tenant conversionRate.
   This is the single source of truth for the cash-payout flow — there is NO
   hardcoded bank/UPI literal and the cash min/rate no longer come from the
   localStorage gifsy-settings drift. */
interface CashBeneficiary {
  bankName: string | null;
  bankAccountNumber: string | null;
  bankAccountHolder: string | null;
  ifscCode: string | null;
  upiId: string | null;
  paymentMode: string | null;
}

/** True when the partner has at least one payout rail (bank or UPI) on file. */
function hasBeneficiary(b: CashBeneficiary | null): boolean {
  return !!b && (!!b.upiId || (!!b.bankAccountNumber && !!b.ifscCode));
}

/* ─── Catalogue item (live API shape, UI-augmented) ───────────────────────────
   Live data only — fields come straight from GET /api/rewards/catalog. We keep a
   small set of presentational fallbacks (emoji/gradient) so the grid renders even
   when the backend has no image, but there is NO localStorage / GIFT_CATALOGUE
   fallback path. */

type VoucherDenominationType = 'FIXED' | 'FREE_AMOUNT';

interface CatalogueItem {
  id: string;
  name: string;
  brand: string;
  category: string;
  points: number;            // pointsCost — 0 for FREE_AMOUNT vouchers
  description: string;
  details: string;
  features: string[];
  emoji: string;
  gradientFrom: string;
  gradientTo: string;
  imageDataUrl: string | null;
  available: boolean;
  popular: boolean;
  isAffordable: boolean;
  /** Backend redemption mode, e.g. 'GIFT_CARD' | 'PHYSICAL_GIFT' | 'BANK_TRANSFER' | 'UPI'. */
  redemptionMode?: string | null;
  /** Set only for category === 'Vouchers' */
  voucherType?: VoucherDenominationType;
  /** Face value for FIXED vouchers (₹). */
  fixedAmount?: number;
  /** Min/max redeemable points for FREE_AMOUNT vouchers (server-validated). */
  minRedemptionPoints?: number | null;
  maxRedemptionPoints?: number | null;
  categorySort?: number | null;
  /**
   * Rate-INDEPENDENT catalogue MRP-slash, in POINTS, computed SERVER-SIDE
   * (pointsCost × mrpPaise ÷ sellingValuePaise, where both cost-basis inputs stay server-side)
   * and returned by GET /api/rewards/catalog ONLY when the per-tenant `catalogueMrpSlash` flag
   * is ON. null/absent ⇒ no honest slash (flag OFF, no selling value, inverted, or FREE_AMOUNT).
   * The FE renders this struck-through — it NO LONGER derives it from mrpPaise × rate (which
   * drifted when the rate changed; `mrpPaise` is no longer shipped to the member at all).
   */
  slashPoints?: number | null;
  /**
   * DPDP consent gate (design decision #15). TRUE when this item is vendor-sourced
   * (sourceType=VENDOR) and redeeming it shares the member's delivery name/address/phone
   * with a third-party fulfilment partner → a blocking, default-unticked consent
   * checkbox is required. Platform/Gifsy-fulfilled items are FALSE (no third party, no
   * checkbox). The member catalogue deliberately hides the raw sourceType (PII/scoping),
   * so we key off this dedicated flag — FLAGGED for BE: expose `requiresConsent` on each
   * GET /api/rewards/catalog item.
   */
  requiresConsent?: boolean;
}

/** Raw item shape returned by GET /api/rewards/catalog. */
interface ApiCatalogItem {
  id: string;
  name: string;
  brand?: string | null;
  category: string;
  pointsCost: number;
  description?: string | null;
  details?: string | null;
  features?: string[] | null;
  imageUrl?: string | null;
  imageUrls?: string[] | null;
  available?: boolean;
  popular?: boolean;
  isAffordable?: boolean;
  redemptionMode?: string | null;       // 'GIFT_CARD' | 'PHYSICAL_GIFT' | ...
  voucherType?: VoucherDenominationType | null;
  fixedAmount?: number | null;
  minRedemptionPoints?: number | null;
  maxRedemptionPoints?: number | null;
  /** Rate-independent MRP-slash in points, computed server-side (flag-gated). See CatalogueItem.slashPoints. */
  slashPoints?: number | null;
  categorySort?: number | null;
  /** See CatalogueItem.requiresConsent — vendor-sourced items set this true (BE-exposed). */
  requiresConsent?: boolean | null;
}

/* Presentational defaults for items the backend returns without imagery. */
const GRADIENT_POOL: Array<{ emoji: string; from: string; to: string }> = [
  { emoji: '🎁', from: 'var(--brand-primary)', to: '#22c55e' },
  { emoji: '🛍️', from: '#FF9900',             to: '#FFB347' },
  { emoji: '🎧', from: '#7c3aed',             to: '#a78bfa' },
  { emoji: '⌚', from: '#1d4ed8',             to: '#60a5fa' },
  { emoji: '🔋', from: '#0ea5e9',             to: '#38bdf8' },
];

function hashIndex(id: string, len: number): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h) % len;
}

/** Infer a voucher type from the API item when not explicitly provided. */
function inferVoucherType(item: ApiCatalogItem): VoucherDenominationType | undefined {
  if (item.voucherType) return item.voucherType;
  // Vouchers are GIFT_CARD-mode items (the admin's VOUCHER_LIKE definition).
  // Fall back to the legacy category label for older rows that predate the mode.
  const isVoucher = item.redemptionMode === 'GIFT_CARD' || item.category === 'Vouchers';
  if (!isVoucher) return undefined;
  // FREE_AMOUNT = pointsCost 0 with a min/max bound; otherwise FIXED.
  if (item.pointsCost === 0 && (item.minRedemptionPoints != null || item.maxRedemptionPoints != null)) {
    return 'FREE_AMOUNT';
  }
  return 'FIXED';
}

function mapCatalogItem(item: ApiCatalogItem): CatalogueItem {
  const g = GRADIENT_POOL[hashIndex(item.id, GRADIENT_POOL.length)];
  const voucherType = inferVoucherType(item);
  const imageDataUrl = item.imageUrl ?? item.imageUrls?.[0] ?? null;
  return {
    id:           item.id,
    name:         item.name,
    brand:        item.brand ?? '',
    category:     item.category,
    categorySort: item.categorySort ?? null,
    points:       item.pointsCost,
    description:  item.description ?? '',
    details:      item.details ?? item.description ?? '',
    features:     item.features ?? [],
    emoji:        g.emoji,
    gradientFrom: g.from,
    gradientTo:   g.to,
    imageDataUrl,
    available:    item.available ?? true,
    popular:      item.popular ?? false,
    isAffordable: item.isAffordable ?? false,
    redemptionMode: item.redemptionMode ?? null,
    voucherType,
    fixedAmount:  item.fixedAmount ?? (voucherType === 'FIXED' ? item.pointsCost : undefined),
    minRedemptionPoints: item.minRedemptionPoints ?? null,
    maxRedemptionPoints: item.maxRedemptionPoints ?? null,
    slashPoints:  item.slashPoints ?? null,
    // DPDP consent gate — FAIL CLOSED for deliverable (physical) items: redeeming one
    // shares the member's delivery name/address/phone with a third-party fulfilment
    // partner, so an ABSENT/null flag must NOT silently drop the gate. A physical item
    // requires consent unless the BE explicitly sends requiresConsent:false (a Gifsy-/
    // platform-fulfilled item with no third party). Non-deliverable items (vouchers /
    // cash — no address is shared) keep the gate only when explicitly flagged true.
    requiresConsent: (item.redemptionMode ?? '') === 'PHYSICAL_GIFT'
      ? item.requiresConsent !== false
      : item.requiresConsent === true,
  };
}

/* ─── Helpers ─────────────────────────────────────────────────────────────── */

function deliveryLabel(category: string): string {
  return category === 'Vouchers' ? 'Instant via WhatsApp' : '5–7 business days';
}

function fmtInr(n: number) { return `₹${n.toLocaleString('en-IN')}`; }

/**
 * A FREE_AMOUNT (variable) item: pointsCost 0 with a redemption band (min and/or max set) —
 * the redeemer supplies a ₹ amount and points are computed at the tenant conversion rate.
 * Mirrors `inferVoucherType` (line ~134) and the backend predicate. Used purely to avoid
 * printing the raw `0` as "0 pts" (misleading for free-amount vouchers / cash). FIXED items
 * (pointsCost > 0) are never free-amount, so their display is untouched.
 */
function isFreeAmount(
  item: Pick<CatalogueItem, 'points' | 'minRedemptionPoints' | 'maxRedemptionPoints'>,
): boolean {
  return item.points === 0 && (item.minRedemptionPoints != null || item.maxRedemptionPoints != null);
}

type AffordabilityItem = Pick<CatalogueItem, 'points' | 'voucherType' | 'minRedemptionPoints'>;
/** Pass the LIVE rate (the page's `effectiveRate`), the same one the voucher sheet uses. */
type AffordabilitySettings = { minVoucherFreeAmount: number; pointsConversionRate: number };

/**
 * The ONE "points needed" rule for the rewards grid — used by the card dimming, the
 * "Need N more" badge AND the "Within my points" filter. Mirrors what the BACKEND enforces at
 * redeem time (api/src/rewards/rewards.service.ts, FREE_AMOUNT branch):
 *   FIXED / physical → item.points
 *   FREE_AMOUNT      → max(item.minRedemptionPoints ?? 0, Math.round(minVoucherFreeAmount × rate))
 *                      (Math.round, like the backend — not ceil; the tenant floor and the item
 *                      min both apply, so the larger wins. A rate of 0 collapses the floor to 0.)
 * Do NOT use the backend `isAffordable` flag: it is `balance >= pointsCost`, and FREE_AMOUNT
 * vouchers have pointsCost 0, so it reads "affordable" even when the minimum is out of reach.
 */
export function pointsRequired(item: AffordabilityItem, settings: AffordabilitySettings): number {
  if (item.voucherType !== 'FREE_AMOUNT') return item.points;
  const floorPoints = Math.round(settings.minVoucherFreeAmount * settings.pointsConversionRate);
  return Math.max(item.minRedemptionPoints ?? 0, floorPoints);
}

/** True when the partner's balance covers `pointsRequired` for this item. */
export function isWithinPoints(item: AffordabilityItem, balance: number, settings: AffordabilitySettings): boolean {
  return balance >= pointsRequired(item, settings);
}

/**
 * Catalogue MRP-slash (per-tenant `catalogueMrpSlash`): the struck-through "list price" in POINTS
 * to show above the redeem price. This is now computed SERVER-SIDE (rate-INDEPENDENT:
 * pointsCost × mrpPaise ÷ sellingValuePaise) and delivered on each catalogue item as `slashPoints`.
 * The FE no longer derives it from the conversion rate — that drifted whenever the tenant rate
 * changed after the item was priced. Here we only gate it behind the per-tenant flag.
 *
 * Returns the server `slashPoints` to DISPLAY, or null when the slash must NOT be shown:
 *   - the feature flag is OFF; OR
 *   - the server returned no honest slash (null — no selling value, inverted, or FREE_AMOUNT).
 */
function mrpSlashPoints(
  item: Pick<CatalogueItem, 'slashPoints'>,
  enabled: boolean,
): number | null {
  if (!enabled) return null;
  return item.slashPoints != null && item.slashPoints > 0 ? item.slashPoints : null;
}

/* ─── Real redeem flow (POST /api/rewards/redeem → OTP → confirm) ──────────────
   Shared by the gift + voucher sheets. Returns the message to surface, or null
   on success. The {success,data}/{success,error} envelope is unwrapped by the
   api-client, which lifts the backend's `error` string onto result.error for any
   non-2xx response (400 insufficient/out-of-range, 401 bad OTP, etc.). */

interface RedeemPayload {
  rewardId: string;
  quantity?: number;
  amount?: number;
  deliveryAddress?: {
    name: string; mobile: string; address: string;
    city: string; state: string; pincode: string;
  };
  /**
   * DPDP vendor-PII consent (design decision #15). Sent ONLY for vendor-sourced items
   * (item.requiresConsent === true), when the member has ticked the blocking consent
   * checkbox. The BE accepts a single `consent: boolean` flag and stamps its own
   * `vendorPiiConsentAt` + consent version server-side (demonstrable, versioned consent).
   */
  consent?: boolean;
}

/**
 * The consent wording the member agrees to. The FE only sends `consent: true`; the BE
 * stamps its own version server-side so stored consent is auditable against exactly what
 * was shown (owner/legal own the final wording; the platform records acceptance).
 */
export const VENDOR_PII_CONSENT_TEXT =
  'I agree that my name, delivery address, and phone number will be shared with the fulfilment partner to deliver this gift.';

/** True when redeeming this item requires the vendor-PII consent gate (decision #15). */
export function requiresVendorConsent(
  item: Pick<CatalogueItem, 'requiresConsent'>,
): boolean {
  return item.requiresConsent === true;
}

/* ─── Blocking vendor-PII consent checkbox ─────────────────────────────────────
   Default-unticked; redeem stays disabled until ticked. Rendered only for
   vendor-sourced items (requiresVendorConsent). */
function ConsentCheckbox({
  checked, onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2.5 p-3 rounded-xl border border-amber-200 bg-amber-50 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        data-testid="vendor-consent-checkbox"
        aria-label="Consent to share delivery details with the fulfilment partner"
        className="mt-0.5 w-4 h-4 accent-[var(--brand-primary)] shrink-0"
      />
      <span className="text-xs text-amber-900 leading-relaxed">{VENDOR_PII_CONSENT_TEXT}</span>
    </label>
  );
}

interface RedeemInitResult {
  orderId: string;
  orderNumber: string;
  requiredPoints: number;
  message: string;
}

/* ─── Image / emoji display ──────────────────────────────────────────────── */

interface GiftImageProps {
  gift: Pick<CatalogueItem, 'imageDataUrl' | 'emoji' | 'gradientFrom' | 'gradientTo'>;
  size: 'small' | 'large';
}

function GiftImage({ gift, size }: GiftImageProps) {
  const height    = size === 'large' ? 'h-64' : 'h-36';
  const padding   = size === 'large' ? 'p-4'  : 'p-3';
  const emojiSize = size === 'large' ? 'text-8xl' : 'text-5xl';
  if (gift.imageDataUrl) {
    return (
      <div className={`w-full ${height} flex items-center justify-center bg-white overflow-hidden`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={gift.imageDataUrl} alt="" className={`max-h-full max-w-full object-contain ${padding}`} />
      </div>
    );
  }
  return (
    <div className={`w-full ${height} flex items-center justify-center select-none`}
      style={{ background: `linear-gradient(135deg, ${gift.gradientFrom}25, ${gift.gradientTo}40)` }}>
      <span className={emojiSize}>{gift.emoji}</span>
    </div>
  );
}

/* ─── Physical gift detail + redeem sheet ───────────────────────────────── */

type RedemptionStep = 'detail' | 'form' | 'otp' | 'success';

const EMPTY_ADDRESS: AddressForm = { line1: '', city: '', state: '', pincode: '' };

function GiftDetailSheet({
  gift, onClose, myBalance, mobile, memberName, onWishlist, isWishlisted, onRedeemed,
  mrpSlashEnabled, deliveryDefaults,
}: {
  gift: CatalogueItem;
  onClose: () => void;
  myBalance: number;
  mobile: string;
  memberName: string;
  onWishlist: (id: string) => void;
  isWishlisted: boolean;
  onRedeemed: (pts: number) => void;
  /** Per-tenant catalogueMrpSlash flag — drives the struck-through MRP list price. */
  mrpSlashEnabled: boolean;
  /** The ACTIVE outlet's address on file (identity.deliveryDefaults) — pre-fills the delivery form. */
  deliveryDefaults: DeliveryDefaults | null;
}) {
  const toast = useToast();
  const [step,       setStep]       = useState<RedemptionStep>('detail');
  // Delivery address — pre-filled from the active outlet's address on file (PLATFORM-WIDE).
  // `typed` holds ONLY what the partner entered (+ `touched` marks every field they edited);
  // the shown address is DERIVED: applyAddressPrefill fills only empty, untouched fields, so a
  // late /partner/me never overwrites typing or a deliberate clear. No effect, no write-back.
  const [typed,      setTyped]      = useState<AddressForm>(EMPTY_ADDRESS);
  const [touched,    setTouched]    = useState<TouchedFields>({});
  const address = useMemo(
    () => applyAddressPrefill(typed, touched, deliveryDefaults),
    [typed, touched, deliveryDefaults],
  );
  // Hint only while at least one untouched field still holds its pre-filled value.
  const showPrefillHint = !!deliveryDefaults && (Object.keys(EMPTY_ADDRESS) as (keyof AddressForm)[]).some(
    (k) => !touched[k] && !!deliveryDefaults[k] && address[k] === deliveryDefaults[k],
  );
  // Recipient name for the parcel — seeded from the member's real name (never the gift
  // brand), editable so it can be corrected, but never left blank. If /api/auth/me
  // resolves AFTER this sheet opens, seed the (untouched) field once the name arrives.
  const [recipientName, setRecipientName] = useState(memberName);
  const [recipientTouched, setRecipientTouched] = useState(false);
  useEffect(() => {
    if (!recipientTouched && memberName) setRecipientName(memberName);
  }, [memberName, recipientTouched]);
  // Vendor-PII consent (decision #15) — default UNTICKED; blocks redeem for vendor items.
  const [consent,    setConsent]    = useState(false);
  const needConsent  = requiresVendorConsent(gift);
  const [otp,        setOtp]        = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [orderId,    setOrderId]    = useState<string | null>(null);
  const canAfford = myBalance >= gift.points;
  const delivery  = deliveryLabel(gift.category);
  const needMore  = !canAfford ? gift.points - myBalance : 0;
  // Struck-through MRP "list price" in points (per-tenant catalogueMrpSlash). Null ⇒ not shown.
  // Server-driven, rate-independent (gift.slashPoints); the flag only gates visibility.
  const mrpPoints = mrpSlashPoints(gift, mrpSlashEnabled);

  // Step 1: create the PENDING order + trigger OTP.
  const handleSendOtp = async () => {
    if (!recipientName.trim()) {
      toast.error('Please enter the recipient name'); return;
    }
    if (!address.line1 || !address.city || !address.pincode) {
      toast.error('Please fill in all required address fields'); return;
    }
    if (!/^\d{6}$/.test(address.pincode)) {
      toast.error('Enter a valid 6-digit pincode'); return;
    }
    // Vendor-PII consent is a hard gate for vendor-sourced items (decision #15).
    if (needConsent && !consent) {
      toast.error('Please agree to share your delivery details to continue'); return;
    }
    setSubmitting(true);
    const payload: RedeemPayload = {
      rewardId: gift.id,
      quantity: 1,
      deliveryAddress: {
        // The MEMBER's real name (so the vendor can address the parcel) — NEVER the gift
        // brand, which the consent text promises is not what gets shared.
        name:    recipientName.trim(),
        mobile,
        address: address.line1,
        city:    address.city,
        state:   address.state || address.city,
        pincode: address.pincode,
      },
      // Only attach consent for vendor items that actually require it — platform items
      // send nothing (no third party involved). The BE stamps the version server-side.
      ...(needConsent ? { consent: true } : {}),
    };
    const result = await api.post<RedeemInitResult>('/api/rewards/redeem', payload);
    setSubmitting(false);
    if (!result.success) {
      // 400 (insufficient / out of range), 404 etc. — surface the backend message.
      toast.error(result.error || 'Could not start redemption'); return;
    }
    setOrderId(result.data.orderId);
    setStep('otp');
  };

  // Step 2: confirm with the OTP — debits points server-side.
  const handleConfirm = async () => {
    if (otp.length < 6) { toast.error('Enter the OTP'); return; }
    if (!orderId) { toast.error('Redemption session expired, please retry'); return; }
    setSubmitting(true);
    const result = await api.post<{ orderId: string; status: string; message: string }>(
      '/api/rewards/redeem/confirm', { orderId, otp },
    );
    setSubmitting(false);
    if (!result.success) {
      // 401 bad/expired OTP, 400 not-confirmable, etc.
      toast.error(result.error || 'Could not confirm redemption'); return;
    }
    // Hubble auto-issuance (Bajaj GIFT_CARD) can resolve synchronously to FAILED — the
    // server has ALREADY refunded the points. Never show the success screen or decrement
    // the balance in that case. (Non-Hubble confirms return 'CONFIRMED' → unchanged.)
    if (result.data?.status === 'FAILED') {
      toast.error(result.data.message || 'We could not issue your voucher; your points have been refunded.');
      onClose();
      return;
    }
    onRedeemed(gift.points);
    setStep('success');
  };

  const title =
    step === 'form'    ? 'Delivery address'
    : step === 'otp'   ? 'Confirm redemption'
    : step === 'success' ? 'Redemption confirmed'
    : gift.name;

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={title}
      description={step === 'detail' ? `${gift.brand ? `${gift.brand} · ` : ''}${gift.category}` : undefined}
      className="max-w-md"
    >
      <div className="space-y-5">
        {step === 'detail' && (
          <>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="text-xs text-gray-400 font-medium">{gift.brand}</span>
                  <span className="text-gray-200">·</span>
                  <span className="text-xs text-gray-400">{gift.category}</span>
                  {gift.popular && <Badge variant="warning" className="text-[10px]">Popular</Badge>}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onWishlist(gift.id)}
                aria-label={isWishlisted ? 'Remove from wishlist' : 'Add to wishlist'}
                aria-pressed={isWishlisted}
                className="w-8 h-8 bg-black/5 hover:bg-black/10 rounded-full flex items-center justify-center transition-colors shrink-0"
              >
                <Heart className={`h-4 w-4 ${isWishlisted ? 'fill-red-500 text-red-500' : 'text-gray-500'}`} />
              </button>
            </div>
            <div className="-mx-6">
              <GiftImage gift={gift} size="large" />
            </div>
            <div className="flex items-center gap-3 p-3.5 bg-gray-50 rounded-2xl">
              <div className="flex-1">
                {mrpPoints != null && (
                  <p className="text-sm text-gray-400 line-through font-medium leading-none mb-0.5">
                    {formatPoints(mrpPoints)} pts
                  </p>
                )}
                <p className={`text-2xl font-bold ${canAfford ? 'text-[var(--brand-primary)]' : 'text-gray-400'}`}>
                  {formatPoints(gift.points)} pts
                </p>
                {!canAfford && <p className="text-xs text-red-500 mt-0.5 font-semibold">Need {formatPoints(needMore)} more pts</p>}
                {canAfford && <p className="text-xs text-emerald-600 mt-0.5 font-medium">{formatPoints(myBalance - gift.points)} pts remaining after</p>}
              </div>
              <div className="text-right">
                <div className="flex items-center gap-1 justify-end text-xs text-gray-500"><Truck className="h-3.5 w-3.5" />{delivery}</div>
                <p className="text-xs text-gray-400 mt-0.5">Free delivery</p>
              </div>
            </div>
            {gift.details && (
              <div><h3 className="text-sm font-semibold text-gray-900 mb-1.5">About this reward</h3><p className="text-sm text-gray-600 leading-relaxed">{gift.details}</p></div>
            )}
            {gift.features.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-gray-900 mb-2">Key features</h3>
                <ul className="space-y-1.5">
                  {gift.features.map((f, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-gray-600">
                      <Zap className="h-3.5 w-3.5 text-[var(--brand-primary)] shrink-0 mt-0.5" />{f}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="grid grid-cols-3 gap-2">
              {[{ icon: Shield, label: 'Genuine' }, { icon: Truck, label: 'Free delivery' }, { icon: Package, label: 'Easy returns' }].map(b => (
                <div key={b.label} className="flex flex-col items-center gap-1 p-2.5 bg-gray-50 rounded-xl">
                  <b.icon className="h-4 w-4 text-[var(--brand-primary)]" />
                  <span className="text-[10px] text-gray-500 text-center leading-tight">{b.label}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {step === 'form' && (
          <div className="space-y-4">
            <p className="text-xs text-gray-500">Enter who this is for and where to deliver it</p>
            {showPrefillHint && <p id="addr-prefill-hint" className="text-xs text-gray-500">From your outlet address</p>}
            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1" htmlFor="recipient-name">Recipient name *</label>
              <input
                id="recipient-name"
                className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
                placeholder="Full name for the parcel"
                value={recipientName}
                onChange={e => { setRecipientTouched(true); setRecipientName(e.target.value); }}
              />
            </div>
            {([
              { key: 'line1',   label: 'Street address *', placeholder: 'Shop no., street name' },
              { key: 'city',    label: 'City *',           placeholder: 'City' },
              { key: 'state',   label: 'State',            placeholder: 'State' },
              { key: 'pincode', label: 'Pincode *',        placeholder: '400001' },
            ] as { key: keyof AddressForm; label: string; placeholder: string }[]).map(f => (
              <div key={f.key}>
                <label className="text-xs font-medium text-gray-600 block mb-1" htmlFor={`addr-${f.key}`}>{f.label}</label>
                <input id={`addr-${f.key}`} aria-describedby={showPrefillHint ? 'addr-prefill-hint' : undefined} className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
                  placeholder={f.placeholder}
                  value={address[f.key]}
                  onChange={e => {
                    setTouched(prev => (prev[f.key] ? prev : { ...prev, [f.key]: true }));
                    setTyped(prev => ({ ...prev, [f.key]: e.target.value }));
                  }} />
              </div>
            ))}
            {needConsent && <ConsentCheckbox checked={consent} onChange={setConsent} />}
          </div>
        )}

        {step === 'otp' && (
          <div className="space-y-4">
            <div className="bg-gray-50 rounded-xl p-4 space-y-2">
              <div className="flex justify-between text-sm"><span className="text-gray-500">Item</span><span className="font-semibold">{gift.name}</span></div>
              <div className="flex justify-between text-sm"><span className="text-gray-500">Points</span><span className="font-semibold text-[var(--brand-primary)]">{formatPoints(gift.points)} pts</span></div>
              <div className="flex justify-between text-sm"><span className="text-gray-500">Deliver to</span><span className="font-medium text-right max-w-[180px]">{recipientName}</span></div>
              <div className="flex justify-between text-sm"><span className="text-gray-500">Address</span><span className="font-medium text-right max-w-[180px]">{address.line1}, {address.city}</span></div>
            </div>
            <p className="text-xs text-gray-500 flex items-center gap-1.5"><Phone className="h-3.5 w-3.5" /> OTP sent to your registered mobile</p>
            <input className="w-full border border-gray-200 rounded-xl px-3 py-3 text-center font-mono text-lg tracking-[0.4em] focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
              placeholder="· · · · · ·" maxLength={6} value={otp}
              onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric"
              aria-label="OTP" />
          </div>
        )}

        {step === 'success' && (
          <div className="flex flex-col items-center justify-center py-6 gap-4 text-center">
            <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center">
              <CheckCircle className="h-8 w-8 text-emerald-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500 mt-1">{gift.name} is on its way. {delivery}.</p>
              <p className="text-xs text-gray-400 mt-1">You will receive a WhatsApp confirmation shortly.</p>
            </div>
          </div>
        )}

        <div className="pt-3 border-t border-gray-100">
          {step === 'detail' && (
            <Button variant="primary" className="w-full" disabled={!canAfford || !gift.available}
              onClick={() => setStep('form')}>
              {!gift.available ? 'Out of Stock' : !canAfford ? `Need ${formatPoints(needMore)} more pts` : 'Redeem Now'}
            </Button>
          )}
          {step === 'form' && (
            <div className="flex gap-3">
              <Button variant="outline" className="flex-1" onClick={() => setStep('detail')}>← Back</Button>
              <Button
                variant="primary"
                className="flex-1"
                loading={submitting}
                disabled={needConsent && !consent}
                onClick={handleSendOtp}
              >
                Send OTP
              </Button>
            </div>
          )}
          {step === 'otp' && (
            <div className="flex gap-3">
              <Button variant="outline" className="flex-1" onClick={() => setStep('form')}>← Back</Button>
              <Button variant="primary" className="flex-1" loading={submitting} disabled={otp.length < 6} onClick={handleConfirm}>Confirm</Button>
            </div>
          )}
          {step === 'success' && (
            <Button variant="primary" className="w-full" onClick={onClose}>Done</Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/* ─── Voucher redeem sheet (FIXED + FREE_AMOUNT) ──────────────────────────── */

function VoucherRedeemSheet({
  voucher, onClose, myBalance, minFreeAmount, conversionRate, onRedeemed,
}: {
  voucher: CatalogueItem;
  onClose: () => void;
  myBalance: number;
  minFreeAmount: number;
  conversionRate: number;
  onRedeemed: (pts: number) => void;
}) {
  const toast = useToast();
  const [amount,     setAmount]     = useState('');
  const [otp,        setOtp]        = useState('');
  const [otpSent,    setOtpSent]    = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [success,    setSuccess]    = useState(false);
  const [orderId,    setOrderId]    = useState<string | null>(null);
  // Vendor-PII consent (decision #15) — default UNTICKED; blocks redeem for vendor items.
  const [consent,    setConsent]    = useState(false);
  const needConsent = requiresVendorConsent(voucher);

  const isFixed   = voucher.voucherType === 'FIXED';
  const fixedPts  = isFixed ? voucher.points : 0;
  const freeAmt   = parseInt(amount, 10) || 0;
  // FREE_AMOUNT: points required = ₹amount × conversionRate (server re-validates vs min/max).
  const ptsNeeded = isFixed ? fixedPts : Math.ceil(freeAmt * conversionRate);
  const canAfford = myBalance >= ptsNeeded && (isFixed || freeAmt >= minFreeAmount);

  // Client-side UX validation for FREE_AMOUNT (server is authoritative).
  // Guard against a zero/invalid conversionRate so we never divide by zero
  // (which would yield Infinity/NaN in the balance hint). null => unknown cap.
  const hasRate = Number.isFinite(conversionRate) && conversionRate > 0;
  const maxAffordableInr = hasRate ? Math.floor(myBalance / conversionRate) : null;
  const amountError = !isFixed && freeAmt > 0 && freeAmt < minFreeAmount
    ? `Minimum redemption is ${fmtInr(minFreeAmount)}`
    : !isFixed && maxAffordableInr !== null && freeAmt > maxAffordableInr
    ? `Exceeds your balance (max ${fmtInr(maxAffordableInr)})`
    : '';

  // Step 1: create the order + trigger OTP. FREE_AMOUNT sends `amount`.
  const handleSendOtp = async () => {
    // Vendor-PII consent is a hard gate for vendor-sourced items (decision #15).
    if (needConsent && !consent) {
      toast.error('Please agree to share your delivery details to continue'); return;
    }
    setSubmitting(true);
    const consentFields = needConsent ? { consent: true } : {};
    const payload: RedeemPayload = isFixed
      ? { rewardId: voucher.id, quantity: 1, ...consentFields }
      : { rewardId: voucher.id, amount: freeAmt, ...consentFields };
    const result = await api.post<RedeemInitResult>('/api/rewards/redeem', payload);
    setSubmitting(false);
    if (!result.success) {
      toast.error(result.error || 'Could not start redemption'); return;
    }
    setOrderId(result.data.orderId);
    setOtpSent(true);
  };

  // Step 2: confirm with OTP.
  const handleConfirm = async () => {
    if (otp.length < 6) { toast.error('Enter the OTP'); return; }
    if (!orderId) { toast.error('Redemption session expired, please retry'); return; }
    setSubmitting(true);
    const result = await api.post<{ orderId: string; status: string; message: string }>(
      '/api/rewards/redeem/confirm', { orderId, otp },
    );
    setSubmitting(false);
    if (!result.success) {
      toast.error(result.error || 'Could not confirm redemption'); return;
    }
    // Hubble auto-issuance (Bajaj GIFT_CARD) can resolve synchronously to FAILED — the
    // server has ALREADY refunded the points. Never show the success screen or decrement
    // the balance in that case. (Non-Hubble confirms return 'CONFIRMED' → unchanged.)
    if (result.data?.status === 'FAILED') {
      toast.error(result.data.message || 'We could not issue your voucher; your points have been refunded.');
      onClose();
      return;
    }
    onRedeemed(ptsNeeded);
    setSuccess(true);
  };

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={success ? 'Voucher confirmed' : 'Redeem voucher'}
      description={success ? undefined : `${voucher.brand} voucher`}
      className="max-w-md"
    >
      {success ? (
        <div className="flex flex-col items-center gap-4 text-center py-4">
          <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center">
            <CheckCircle className="h-8 w-8 text-emerald-600" />
          </div>
          <div>
            <p className="text-sm text-gray-500 mt-1">
              {isFixed ? `${voucher.brand} voucher (${fmtInr(fixedPts)})` : `${voucher.brand} voucher (${fmtInr(freeAmt)})`} is being processed. Your voucher code will appear under Orders.
            </p>
            <p className="text-xs text-gray-400 mt-1">{ptsNeeded} pts deducted from your balance.</p>
          </div>
          <Button variant="primary" className="w-full" onClick={onClose}>Done</Button>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Voucher header */}
          <div className="flex items-center gap-3">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center text-3xl"
              style={{ background: `linear-gradient(135deg, ${voucher.gradientFrom}25, ${voucher.gradientTo}40)` }}>
              {voucher.emoji}
            </div>
            <div>
              <p className="text-xs text-gray-400">{voucher.brand}</p>
              <h3 className="text-base font-bold text-gray-900">{isFixed ? `${fmtInr(fixedPts)} Voucher` : 'Voucher — Any Amount'}</h3>
              <p className="text-xs text-gray-500">{voucher.description}</p>
            </div>
          </div>

          {/* Balance display */}
          <div className="bg-emerald-50 border border-emerald-100 rounded-xl px-4 py-3 flex items-center justify-between">
            <p className="text-xs text-emerald-700 font-medium">Your balance</p>
            <p className="text-base font-bold text-emerald-700">{formatPoints(myBalance)} pts = {maxAffordableInr !== null ? fmtInr(maxAffordableInr) : '—'}</p>
          </div>

          {/* Fixed: show points cost */}
          {isFixed && (
            <div className="bg-gray-50 rounded-xl px-4 py-3 flex items-center justify-between">
              <p className="text-sm text-gray-600">Points required</p>
              <p className={`text-lg font-bold ${myBalance >= fixedPts ? 'text-[var(--brand-primary)]' : 'text-red-500'}`}>
                {formatPoints(fixedPts)} pts
              </p>
            </div>
          )}

          {/* Free amount: input */}
          {!isFixed && (
            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1">
                Amount to redeem * <span className="text-gray-400 font-normal">(min {fmtInr(minFreeAmount)})</span>
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-gray-500">₹</span>
                <input
                  className={cn(
                    'w-full border rounded-xl pl-7 pr-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]',
                    amountError ? 'border-red-300' : 'border-gray-200',
                  )}
                  placeholder={`${minFreeAmount}`}
                  value={amount}
                  onChange={e => setAmount(e.target.value.replace(/\D/g, ''))}
                  inputMode="numeric"
                  aria-label="Voucher amount"
                />
              </div>
              {amountError && <p className="text-xs text-red-500 mt-1 flex items-center gap-1"><AlertCircle className="h-3 w-3" />{amountError}</p>}
              {freeAmt >= minFreeAmount && !amountError && (
                <p className="text-xs text-emerald-600 mt-1 font-medium">
                  = {ptsNeeded} pts · {formatPoints(myBalance - ptsNeeded)} pts remaining after
                </p>
              )}
            </div>
          )}

          {/* Vendor-PII consent (before OTP is requested) */}
          {!otpSent && needConsent && <ConsentCheckbox checked={consent} onChange={setConsent} />}

          {/* OTP field */}
          {otpSent && (
            <div className="space-y-2">
              <p className="text-xs text-gray-500 flex items-center gap-1"><Phone className="h-3.5 w-3.5" /> OTP sent to your registered mobile</p>
              <input
                className="w-full border border-gray-200 rounded-xl px-3 py-3 text-center font-mono text-lg tracking-[0.4em] focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20"
                placeholder="· · · · · ·" maxLength={6} value={otp}
                onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric"
                aria-label="OTP" />
            </div>
          )}

          <div className="pt-3 border-t border-gray-100">
            {!otpSent ? (
              <Button variant="primary" className="w-full" loading={submitting}
                disabled={!canAfford || !!amountError || (!isFixed && freeAmt < minFreeAmount) || (needConsent && !consent)}
                onClick={handleSendOtp}>
                {!isFixed && freeAmt > 0 && freeAmt < minFreeAmount
                  ? `Min ${fmtInr(minFreeAmount)} required`
                  : myBalance < ptsNeeded
                  ? 'Insufficient balance'
                  : 'Send OTP'}
              </Button>
            ) : (
              <div className="flex gap-3">
                <Button variant="outline" className="flex-1" onClick={() => setOtpSent(false)}>← Back</Button>
                <Button variant="primary" className="flex-1" loading={submitting} disabled={otp.length < 6} onClick={handleConfirm}>Confirm</Button>
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ─── Cash Payout sheet (points → INR via UPI / Bank Transfer) ─────────────────
   ONE unified cash flow. The partner enters a free-amount ₹ figure; the points
   debit is created via the same redeem endpoint as { rewardId, amount }. The
   beneficiary (bank and/or UPI) is the partner's REAL on-file KYC detail, sourced
   from GET /api/auth/me — never a hardcoded literal. The ₹-min is derived from
   the cash catalog item's minRedemptionPoints using the real conversionRate. */

function CashPayoutSheet({
  onClose, myBalance, minPoints, conversionRate, beneficiary, rewardId, onRedeemed,
}: {
  onClose: () => void;
  myBalance: number;
  minPoints: number;
  conversionRate: number;
  beneficiary: CashBeneficiary;
  rewardId: string | null;
  onRedeemed: (pts: number) => void;
}) {
  const toast = useToast();
  const [amount,     setAmount]     = useState('');
  const [otp,        setOtp]        = useState('');
  const [otpSent,    setOtpSent]    = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [success,    setSuccess]    = useState(false);
  const [orderId,    setOrderId]    = useState<string | null>(null);

  // Guard against a zero/invalid conversionRate to avoid dividing by zero.
  const hasRate   = Number.isFinite(conversionRate) && conversionRate > 0;
  // ₹min = minRedemptionPoints / conversionRate (the cash item's minimum, in ₹).
  const minInr    = hasRate ? Math.ceil(minPoints / conversionRate) : 0;
  const maxInr    = hasRate ? Math.floor(myBalance / conversionRate) : null;

  const inrAmt    = parseInt(amount, 10) || 0;
  // Preview points with the REAL conversionRate (matches the backend), not localStorage.
  const ptsNeeded = Math.ceil(inrAmt * conversionRate);

  const amountError = inrAmt > 0 && inrAmt < minInr
    ? `Minimum redemption is ${fmtInr(minInr)}`
    : maxInr !== null && inrAmt > maxInr
    ? `Exceeds balance (max ${fmtInr(maxInr)})`
    : '';

  const canProceed = inrAmt >= minInr && !amountError && myBalance >= ptsNeeded;

  const handleSendOtp = async () => {
    if (!rewardId) { toast.error('Cash payout is not available right now'); return; }
    setSubmitting(true);
    const result = await api.post<RedeemInitResult>('/api/rewards/redeem', { rewardId, amount: inrAmt });
    setSubmitting(false);
    if (!result.success) { toast.error(result.error || 'Could not start payout'); return; }
    setOrderId(result.data.orderId);
    setOtpSent(true);
  };

  const handleConfirm = async () => {
    if (otp.length < 6) { toast.error('Enter the OTP'); return; }
    if (!orderId) { toast.error('Payout session expired, please retry'); return; }
    setSubmitting(true);
    const result = await api.post<{ orderId: string; status: string; message: string }>(
      '/api/rewards/redeem/confirm', { orderId, otp },
    );
    setSubmitting(false);
    if (!result.success) { toast.error(result.error || 'Could not confirm payout'); return; }
    onRedeemed(ptsNeeded);
    setSuccess(true);
  };

  // The destination summary for the success screen — UPI preferred, else bank.
  const payoutTarget = beneficiary.upiId
    ? beneficiary.upiId
    : beneficiary.bankName
    ? `${beneficiary.bankName} (${maskAccountNumber(beneficiary.bankAccountNumber ?? '')})`
    : 'your registered account';

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={success ? 'Payout initiated' : 'Cash payout'}
      description={success ? undefined : 'Redeem points to your registered account'}
      className="max-w-md"
    >
      {success ? (
        <div className="flex flex-col items-center gap-4 text-center py-4">
          <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center">
            <CheckCircle className="h-8 w-8 text-emerald-600" />
          </div>
          <div>
            <p className="text-sm text-gray-500 mt-1">
              {fmtInr(inrAmt)} will be paid to {payoutTarget} within 2–3 working days.
            </p>
            <p className="text-xs text-gray-400 mt-1">{ptsNeeded} pts deducted. You will receive a WhatsApp confirmation once paid.</p>
          </div>
          <Button variant="primary" className="w-full" onClick={onClose}>Done</Button>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Beneficiary on file — REAL details (bank and/or UPI). */}
          <div className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 space-y-1.5">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Pay to</p>
            {beneficiary.upiId && (
              <p className="text-sm font-semibold text-gray-900" data-testid="cash-upi">UPI · {beneficiary.upiId}</p>
            )}
            {beneficiary.bankAccountNumber && beneficiary.ifscCode && (
              <div data-testid="cash-bank">
                <p className="text-sm font-semibold text-gray-900">{beneficiary.bankName ?? 'Bank account'}</p>
                <p className="text-xs text-gray-500 font-mono">
                  {maskAccountNumber(beneficiary.bankAccountNumber)} · {beneficiary.ifscCode}
                </p>
                {beneficiary.bankAccountHolder && (
                  <p className="text-[11px] text-gray-400">{beneficiary.bankAccountHolder}</p>
                )}
              </div>
            )}
          </div>

          {/* Balance */}
          <div className="bg-emerald-50 border border-emerald-100 rounded-xl px-4 py-3 flex items-center justify-between">
            <p className="text-xs text-emerald-700 font-medium">Available balance</p>
            <p className="text-base font-bold text-emerald-700">{formatPoints(myBalance)} pts = {maxInr !== null ? fmtInr(maxInr) : '—'}</p>
          </div>

          {/* Amount input (free-amount) */}
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">
              Amount to redeem * <span className="text-gray-400 font-normal">(min {fmtInr(minInr)}, max {maxInr !== null ? fmtInr(maxInr) : '—'})</span>
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-gray-500">₹</span>
              <input
                className={cn('w-full border rounded-xl pl-7 pr-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]',
                  amountError ? 'border-red-300' : 'border-gray-200')}
                placeholder={`${minInr}`}
                value={amount}
                onChange={e => setAmount(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                aria-label="Payout amount"
              />
            </div>
            {amountError && <p className="text-xs text-red-500 mt-1 flex items-center gap-1"><AlertCircle className="h-3 w-3" />{amountError}</p>}
            {inrAmt >= minInr && !amountError && (
              <p className="text-xs text-emerald-600 mt-1 font-medium">
                = {ptsNeeded} pts · {formatPoints(myBalance - ptsNeeded)} pts remaining after
              </p>
            )}
          </div>

          {/* OTP field */}
          {otpSent && (
            <div className="space-y-2">
              <p className="text-xs text-gray-500 flex items-center gap-1"><Phone className="h-3.5 w-3.5" /> OTP sent to your registered mobile</p>
              <input className="w-full border border-gray-200 rounded-xl px-3 py-3 text-center font-mono text-lg tracking-[0.4em] focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20"
                placeholder="· · · · · ·" maxLength={6} value={otp}
                onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric"
                aria-label="OTP" />
            </div>
          )}

          <div className="pt-3 border-t border-gray-100">
            {!otpSent ? (
              <Button variant="primary" className="w-full" loading={submitting} disabled={!canProceed} onClick={handleSendOtp}>
                {!canProceed && inrAmt > 0 ? amountError || 'Insufficient balance' : `Redeem ${inrAmt ? fmtInr(inrAmt) : ''}`}
              </Button>
            ) : (
              <div className="flex gap-3">
                <Button variant="outline" className="flex-1" onClick={() => setOtpSent(false)}>← Back</Button>
                <Button variant="primary" className="flex-1" loading={submitting} disabled={otp.length < 6} onClick={handleConfirm}>Confirm</Button>
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ─── Inline payout-details capture sheet (feature `captureBankAtRedemption`) ───
   Replaces the Cash-Payout dead-end for a wholesaler with no beneficiary on file
   (or whose details are NEEDS_RECAPTURE after a failed payout). Reuses the SAME
   capture component + rules as KYC (BankOrUpiSection + lib/payment-type) rather
   than reinventing: bank↔UPI toggle gated by the tenant `salesApp.upiEnabled` and
   the outlet's payout MANDATE (requiredPaymentType → pinnedPaymentMode); UPI is
   QR-scan-only; a cancelled cheque is REQUIRED in bank mode and HIDDEN in UPI mode.

   Write-before-confirm: on submit the details persist to the ChannelPartner
   (UNVERIFIED) via POST /api/partner/payout-details, then the parent re-fetches
   /api/auth/me so `partnerHasBeneficiary` flips true and the partner proceeds into
   the EXISTING CashPayoutSheet (amount → OTP → confirm), which is unchanged.

   Both POSTs are same-origin, so the edge proxy injects `x-active-partner-id` from
   the httpOnly `active_partner_id` cookie exactly as the redeem calls on this page
   do (the FE never sets that header — the proxy strips any inbound value). */
function PayoutCaptureSheet({
  requiredPaymentType,
  onCaptured,
}: {
  /** The active outlet's payout mandate (BANK/UPI/ANY). Absent ⇒ 'ANY' (partner chooses). */
  requiredPaymentType: OutletPaymentType;
  /** Called after a successful save — the parent re-fetches /api/auth/me to refresh the beneficiary. */
  onCaptured: () => void | Promise<void>;
}) {
  // Tenant UPI gate — same source BankOrUpiSection reads. UPI off ⇒ bank-only.
  const upiEnabled = getGifsySettings().salesApp?.upiEnabled === true;
  // The one mode the outlet mandate PINS (rep/partner can't change), or undefined when free.
  const lockedMode = pinnedPaymentMode(requiredPaymentType, upiEnabled) ?? undefined;

  const [paymentMode,       setPaymentMode]       = useState<PaymentMode>(lockedMode ?? 'bank');
  const [bankName,          setBankName]          = useState('');
  const [accountHolderName, setAccountHolderName] = useState('');
  const [accountNumber,     setAccountNumber]     = useState('');
  const [ifscCode,          setIfscCode]          = useState('');
  const [upiId,             setUpiId]             = useState('');
  const [chequeFile,        setChequeFile]        = useState<File | null>(null);
  const [chequeFileKey,     setChequeFileKey]     = useState<string | null>(null);
  const [uploadingCheque,   setUploadingCheque]   = useState(false);
  const [submitting,        setSubmitting]        = useState(false);
  const [error,             setError]             = useState('');
  const chequeInputRef = useRef<HTMLInputElement>(null);

  // Effective mode mirrors BankOrUpiSection: a mandate pin wins; else tenant-gated bank/upi.
  const effectiveMode: PaymentMode = lockedMode ?? (upiEnabled ? paymentMode : 'bank');

  const onFieldChange =
    (field: 'bankName' | 'accountHolderName' | 'accountNumber' | 'ifscCode') =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      // Uppercase-normalize IFSC as typed (mirrors the KYC wizard) so the submitted value
      // matches what uniqueness/validation see on the backend.
      const v = field === 'ifscCode' ? e.target.value.toUpperCase() : e.target.value;
      if (field === 'bankName')          setBankName(v);
      else if (field === 'accountHolderName') setAccountHolderName(v);
      else if (field === 'accountNumber')     setAccountNumber(v);
      else                                     setIfscCode(v);
    };

  // Cheque upload — POST /api/partner/documents (multipart `file` + documentType), returns
  // {fileKey,fileUrl}. Raw fetch (NOT api.post) so the browser sets the multipart boundary;
  // same-origin ⇒ the proxy injects x-active-partner-id from the cookie.
  const handleChequeSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setChequeFile(file);
    setChequeFileKey(null);
    setUploadingCheque(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', file, file.name);
      fd.append('documentType', 'CANCELLED_CHEQUE');
      const res = await fetch('/api/partner/documents', { method: 'POST', body: fd });
      const body = await res.json().catch(() => ({} as Record<string, unknown>));
      // Tolerate both the {success,data:{…}} envelope and a bare {fileKey,fileUrl} body.
      const data = ((body as { data?: unknown }).data ?? body) as { fileKey?: string };
      if (!res.ok || (body as { success?: boolean }).success === false || !data?.fileKey) {
        const msg = (body as { error?: string; message?: string }).error
          ?? (body as { message?: string }).message
          ?? 'Could not upload the cheque — please try again';
        throw new Error(msg);
      }
      setChequeFileKey(data.fileKey);
    } catch (err) {
      setChequeFile(null);
      setError(err instanceof Error ? err.message : 'Could not upload the cheque — please try again');
    } finally {
      setUploadingCheque(false);
    }
  };

  const clearCheque = () => {
    setChequeFile(null);
    setChequeFileKey(null);
    if (chequeInputRef.current) chequeInputRef.current.value = '';
  };

  const handleSubmit = async () => {
    setError('');
    if (effectiveMode === 'bank') {
      if (!bankName.trim() || !accountHolderName.trim() || !accountNumber.trim() || !ifscCode.trim()) {
        setError('Please fill in all bank fields'); return;
      }
      if (!chequeFileKey) {
        setError('Please upload a cancelled cheque'); return;
      }
    } else if (!upiId) {
      setError('Please scan your UPI QR code to continue'); return;
    }

    setSubmitting(true);
    const payload =
      effectiveMode === 'bank'
        ? {
            paymentMode: 'bank' as const,
            bankName:          bankName.trim(),
            accountHolderName: accountHolderName.trim(),
            accountNumber:     accountNumber.trim(),
            ifscCode:          ifscCode.trim(),
            chequeFileKey,
          }
        : { paymentMode: 'upi' as const, upiId };
    const result = await api.post('/api/partner/payout-details', payload);
    setSubmitting(false);
    if (!result.success) {
      // Surface the backend message inline (missing field, or a uniqueness collision like
      // "This bank account is already registered to another outlet…").
      setError(result.error || 'Could not save your payout details — please try again');
      return;
    }
    await onCaptured();
  };

  return (
    <div
      data-testid="payout-capture-sheet"
      className="bg-white border border-gray-200 rounded-xl px-4 py-4 space-y-4"
    >
      <div>
        <p className="text-sm font-semibold text-gray-900">Add payout details</p>
        <p className="text-xs text-gray-500 mt-0.5">
          Enter where you&apos;d like your cash payout sent. We&apos;ll use these the same way your KYC
          bank/UPI details are used.
        </p>
      </div>

      <BankOrUpiSection
        paymentMode={paymentMode}
        onPaymentModeChange={setPaymentMode}
        lockedMode={lockedMode}
        bankName={bankName}
        accountHolderName={accountHolderName}
        accountNumber={accountNumber}
        ifscCode={ifscCode}
        onFieldChange={onFieldChange}
        upiId={upiId}
        onUpiChange={setUpiId}
      >
        {/* Cancelled-cheque upload — rendered only in bank mode (BankOrUpiSection gates children
            to bank mode, mirroring KYC). File-picker (camera-or-gallery), NOT a forced live camera. */}
        <div>
          <label className="text-xs font-medium text-gray-600 block mb-1">
            Cancelled Cheque <span className="text-[var(--brand-primary)]">*</span>
          </label>
          <input
            ref={chequeInputRef}
            data-testid="payout-cheque-input"
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            onChange={handleChequeSelect}
          />
          {chequeFile && chequeFileKey ? (
            <div className="flex items-center gap-3 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5">
              <FileText className="h-4 w-4 text-gray-500 shrink-0" />
              <p className="flex-1 min-w-0 text-xs text-gray-700 truncate">{chequeFile.name}</p>
              <button
                type="button"
                onClick={clearCheque}
                className="shrink-0 p-1 rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                title="Remove and re-upload"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => chequeInputRef.current?.click()}
              disabled={uploadingCheque}
              className="w-full border-2 border-dashed border-gray-200 rounded-xl px-3 py-3 flex items-center justify-center gap-2 text-sm font-medium text-gray-500 hover:bg-gray-50 active:scale-[0.99] transition disabled:opacity-50"
            >
              {uploadingCheque ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Uploading…
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4" /> Upload cancelled cheque
                </>
              )}
            </button>
          )}
          <p className="text-[11px] text-gray-400 mt-1">
            PDF or image · Max 5 MB. Used to verify your bank account before payout.
          </p>
        </div>
      </BankOrUpiSection>

      {error && (
        <p data-testid="payout-capture-error" className="text-xs text-red-600 flex items-start gap-1.5">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          {error}
        </p>
      )}

      <Button
        variant="primary"
        className="w-full"
        data-testid="payout-capture-submit"
        loading={submitting}
        disabled={uploadingCheque}
        onClick={handleSubmit}
      >
        Save &amp; continue
      </Button>
    </div>
  );
}

/* ─── Main Page ───────────────────────────────────────────────────────────── */

type MainTab = 'catalogue' | 'vouchers' | 'bank';

export default function RewardsPage() {
  const router   = useRouter();
  const identity = usePartnerIdentity(); // REAL points-presence signal (replaces demo track)
  const [gifts,     setGifts]     = useState<CatalogueItem[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [tab,       setTab]       = useState<MainTab>('catalogue');
  const [category,  setCategory]  = useState('All');
  const [search,    setSearch]    = useState('');
  const [wishlist,  setWishlist]  = useState<Set<string>>(new Set());
  // Persistent-wishlist UI: the ♥ Wishlist filter (catalogue tab only), toggled by the header pill.
  const [wishlistFilter, setWishlistFilter] = useState(false);
  // "Within my points" affordability filter (Physical + Vouchers). Shared across both tabs on
  // purpose — a partner who turned it on keeps it on when switching tab.
  const [withinPointsOnly, setWithinPointsOnly] = useState(false);
  // Per-id in-flight guard so a rapid double-tap on a heart can't fire two
  // conflicting POST/DELETE requests for the same reward (optimistic race).
  const wishlistInFlight = useRef<Set<string>>(new Set());
  const toast = useToast();
  const [detail,    setDetail]    = useState<CatalogueItem | null>(null);
  const [voucherDetail, setVoucherDetail] = useState<CatalogueItem | null>(null);
  const [showBank,  setShowBank]  = useState(false);
  const [balance,   setBalance]   = useState(0);
  // Real cash beneficiary + conversionRate + partner mobile from /api/auth/me (source of
  // truth for the cash-payout / delivery flow). Null until loaded / when the partner has no rails.
  const [beneficiary,    setBeneficiary]    = useState<CashBeneficiary | null>(null);
  const [conversionRate, setConversionRate] = useState<number | null>(null);
  const [mobile,         setMobile]         = useState('');
  // The member's real name (from /api/auth/me) — seeds the physical-gift "Recipient name"
  // so the vendor can address the parcel (never the gift brand). See GiftDetailSheet.
  const [memberName,     setMemberName]     = useState('');
  // Payout-details status (captureBankAtRedemption). VERIFIED (default) / UNVERIFIED /
  // NEEDS_RECAPTURE — NEEDS_RECAPTURE re-prompts the capture sheet even when stale beneficiary
  // fields exist. Null until /api/auth/me resolves (absent ⇒ treated as not NEEDS_RECAPTURE).
  const [paymentDetailsStatus, setPaymentDetailsStatus] = useState<string | null>(null);
  // The active outlet's payout MANDATE (requiredPaymentType). Honored by the capture sheet via
  // pinnedPaymentMode (same as sales/kyc/new). Absent on the payload ⇒ 'ANY' (partner chooses,
  // subject to the tenant UPI gate); the backend re-validates the chosen mode regardless.
  const [requiredPaymentType, setRequiredPaymentType] = useState<OutletPaymentType>('ANY');
  const settings = getGifsySettings();
  // Per-tenant catalogueMrpSlash flag (DB-backed, authenticated) — drives the struck-through MRP
  // "list price". Defaults OFF while loading / for every tenant not opted-in (Deoleo stays OFF →
  // byte-identical). Same hook the sales dashboard uses for rlpBscView (there with /api/sales/me).
  const { features: tenantFeatures } = useTenantFeatures('/api/partner/me');

  // Real beneficiary + conversionRate + payout status for the cash-payout flow, from
  // /api/auth/me. No hardcoded bank/UPI literals — these come straight from the KYC record.
  // Extracted so the inline payout-capture sheet can RE-FETCH after a successful save (so
  // `partnerHasBeneficiary` flips true and the partner proceeds into the existing CashPayoutSheet).
  const refreshBeneficiary = useCallback(async () => {
    const result = await api.get<{
      conversionRate?: number;
      user?: {
        name?: string | null;
        phone?: string | null;
        channelPartner?: {
          bankName?: string | null;
          bankAccountNumber?: string | null;
          bankAccountHolder?: string | null;
          ifscCode?: string | null;
          upiId?: string | null;
          paymentMode?: string | null;
          // captureBankAtRedemption additions on the channelPartner payload.
          paymentDetailsStatus?: string | null;
          requiredPaymentType?: OutletPaymentType | null;
        } | null;
      };
    }>('/api/auth/me');
    if (!result.success || !result.data) return;
    const cp = result.data.user?.channelPartner;
    // Real registered mobile (for the physical-gift delivery address) — no demo literal.
    if (result.data.user?.phone) setMobile(result.data.user.phone);
    // Real member name — seeds the editable "Recipient name" on the delivery form.
    if (result.data.user?.name) setMemberName(result.data.user.name);
    if (cp) {
      setBeneficiary({
        bankName:          cp.bankName ?? null,
        bankAccountNumber: cp.bankAccountNumber ?? null,
        bankAccountHolder: cp.bankAccountHolder ?? null,
        ifscCode:          cp.ifscCode ?? null,
        upiId:             cp.upiId ?? null,
        paymentMode:       cp.paymentMode ?? null,
      });
      setPaymentDetailsStatus(cp.paymentDetailsStatus ?? null);
      if (cp.requiredPaymentType) setRequiredPaymentType(cp.requiredPaymentType);
    }
    if (typeof result.data.conversionRate === 'number') {
      setConversionRate(result.data.conversionRate);
    }
  }, []);

  useEffect(() => {
    // Live catalogue only — no localStorage / GIFT_CATALOGUE fallback.
    api.get<{
      items: ApiCatalogItem[];
      userBalance?: number;
    }>('/api/rewards/catalog')
      .then((result) => {
        if (result.success && result.data) {
          const { items, userBalance } = result.data;
          if (userBalance !== undefined) setBalance(userBalance);
          setGifts((items ?? []).map(mapCatalogItem));
        }
        // On failure we simply show an empty catalogue (EmptyState) — no demo data.
      })
      .finally(() => setLoading(false));

    // Seed the persistent wishlist (backend source of truth). Failure → empty Set,
    // no crash: the hearts simply render un-filled until the next successful toggle.
    api.get<{ items: unknown[]; rewardIds: string[] }>('/api/rewards/wishlist')
      .then((result) => {
        if (result.success && Array.isArray(result.data?.rewardIds)) {
          setWishlist(new Set(result.data.rewardIds));
        }
      });

    // Failure simply leaves beneficiary null → the cash tab shows the KYC empty-state.
    void refreshBeneficiary();
  }, [refreshBeneficiary]);

  // NOTE: the loyalty-OFF gate (the "Rewards not available" wall) is applied AFTER all
  // hooks below, next to the loading-spinner return — returning early HERE would skip the
  // useMemo hooks that follow and trip React's rules-of-hooks (fewer hooks on the gated
  // render than on the loading render → runtime crash / error boundary).

  // Bucket by redemption mode to match the admin's definition (admin/gifts:
  // VOUCHER_LIKE = {'GIFT_CARD'}). The reward's category label ("Gift Vouchers"
  // etc.) is tenant-authored and unreliable for tab routing; redemptionMode is
  // the canonical signal. Cash modes (UPI / BANK_TRANSFER) belong to the Bank
  // Transfer tab (see cashItem) and must NOT leak into the Physical grid.
  const voucherItems  = useMemo(() => gifts.filter(g => g.redemptionMode === 'GIFT_CARD'), [gifts]);
  const physicalItems = useMemo(() => gifts.filter(g => g.redemptionMode === 'PHYSICAL_GIFT'), [gifts]);

  // Resolve the cash payout catalog item deterministically: among the cash-mode
  // items (UPI / BANK_TRANSFER), prefer a FREE_AMOUNT one (pointsCost 0 with a
  // minRedemptionPoints), else the first cash item by id for stable ordering.
  const cashItem = useMemo(() => {
    const cash = gifts
      .filter(g => g.redemptionMode === 'UPI' || g.redemptionMode === 'BANK_TRANSFER')
      .sort((a, b) => a.id.localeCompare(b.id));
    const freeAmount = cash.find(
      g => g.points === 0 && (g.minRedemptionPoints ?? 0) >= 1,
    );
    return freeAmount ?? cash[0] ?? null;
  }, [gifts]);

  // Effective conversionRate — REAL /me value, with a safe fallback while loading
  // or if the server sends a zero/invalid rate (never divide by zero downstream).
  const effectiveRate = (conversionRate != null && Number.isFinite(conversionRate) && conversionRate > 0)
    ? conversionRate
    : settings.pointsConversionRate;
  // The cash item's minimum, in points (server-validated). Falls back to a 1-point
  // floor so the ₹-min is never below the configured minimum.
  const cashMinPoints = cashItem?.minRedemptionPoints ?? 1;
  const partnerHasBeneficiary = hasBeneficiary(beneficiary);
  // captureBankAtRedemption: only when the per-tenant flag is ON do we replace the Cash-Payout
  // dead-end with the inline capture sheet — for a partner with NO beneficiary on file OR whose
  // details are NEEDS_RECAPTURE (a prior payout on them failed). Flag OFF / absent ⇒ false ⇒ the
  // existing dead-end card is byte-identical (Deoleo + every non-opted tenant unchanged).
  const showPayoutCapture =
    tenantFeatures.captureBankAtRedemption &&
    (!partnerHasBeneficiary || paymentDetailsStatus === 'NEEDS_RECAPTURE');

  const categories = useMemo(() => {
    // Dynamic category row — driven entirely by the RewardCategory names the tenant's
    // physical rewards are tagged with (no hard-coded whitelist). Ordered by the category's
    // admin-set sortOrder, then name, so operators control ordering from the admin UI with zero code.
    const order = new Map<string, number>();
    for (const g of physicalItems) {
      // Skip null/empty/whitespace-only category names so they can't render a blank chip.
      if (!g.category || !g.category.trim()) continue;
      if (!order.has(g.category)) order.set(g.category, g.categorySort ?? 0);
    }
    const ordered = Array.from(order.entries())
      .sort((a, b) => (a[1] - b[1]) || a[0].localeCompare(b[0]))
      .map(([name]) => name);
    return ['All', ...ordered];
  }, [physicalItems]);

  // Stale-selection guard: if the chosen category leaves the dynamic list (its rewards were
  // discontinued, or the category was deactivated), fall back to 'All'. Without this the grid
  // would show "No items found" with no chip highlighted and no obvious way back. The old
  // hard-coded whitelist couldn't hit this because its chip set was fixed.
  useEffect(() => {
    if (category !== 'All' && !categories.includes(category)) setCategory('All');
  }, [categories, category]);


  // Resolve the effective tab early (needed by filtered memo, which runs before loading gate)
  const ch = settings.redemptionChannels ?? { physicalGifts: true, vouchers: true, bankTransfer: true };
  const effectiveTab: MainTab = (() => {
    if (tab === 'catalogue' && !ch.physicalGifts) return ch.vouchers ? 'vouchers' : 'bank';
    if (tab === 'vouchers'  && !ch.vouchers)      return ch.bankTransfer ? 'bank' : 'catalogue';
    if (tab === 'bank'      && !ch.bankTransfer)   return ch.physicalGifts ? 'catalogue' : 'vouchers';
    return tab;
  })();

  // Keep the selected category chip in view on narrow screens. block:'nearest' stops the PAGE
  // jumping vertically; `?.` on scrollIntoView keeps old browsers / jsdom safe.
  // (Looked up via data-category on the row rather than a per-chip ref Map: a ref callback that
  // writes into a ref trips the react-hooks/refs lint rule.)
  const chipRowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const chip = Array.from(chipRowRef.current?.querySelectorAll<HTMLButtonElement>('button[data-category]') ?? [])
      .find(b => b.dataset.category === category);
    chip?.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  // effectiveTab: returning to Physical re-mounts the row → re-scroll the still-selected chip.
  }, [category, effectiveTab]);

  // The live rate (same one the voucher sheet uses) feeds the shared affordability rule.
  const affordability = useMemo(
    () => ({ minVoucherFreeAmount: settings.minVoucherFreeAmount, pointsConversionRate: effectiveRate }),
    [settings.minVoucherFreeAmount, effectiveRate],
  );
  // The wishlist filter only filters on the Physical tab — show it as ON only there.
  const wishlistFilterActive = wishlistFilter && effectiveTab === 'catalogue';

  const filtered = useMemo(() => {
    let items = effectiveTab === 'catalogue' ? physicalItems : voucherItems;
    if (effectiveTab === 'catalogue' && category !== 'All') items = items.filter(g => g.category === category);
    // "♥ Wishlist" filter — catalogue (physical) tab only; intersect with the saved Set.
    if (effectiveTab === 'catalogue' && wishlistFilter) items = items.filter(g => wishlist.has(g.id));
    // "Within my points" — same shared rule as the card dimming (never the backend isAffordable).
    if (withinPointsOnly) items = items.filter(g => isWithinPoints(g, balance, affordability));
    if (search) items = items.filter(g => g.name.toLowerCase().includes(search.toLowerCase()) || g.brand.toLowerCase().includes(search.toLowerCase()));
    return items.filter(g => g.available);
  }, [effectiveTab, physicalItems, voucherItems, category, search, wishlistFilter, wishlist, withinPointsOnly, balance, affordability]);

  // Optimistic persistent-wishlist toggle: flip the Set immediately, then POST (add)
  // or DELETE (remove). On a failed request REVERT the Set and surface a toast. A
  // per-id in-flight guard prevents a double-tap from firing conflicting requests.
  const toggleWishlist = (id: string) => {
    if (wishlistInFlight.current.has(id)) return;
    const willWishlist = !wishlist.has(id);
    // Optimistic update.
    setWishlist(prev => {
      const n = new Set(prev);
      if (willWishlist) n.add(id); else n.delete(id);
      return n;
    });
    const revert = () => setWishlist(prev => {
      const n = new Set(prev);
      if (willWishlist) n.delete(id); else n.add(id);
      return n;
    });
    wishlistInFlight.current.add(id);
    const req = willWishlist
      ? api.post('/api/rewards/wishlist', { rewardId: id })
      : api.del(`/api/rewards/wishlist/${id}`);
    req
      .then(result => {
        if (!result.success) {
          revert();
          toast.error(result.error || 'Could not update your wishlist');
        }
      })
      .catch(() => {
        revert();
        toast.error('Could not update your wishlist');
      })
      .finally(() => { wishlistInFlight.current.delete(id); });
  };

  // Live debit succeeded — reflect it optimistically in the local balance.
  // The wallet/catalog endpoints are the source of truth on next load.
  const handleRedeemed = (pts: number) => {
    setBalance(prev => Math.max(0, prev - pts));
  };

  if (loading || identity.loading) return <div className="flex items-center justify-center min-h-64"><Spinner size="lg" /></div>;

  /* ── Gate: outlet types with the per-type Loyalty flag OFF don't get the rewards
     catalogue. Placed AFTER every hook above (identity is settled here, since the
     spinner already returned while loading) so it can never skip a hook. A loyalty-ON
     outlet with zero points still reaches the catalogue — affordability, not this gate,
     handles the balance. ── */
  if (!identity.loyaltyEnabled) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
        <Gift className="h-12 w-12 text-gray-300" />
        <div>
          <p className="text-gray-700 font-semibold">Rewards not available</p>
          <p className="text-sm text-gray-500 mt-1">
            The rewards catalogue isn&apos;t available for your outlet type.
          </p>
        </div>
        <Button variant="primary" onClick={() => router.push('/partner/wallet')}>View My Wallet</Button>
      </div>
    );
  }

  const channels = ch; // already computed above

  const TAB_CFG = (
    [
      { key: 'catalogue' as MainTab, label: 'Physical',      icon: Gift,     enabled: channels.physicalGifts },
      { key: 'vouchers'  as MainTab, label: 'Vouchers',      icon: Tag,      enabled: channels.vouchers      },
      { key: 'bank'      as MainTab, label: 'Cash Payout',   icon: Banknote, enabled: channels.bankTransfer  },
    ] as const
  ).filter(t => t.enabled);

  const activeTab = effectiveTab;

  return (
    <div className="space-y-5 fade-in">
      {/* Header */}
      <div>
        <h1 className="text-lg font-bold text-gray-900">Rewards Catalogue</h1>
        <p className="text-xs text-gray-500 mt-0.5">Tap any item to see details before redeeming</p>
      </div>

      {/* Balance + wishlist */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-full px-3 py-1.5">
          <span className="text-sm font-bold text-[var(--brand-primary)]">{formatPoints(balance)} pts</span>
          <span className="text-[10px] text-emerald-600 font-medium">= {fmtInr(Math.floor(balance / effectiveRate))}</span>
        </div>
        <div className="flex items-center gap-2">
          {/* Wishlist pill — the ONLY Wishlist control: toggles the ♥ filter on/off and ensures the
              catalogue tab is shown. Shows its ON state so a partner can't get stuck filtered. */}
          <button
            type="button"
            onClick={() => {
              // From another tab: jump to Physical with the filter ON (never toggle it off unseen).
              if (effectiveTab !== 'catalogue') { setWishlistFilter(true); setTab('catalogue'); }
              else setWishlistFilter(v => !v);
            }}
            aria-pressed={wishlistFilterActive}
            aria-label={`Wishlist, ${wishlist.size} ${wishlist.size === 1 ? 'item' : 'items'}`}
            className={cn(
              'flex items-center gap-1.5 text-xs font-semibold px-3 py-1 rounded-full border transition-colors',
              wishlistFilterActive ? 'bg-red-500 text-white border-red-500' : 'border-gray-200 text-gray-600 hover:bg-gray-50',
            )}
          >
            <Heart className={cn('h-3.5 w-3.5', wishlistFilterActive && 'fill-white')} /> Wishlist{wishlist.size > 0 ? ` (${wishlist.size})` : ''}
          </button>
          <button
            onClick={() => router.push('/partner/rewards/orders')}
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1 rounded-full border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
          >
            <CheckCircle className="h-3.5 w-3.5" /> Orders
          </button>
        </div>
      </div>

      {/* Main tabs */}
      <div className="flex gap-2">
        {TAB_CFG.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors',
              activeTab === t.key ? 'bg-[var(--brand-primary)] text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200',
            )}
          >
            <t.icon className="h-3 w-3" /> {t.label}
          </button>
        ))}
      </div>

      {/* ── Cash Payout tab (unified UPI / Bank Transfer) ── */}
      {activeTab === 'bank' && (
        <div className="space-y-4">
          <div className="bg-blue-50 border border-blue-100 rounded-xl px-4 py-4 space-y-2">
            <div className="flex items-center gap-2">
              <Banknote className="h-4 w-4 text-blue-600 shrink-0" />
              <p className="text-sm font-semibold text-blue-800">Cash Payout</p>
            </div>
            <p className="text-xs text-blue-700">
              Convert your points to INR, paid directly to your registered account.
              Minimum redemption: {fmtInr(Math.ceil(cashMinPoints / effectiveRate))}.
            </p>
          </div>

          {showPayoutCapture ? (
            /* captureBankAtRedemption ON + (no beneficiary OR NEEDS_RECAPTURE): capture bank/UPI
               in-flow (reusing the KYC form/rules), then proceed into the existing CashPayoutSheet. */
            <PayoutCaptureSheet
              requiredPaymentType={requiredPaymentType}
              onCaptured={refreshBeneficiary}
            />
          ) : !partnerHasBeneficiary ? (
            /* No bank or UPI on file — mirror the backend guard; hide the form. */
            <div
              data-testid="cash-no-beneficiary"
              className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-4 flex items-start gap-3"
            >
              <AlertCircle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-amber-900">Bank / UPI details needed</p>
                <p className="text-xs text-amber-700 mt-0.5">
                  Complete your bank/UPI details in KYC to redeem for cash.
                </p>
                <button
                  onClick={() => router.push('/partner/profile')}
                  className="mt-2 text-xs font-semibold text-amber-800 underline"
                >
                  Go to KYC / Profile
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Beneficiary on file — REAL details (bank and/or UPI). */}
              <div className="bg-white rounded-xl border border-gray-200 px-4 py-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-gray-100 rounded-xl flex items-center justify-center">
                    <CreditCard className="h-5 w-5 text-gray-500" />
                  </div>
                  <div>
                    {beneficiary!.upiId && (
                      <p className="text-sm font-semibold text-gray-900" data-testid="cash-tab-upi">
                        UPI · {beneficiary!.upiId}
                      </p>
                    )}
                    {beneficiary!.bankAccountNumber && beneficiary!.ifscCode && (
                      <div data-testid="cash-tab-bank">
                        <p className="text-sm font-semibold text-gray-900">
                          {beneficiary!.bankName ?? 'Bank account'}
                        </p>
                        <p className="text-xs text-gray-500 font-mono">
                          {maskAccountNumber(beneficiary!.bankAccountNumber)} · {beneficiary!.ifscCode}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
                <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full">On file</span>
              </div>

              <Button
                variant="primary"
                className="w-full"
                disabled={!cashItem || balance < cashMinPoints}
                onClick={() => setShowBank(true)}
              >
                <Banknote className="h-4 w-4" />
                {!cashItem
                  ? 'Cash payout unavailable'
                  : balance < cashMinPoints
                  ? `Need ${formatPoints(cashMinPoints - balance)} more pts`
                  : 'Redeem for Cash'}
              </Button>
            </>
          )}
        </div>
      )}

      {/* ── Catalogue / Voucher tabs: search + filter ── */}
      {activeTab !== 'bank' && (
        <>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={activeTab === 'vouchers' ? 'Search vouchers…' : 'Search rewards…'}
              className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-gray-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
            />
          </div>

          {/* Filter chips — "Within my points" on Physical + Vouchers; category pills catalogue only */}
          {(activeTab === 'catalogue' || activeTab === 'vouchers') && (
            <div className="relative">
            {/* pr-8 lets the last chip scroll fully clear of the right-edge fade. */}
            <div ref={chipRowRef} className="flex gap-2 overflow-x-auto pb-1 pr-8 scrollbar-none" style={{ scrollbarWidth: 'none' }}>
              {/* Affordability filter — always first. */}
              <button
                type="button"
                onClick={() => setWithinPointsOnly(v => !v)}
                aria-pressed={withinPointsOnly}
                className={cn(
                  'px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors shrink-0',
                  withinPointsOnly ? 'bg-[var(--brand-primary)] text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200',
                )}
              >
                Within my points
              </button>
              {activeTab === 'catalogue' && categories.map(cat => (
                <button
                  key={cat}
                  data-category={cat}
                  onClick={() => setCategory(cat)}
                  className={cn(
                    'px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors shrink-0',
                    category === cat ? 'bg-[var(--brand-primary)] text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200',
                  )}
                >
                  {cat}
                </button>
              ))}
            </div>
            {/* Decorative right-edge fade — hints the row scrolls. Matches the body background (--background). */}
            <div
              data-testid="chip-row-fade"
              aria-hidden="true"
              className="pointer-events-none absolute right-0 top-0 bottom-1 w-8 bg-gradient-to-l from-[var(--background,white)] to-transparent"
            />
            </div>
          )}

          {/* Grid */}
          {filtered.length === 0 ? (
            <EmptyState
              icon={<Gift className="h-8 w-8" />}
              title="No items found"
              description={
                withinPointsOnly
                  ? 'Nothing within your points yet — turn off "Within my points" to see all rewards'
                  : wishlistFilterActive
                    ? 'Your wishlist is empty — tap ♥ on a reward to save it'
                    : 'Try a different search or category'
              }
            />
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {filtered.map(gift => {
                const needPoints  = pointsRequired(gift, affordability);
                const canAfford   = balance >= needPoints;
                const isWishlisted = wishlist.has(gift.id);
                // Struck-through MRP "list price" in points (per-tenant catalogueMrpSlash). Null ⇒ not shown.
                // Server-driven, rate-independent (gift.slashPoints); the flag only gates visibility.
                const mrpPoints   = mrpSlashPoints(gift, tenantFeatures.catalogueMrpSlash);
                return (
                  <div
                    key={gift.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => gift.voucherType ? setVoucherDetail(gift) : setDetail(gift)}
                    onKeyDown={e => {
                      // Activate on Enter OR Space (Space would otherwise just scroll the page).
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        gift.voucherType ? setVoucherDetail(gift) : setDetail(gift);
                      }
                    }}
                    className={cn(
                      'bg-white rounded-xl border overflow-hidden shadow-sm text-left cursor-pointer',
                      'flex flex-col transition-all active:scale-[0.98]',
                      canAfford ? 'border-gray-200 hover:shadow-md hover:border-gray-300' : 'border-gray-100 opacity-60 hover:opacity-80',
                    )}
                  >
                    <div className="relative">
                      <GiftImage gift={gift} size="small" />
                      {gift.popular && (
                        <span className="absolute top-2 right-2 text-[9px] font-bold bg-amber-100 text-amber-600 px-1.5 py-0.5 rounded-full">Popular</span>
                      )}
                      {/* Wishlist heart */}
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); toggleWishlist(gift.id); }}
                        className="absolute top-2 left-2 w-6 h-6 bg-white/80 rounded-full flex items-center justify-center"
                      >
                        <Heart className={`h-3.5 w-3.5 ${isWishlisted ? 'fill-red-500 text-red-500' : 'text-gray-400'}`} />
                      </button>
                      {/* FREE_AMOUNT badge */}
                      {gift.voucherType === 'FREE_AMOUNT' && (
                        <span className="absolute bottom-2 left-2 text-[9px] font-bold bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full">Any Amount</span>
                      )}
                      {!canAfford && (
                        <div className="absolute inset-0 flex items-end justify-center pb-2">
                          <span className="text-[9px] font-bold bg-gray-800/70 text-white px-2 py-0.5 rounded-full">
                            {`Need ${formatPoints(needPoints - balance)} more${gift.voucherType === 'FREE_AMOUNT' ? '' : ' pts'}`}
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="p-3 flex-1 flex flex-col">
                      <p className="text-xs text-gray-400 mb-0.5">{gift.brand}</p>
                      <p className="text-xs font-semibold text-gray-900 leading-snug line-clamp-2 flex-1">{gift.name}</p>
                      <div className="mt-2 pt-2 border-t border-gray-50 flex items-center justify-between">
                        {isFreeAmount(gift) ? (
                          <span className="text-sm font-bold text-[var(--brand-primary)]">You set the amount</span>
                        ) : (
                          <span className="flex flex-col leading-none">
                            {mrpPoints != null && (
                              <span className="text-[10px] text-gray-400 line-through mb-0.5">
                                {formatPoints(mrpPoints)} pts
                              </span>
                            )}
                            <span className={`text-sm font-bold ${canAfford ? 'text-[var(--brand-primary)]' : 'text-gray-400'}`}>
                              {formatPoints(gift.points)} pts
                            </span>
                          </span>
                        )}
                        <span className="text-[10px] text-gray-400 underline">Details</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Detail sheets */}
      {detail && (
        <GiftDetailSheet
          gift={detail} onClose={() => setDetail(null)}
          myBalance={balance} mobile={mobile} memberName={memberName}
          onWishlist={toggleWishlist} isWishlisted={wishlist.has(detail.id)}
          onRedeemed={handleRedeemed}
          mrpSlashEnabled={tenantFeatures.catalogueMrpSlash}
          // `?? null`: older backends (and tests) omit the field — nothing on file.
          deliveryDefaults={identity.deliveryDefaults ?? null}
        />
      )}
      {voucherDetail && (
        <VoucherRedeemSheet
          voucher={voucherDetail} onClose={() => setVoucherDetail(null)}
          myBalance={balance} minFreeAmount={settings.minVoucherFreeAmount}
          conversionRate={effectiveRate}
          onRedeemed={handleRedeemed}
        />
      )}
      {showBank && partnerHasBeneficiary && (
        <CashPayoutSheet
          onClose={() => setShowBank(false)}
          myBalance={balance}
          minPoints={cashMinPoints}
          conversionRate={effectiveRate}
          beneficiary={beneficiary!}
          rewardId={cashItem?.id ?? null}
          onRedeemed={handleRedeemed}
        />
      )}
    </div>
  );
}
