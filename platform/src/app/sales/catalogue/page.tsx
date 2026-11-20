'use client';

import React, { useState, useEffect, useMemo, useRef, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Gift, Search, X, ChevronRight, CheckCircle,
  Smartphone, AlertTriangle, Loader2, RefreshCw, Zap,
  Star, ChevronLeft, Package, Truck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { type GiftCatalogueItem, GIFT_CATALOGUE } from '@/lib/gifts';
import { api } from '@/lib/api-client';
import { isDeliveryDefaults, type DeliveryDefaults } from '@/lib/partner-identity';
import { applyAddressPrefill, type AddressForm, type TouchedFields } from '@/lib/address-prefill';
import { WHOLE_RUPEE_INVALID_MESSAGE, isWholeRupeeInvalid, wholeRupeeAmount, wholeRupeeInputProps } from '@/lib/whole-rupee-input';
import { pointsForAmount } from '@/lib/hubble-product';
import { voucherAmountBand } from '@/lib/voucher-band';

const fmtInr = (n: number) => `₹${n.toLocaleString('en-IN')}`;

type GiftItem = GiftCatalogueItem;

/* ─── Outlet types ───────────────────────────────────────────────────────────── */

interface Outlet {
  id: string;
  partnerId: string;
  kycId: string;
  name: string;
  mobile: string;
  balance: number;
  /** THIS outlet's address on file (GET /sales/outlets, already junk-cleaned server-side) —
   *  pre-fills the physical-gift delivery form. Null when nothing usable is on file. */
  deliveryDefaults: DeliveryDefaults | null;
  /** Outlet owner's name — seeds the editable "Recipient name". '' when unknown. */
  ownerName: string;
}

/* ─── Flow types ─────────────────────────────────────────────────────────────── */

type SheetStep = 'detail' | 'select_outlet' | 'confirm' | 'otp' | 'success';

interface RedeemState {
  outlet: Outlet | null;
  orderId: string;
  otpSending: boolean;
  otpSent: boolean;
  otp: string;
  verifying: boolean;
  error: string;
  otpResendCountdown: number;
  /** ₹ amount for a FREE_AMOUNT (variable) voucher/bank-transfer redemption; '' otherwise. */
  amount: string;
  /**
   * The last commit (blur / Enter / paste / a tap on Send OTP) found the amount text INVALID —
   * "Check the amount" shows while this is set; cleared on the next edit (never shown mid-typing).
   * Same rule as useWholeRupeeField (lib/whole-rupee-input).
   */
  amountFlagged: boolean;
  /** The ₹ amount the ORDER was created with (frozen at OTP-send; null before / for FIXED items). */
  sentAmount: number | null;
  /** The points the ORDER debits — the SERVER's requiredPoints from redeem-init (frozen at OTP-send). */
  sentPoints: number | null;
  /** PHYSICAL_GIFT delivery address — ONLY what the rep typed (+ `addrTouched` marks every edited
   *  field). The shown address is DERIVED via applyAddressPrefill from the target outlet's
   *  deliveryDefaults, so the pre-fill never overwrites typing or a deliberate clear. */
  addrTyped: AddressForm;
  addrTouched: TouchedFields;
  /** Recipient name as typed; until touched, the shown value is the outlet's ownerName. */
  recipientName: string;
  recipientTouched: boolean;
}

const EMPTY_ADDRESS: AddressForm = { line1: '', city: '', state: '', pincode: '' };

const INITIAL_REDEEM: RedeemState = {
  outlet: null, orderId: '', otpSending: false, otpSent: false, otp: '',
  verifying: false, error: '', otpResendCountdown: 0, amount: '', amountFlagged: false, sentAmount: null, sentPoints: null,
  addrTyped: EMPTY_ADDRESS, addrTouched: {}, recipientName: '', recipientTouched: false,
};

/** Reset the per-outlet delivery inputs (a different outlet → its own address pre-fill). */
const RESET_DELIVERY: Pick<RedeemState, 'addrTyped' | 'addrTouched' | 'recipientName' | 'recipientTouched'> = {
  addrTyped: EMPTY_ADDRESS, addrTouched: {}, recipientName: '', recipientTouched: false,
};

/** A physical gift ships to an address — the backend REQUIRES deliveryAddress for this mode. */
function isPhysicalGift(g: GiftItem | null): boolean {
  return !!g && g.redemptionMode === 'PHYSICAL_GIFT';
}

/** A FREE_AMOUNT (variable) reward: pointsCost 0 AND both band bounds set — the redeemer supplies
 *  the ₹ amount (converted to points server-side). Mirrors the backend isFreeAmount predicate. */
function isFreeAmountGift(g: GiftItem | null): boolean {
  return !!g && g.points === 0 && g.minRedemptionPoints != null && g.maxRedemptionPoints != null;
}

/** A cash (UPI / bank-transfer) reward — the server floors it at minBankTransferAmount, not the
 *  voucher minimum (rewards.service redeemForOutlet). */
function isCashGift(g: GiftItem): boolean {
  return g.redemptionMode === 'UPI' || g.redemptionMode === 'BANK_TRANSFER';
}

/* ─── Gift image display ─────────────────────────────────────────────────────── */

function GiftImage({
  gift,
  size = 'card',
}: {
  gift: Pick<GiftItem, 'imageDataUrl' | 'emoji' | 'gradientFrom' | 'gradientTo' | 'name'>;
  size?: 'card' | 'thumb' | 'detail';
}) {
  const heights = { card: 'h-36 w-full', thumb: 'h-12 w-12', detail: 'h-64 w-full' };
  const emojis  = { card: 'text-5xl', thumb: 'text-2xl', detail: 'text-8xl' };
  const padding = { card: 'p-3', thumb: '', detail: 'p-4' };

  if (gift.imageDataUrl) {
    return (
      <div className={`${heights[size]} ${size === 'thumb' ? 'rounded-xl overflow-hidden' : ''} flex items-center justify-center bg-white overflow-hidden`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={gift.imageDataUrl}
          alt={gift.name}
          className={size === 'thumb' ? 'w-full h-full object-cover' : `max-h-full max-w-full object-contain ${padding[size]}`}
        />
      </div>
    );
  }

  return (
    <div
      className={`${heights[size]} ${size === 'thumb' ? 'rounded-xl' : ''} flex items-center justify-center select-none`}
      style={{ background: `linear-gradient(135deg, ${gift.gradientFrom}22, ${gift.gradientTo}44)` }}
    >
      <span className={emojis[size]}>{gift.emoji}</span>
    </div>
  );
}

/* ─── Catalogue inner ────────────────────────────────────────────────────────── */

function CatalogueInner() {
  const searchParams  = useSearchParams();
  const preselectedId = searchParams.get('outletId') ?? '';

  const [outlets,      setOutlets]      = useState<Outlet[]>([]);
  const [gifts,        setGifts]        = useState<GiftItem[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [category,     setCategory]     = useState('All');
  const [search,       setSearch]       = useState('');

  // Sheet state
  const [selectedGift, setSelectedGift] = useState<GiftItem | null>(null);
  const [sheetStep,    setSheetStep]    = useState<SheetStep | null>(null);
  const [redeem,       setRedeem]       = useState<RedeemState>({ ...INITIAL_REDEEM, outlet: null });
  // Tenant points-per-₹ + minimum voucher / bank-transfer amount (from /me) — loaded on catalogue
  // load when a "choose from amounts" item exists (amounts below the minimum are shown greyed
  // out), else on demand when a variable-amount item is opened (its ₹ min/max band needs them).
  // A catalogue without either never requests /me.
  const [conversionRate, setConversionRate] = useState<number | null>(null);
  const [minVoucherAmount, setMinVoucherAmount] = useState(0);
  const [minBankTransferAmount, setMinBankTransferAmount] = useState(0);
  // 'idle' (never requested) → 'loading' → 'loaded' (a usable rate) | 'error' (the read failed or
  // returned no usable rate — a typed amount's limits can't be computed; the rep can retry).
  const [settingsStatus, setSettingsStatus] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');
  const settingsRequested = useRef(false);
  const loadSettings = () => {
    if (settingsRequested.current) return;
    settingsRequested.current = true;
    setSettingsStatus('loading');
    const failed = () => { settingsRequested.current = false; setSettingsStatus('error'); };
    api.get<{ conversionRate?: number; settings?: { minVoucherFreeAmount?: number; minBankTransferAmount?: number } }>('/api/auth/me')
      .then((me) => {
        const r = me.success ? me.data?.conversionRate : undefined;
        if (!(typeof r === 'number' && Number.isFinite(r) && r > 0)) { failed(); return; }
        setConversionRate(r);
        const floor = me.success ? me.data?.settings?.minVoucherFreeAmount : undefined;
        if (typeof floor === 'number' && Number.isFinite(floor) && floor > 0) setMinVoucherAmount(floor);
        const bankFloor = me.success ? me.data?.settings?.minBankTransferAmount : undefined;
        if (typeof bankFloor === 'number' && Number.isFinite(bankFloor) && bankFloor > 0) setMinBankTransferAmount(bankFloor);
        setSettingsStatus('loaded');
      })
      .catch(failed);
  };

  const preOutlet = useMemo(
    () => preselectedId ? outlets.find((o) => o.kycId === preselectedId || o.id === preselectedId) ?? null : null,
    [outlets, preselectedId],
  );

  const otpRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fetch outlets from API
  useEffect(() => {
    fetch('/api/sales/outlets')
      .then((r) => r.json())
      .then((body) => {
        if (body.success) {
          const mapped: Outlet[] = (body.data.outlets ?? []).map((o: any) => ({
            id:        o.id,
            partnerId: o.partnerId ?? '',
            kycId:     o.kycId ?? '',
            name:      o.name,
            mobile:    o.mobile ?? '',
            balance:   o.balance ?? 0,
            deliveryDefaults: isDeliveryDefaults(o.deliveryDefaults) ? o.deliveryDefaults : null,
            ownerName: typeof o.ownerName === 'string' ? o.ownerName : '',
          }));
          setOutlets(mapped);
          if (preselectedId) {
            const found = mapped.find((o) => o.kycId === preselectedId || o.id === preselectedId);
            if (found) setRedeem((r) => ({ ...r, outlet: found }));
          }
        }
      })
      .catch(() => {});
  }, [preselectedId]);

  useEffect(() => {
    // The real /v1/rewards/catalog returns RewardCatalog rows (no brand/category/
    // available/popular columns) — derive availability from status + stock, and
    // borrow cosmetic-only fields (brand/category/emoji/gradient) from the static
    // GIFT_CATALOGUE by id where present (else safe defaults). #50-E / D1.
    interface ApiCatalogItem {
      id: string; name: string; pointsCost: number;
      description: string | null; imageUrls: string[] | null;
      status: string; stockQuantity: number | null; redemptionMode?: string;
      // FREE_AMOUNT band (points) — needed so the sales-assisted redeem can collect a ₹ amount
      // for variable vouchers/bank transfers (the backend requires `amount` for these).
      minRedemptionPoints?: number | null; maxRedemptionPoints?: number | null;
      // Hubble "choose from amounts" gift card (absent otherwise).
      amountOptions?: number[] | null;
    }
    interface ApiCatalogResponse { items: ApiCatalogItem[] }
    api.get<ApiCatalogResponse>('/api/rewards/catalog')
      .then(result => {
        if (result.success && result.data.items.length > 0) {
          const mapped: GiftCatalogueItem[] = result.data.items.map(item => {
            const ref = GIFT_CATALOGUE.find(g => g.id === item.id);
            const available = item.status === 'ACTIVE' && (item.stockQuantity == null || item.stockQuantity > 0);
            return {
              id:           item.id,
              name:         item.name,
              brand:        ref?.brand ?? '',
              category:     ref?.category ?? 'Gifts',
              points:       item.pointsCost,
              description:  item.description ?? ref?.description ?? '',
              imageDataUrl: item.imageUrls?.[0] ?? ref?.imageDataUrl ?? null,
              available,
              popular:      ref?.popular ?? false,
              emoji:        ref?.emoji         ?? '🎁',
              gradientFrom: ref?.gradientFrom  ?? '#f3f4f6',
              gradientTo:   ref?.gradientTo    ?? '#e5e7eb',
              features:     ref?.features      ?? [],
              details:      ref?.details       ?? '',
              addedDate:    ref?.addedDate     ?? new Date().toISOString().slice(0, 10),
              voucherType:  ref?.voucherType,
              fixedAmount:  ref?.fixedAmount,
              redemptionMode:      item.redemptionMode ?? null,
              minRedemptionPoints: item.minRedemptionPoints ?? null,
              maxRedemptionPoints: item.maxRedemptionPoints ?? null,
              ...(item.amountOptions?.length ? { amountOptions: item.amountOptions } : {}),
            };
          });
          setGifts(mapped);
          // Points per listed amount need the tenant rate — fetched ONLY when the catalogue has a
          // "choose from amounts" item (never for a tenant without one).
          if (mapped.some((g) => g.amountOptions?.length)) loadSettings();
        } else {
          setGifts([]);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Countdown ticker
  useEffect(() => {
    if (redeem.otpResendCountdown > 0) {
      otpRef.current = setInterval(() => {
        setRedeem((r) => ({ ...r, otpResendCountdown: Math.max(0, r.otpResendCountdown - 1) }));
      }, 1_000);
    }
    return () => { if (otpRef.current) clearInterval(otpRef.current); };
  }, [redeem.otpResendCountdown]);

  // Auto-focus OTP input
  useEffect(() => {
    if (sheetStep === 'otp') setTimeout(() => inputRef.current?.focus(), 100);
  }, [sheetStep]);

  const categories = useMemo(
    () => ['All', ...Array.from(new Set(gifts.map((g) => g.category))).sort()],
    [gifts],
  );

  const filtered = useMemo(() =>
    gifts.filter((g) =>
      (category === 'All' || g.category === category) &&
      (g.name.toLowerCase().includes(search.toLowerCase()) ||
       g.brand.toLowerCase().includes(search.toLowerCase()))
    ),
  [gifts, category, search]);

  /* ── Sheet open/close ── */

  const openDetail = (gift: GiftItem) => {
    setSelectedGift(gift);
    setRedeem({ ...INITIAL_REDEEM, outlet: preOutlet });
    setSheetStep('detail');
    // The ₹ min/max band of a variable-amount item needs the tenant rate + floors.
    if (isFreeAmountGift(gift)) loadSettings();
  };

  const closeSheet = () => {
    setSheetStep(null);
    setTimeout(() => { setSelectedGift(null); setRedeem({ ...INITIAL_REDEEM, outlet: preOutlet }); }, 300);
  };

  /* ── Redemption handlers ── */

  const selectOutlet = (outlet: Outlet) => {
    // A different outlet → its own address pre-fill (never carry typing across outlets).
    setRedeem((r) => (r.outlet?.id === outlet.id ? { ...r, outlet } : { ...r, outlet, ...RESET_DELIVERY }));
    setSheetStep('confirm');
  };

  /* ── Physical-gift delivery address (PLATFORM-WIDE, mirrors the partner redeem sheet) ── */

  // Shown address = what the rep typed + the TARGET outlet's address on file for every empty,
  // untouched field (applyAddressPrefill — shared with the partner flow). Derived, no effect.
  const deliveryAddress = useMemo(
    () => applyAddressPrefill(redeem.addrTyped, redeem.addrTouched, redeem.outlet?.deliveryDefaults),
    [redeem.addrTyped, redeem.addrTouched, redeem.outlet?.deliveryDefaults],
  );
  const recipientName = redeem.recipientTouched ? redeem.recipientName : (redeem.outlet?.ownerName ?? '');
  const outletDefaults = redeem.outlet?.deliveryDefaults ?? null;
  // Hint only while at least one untouched field still holds its pre-filled value.
  const showPrefillHint = !!outletDefaults && (Object.keys(EMPTY_ADDRESS) as (keyof AddressForm)[]).some(
    (k) => !redeem.addrTouched[k] && !!outletDefaults[k] && deliveryAddress[k] === outletDefaults[k],
  );

  const setAddressField = (key: keyof AddressForm, value: string) =>
    setRedeem((r) => ({
      ...r,
      error: '',
      addrTouched: r.addrTouched[key] ? r.addrTouched : { ...r.addrTouched, [key]: true },
      addrTyped: { ...r.addrTyped, [key]: value },
    }));

  // The ₹ band of a TYPED variable-amount item (same rule as the partner voucher sheet): the
  // ADMIN's per-item band (min/max points → whole rupees at the tenant rate, server rounding)
  // with the tenant floor (voucher minimum; bank-transfer minimum for a cash item) as a lower
  // bound. A choose-from-amounts item skips it (the listed amounts ARE the band). Until /me has
  // answered with a usable rate the limits are UNKNOWN: no band text, Send disabled ("Loading
  // limits…", or a retry after a failed read) — never a "(min ₹0)" that enforces nothing.
  // Server validation is unchanged (defence in depth).
  const typedAmountGift = !!selectedGift && isFreeAmountGift(selectedGift) && !selectedGift.amountOptions?.length;
  const limitsLoading = typedAmountGift && (settingsStatus === 'idle' || settingsStatus === 'loading');
  const limitsFailed = typedAmountGift && settingsStatus === 'error';
  const band = typedAmountGift && selectedGift && settingsStatus === 'loaded' && conversionRate != null
    ? voucherAmountBand(selectedGift, isCashGift(selectedGift) ? minBankTransferAmount : minVoucherAmount, conversionRate)
    : null;
  // An empty band (₹ max below ₹ min): no amount can ever pass — say so and lock the field.
  const amountUnredeemable = !!band && band.max != null && band.max < band.min;
  const typedAmount = wholeRupeeAmount(redeem.amount); // null = invalid text (handled separately)
  const belowMin = !!band && !amountUnredeemable && typedAmount != null && typedAmount > 0 && typedAmount < band.min;
  const aboveMax = !!band && !amountUnredeemable && band.max != null && typedAmount != null && typedAmount > band.max;
  const amountHint = belowMin
    ? `Minimum redemption is ${fmtInr(band!.min)}`
    : aboveMax
    ? `Maximum redemption is ${fmtInr(band!.max ?? 0)}`
    : '';

  // Sales-assisted redeem (B1): create the PENDING order; the backend sends the
  // OTP to the OUTLET's registered mobile. The rep enters the code the outlet shares.
  const sendOtp = async () => {
    if (!redeem.outlet?.partnerId || !selectedGift) {
      setRedeem((r) => ({ ...r, error: 'Missing outlet or gift. Please reselect.' }));
      return;
    }
    // FREE_AMOUNT (variable) vouchers / bank transfers require a ₹ amount — without it the backend
    // rejects redeem-for-outlet with "amount (₹) is required for a variable-amount voucher".
    const freeAmount = isFreeAmountGift(selectedGift);
    // A resend after the OTP was sent re-uses the FROZEN amount (the field is locked meanwhile).
    const parsedAmount = redeem.otpSent && redeem.sentAmount != null ? redeem.sentAmount : wholeRupeeAmount(redeem.amount);
    if (freeAmount && parsedAmount === null) {
      // "750,5" / "1,2" / a pasted decimal — never guessed, never sent.
      setRedeem((r) => ({ ...r, amountFlagged: true, error: '' }));
      return;
    }
    const amountNum = parsedAmount ?? 0;
    const options = selectedGift.amountOptions?.length ? selectedGift.amountOptions : null;
    if (freeAmount && options && !options.includes(amountNum)) {
      setRedeem((r) => ({ ...r, error: 'Choose one of the available amounts.' }));
      return;
    }
    // Whole rupees only (the input already blocks decimals; this guards any other path).
    if (freeAmount && (!Number.isInteger(amountNum) || amountNum <= 0)) {
      setRedeem((r) => ({ ...r, error: 'Enter a whole-rupee amount (₹) to redeem for this outlet.' }));
      return;
    }
    // Limits unknown / outside the ₹ band → never sent (the button is disabled too; this guards
    // any other path) — with the reason, never a silent no-op.
    if (typedAmountGift && !redeem.otpSent) {
      const reason = limitsLoading
        ? 'Redemption limits are still loading — please wait.'
        : limitsFailed || !band
        ? 'Couldn’t load redemption limits — try again.'
        : amountUnredeemable
        ? 'This voucher can’t be redeemed right now.'
        : amountNum < band.min
        ? `Minimum redemption is ${fmtInr(band.min)}`
        : band.max != null && amountNum > band.max
        ? `Maximum redemption is ${fmtInr(band.max)}`
        : '';
      if (reason) { setRedeem((r) => ({ ...r, error: reason })); return; }
    }
    // PHYSICAL_GIFT: the backend REQUIRES a full deliveryAddress (else 400). Same rules as the
    // partner redeem sheet; the phone is the outlet's registered mobile (as the partner's is).
    let delivery: Record<string, string> | null = null;
    if (isPhysicalGift(selectedGift)) {
      const a = {
        line1: deliveryAddress.line1.trim(), city: deliveryAddress.city.trim(),
        state: deliveryAddress.state.trim(), pincode: deliveryAddress.pincode.trim(),
      };
      const mobile = redeem.outlet.mobile.replace(/\D/g, '').slice(-10);
      let err = '';
      if (!recipientName.trim()) err = 'Please enter the recipient name';
      else if (!a.line1 || !a.city || !a.pincode) err = 'Please fill in all required address fields';
      else if (!/^[1-9]\d{5}$/.test(a.pincode)) err = 'Enter a valid 6-digit pincode';
      else if (!/^\d{10}$/.test(mobile)) err = 'This outlet has no valid 10-digit mobile on file.';
      if (err) { setRedeem((r) => ({ ...r, error: err })); return; }
      delivery = {
        name: recipientName.trim(), mobile,
        address: a.line1, city: a.city, state: a.state || a.city, pincode: a.pincode,
      };
    }
    setRedeem((r) => ({ ...r, otpSending: true, error: '' }));
    const res = await api.post<{ orderId: string; orderNumber: string; requiredPoints?: number }>(
      '/api/rewards/redeem-for-outlet',
      {
        rewardId: selectedGift.id,
        targetPartnerId: redeem.outlet.partnerId,
        ...(freeAmount ? { amount: amountNum } : {}),
        ...(delivery ? { deliveryAddress: delivery } : {}),
      },
    );
    if (res.success && res.data?.orderId) {
      setRedeem((r) => ({
        ...r, otpSending: false, otpSent: true, orderId: res.data.orderId, otp: '', otpResendCountdown: 30,
        sentAmount: freeAmount ? amountNum : null,
        // The SERVER's requiredPoints (what the order debits); a resend keeps the first value; the
        // item's fixed points only if the server sent none.
        sentPoints: typeof res.data.requiredPoints === 'number' && Number.isFinite(res.data.requiredPoints)
          ? res.data.requiredPoints
          : r.sentPoints ?? (freeAmount ? null : selectedGift.points),
      }));
      setSheetStep('otp');
    } else {
      setRedeem((r) => ({ ...r, otpSending: false, error: res.success ? 'Could not start redemption.' : res.error }));
    }
  };

  // "Change amount" (or Back) from the OTP step: abandon this OTP and return to the amount — the
  // next Send OTP starts a fresh redeem (a new order) with the new amount.
  const changeAmount = () => {
    setRedeem((r) => ({ ...r, otpSent: false, orderId: '', otp: '', otpResendCountdown: 0, sentAmount: null, sentPoints: null, error: '' }));
    setSheetStep('confirm');
  };

  const verifyOtp = async () => {
    if (redeem.otp.length < 6) {
      setRedeem((r) => ({ ...r, error: 'Please enter the 6-digit OTP.' }));
      return;
    }
    if (!redeem.outlet?.partnerId || !redeem.orderId) {
      setRedeem((r) => ({ ...r, error: 'Redemption session expired. Please restart.' }));
      return;
    }
    setRedeem((r) => ({ ...r, verifying: true, error: '' }));
    const res = await api.post<{ orderId: string; status: string; message: string }>(
      '/api/rewards/redeem-for-outlet/confirm',
      { orderId: redeem.orderId, otp: redeem.otp, targetPartnerId: redeem.outlet.partnerId },
    );
    if (res.success) {
      // Hubble auto-issuance (Bajaj GIFT_CARD) can resolve synchronously to FAILED — the
      // server has ALREADY refunded the points. Surface the failure, not a success screen.
      // (Non-Hubble confirms return 'CONFIRMED' → unchanged.)
      if (res.data?.status === 'FAILED') {
        setRedeem((r) => ({
          ...r,
          verifying: false,
          error: res.data.message || 'Could not issue the voucher; the points have been refunded.',
        }));
        return;
      }
      setRedeem((r) => ({ ...r, verifying: false }));
      setSheetStep('success');
    } else {
      setRedeem((r) => ({ ...r, verifying: false, error: res.error || 'Invalid or expired OTP. Please try again.' }));
    }
  };

  // "Check the amount" — only after a commit that found the text invalid; cleared on the next edit.
  const amountInvalidShown = redeem.amountFlagged && isWholeRupeeInvalid(redeem.amount);

  const maskedMobile = (m: string) => `****${m.slice(-4)}`;

  /* ── Render ── */

  return (
    <div className="space-y-5 fade-in">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-gray-900">Gift Catalogue</h1>
        <p className="text-sm text-gray-500">Tap any gift to see details before redeeming</p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-48"><Spinner size="lg" /></div>
      ) : (
        <>
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search gifts…"
              className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)] bg-white"
            />
          </div>

          {/* Category chips — wrap so every category stays visible */}
          <div className="flex flex-wrap items-center gap-2">
            {categories.map((c) => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold border whitespace-nowrap transition-all shrink-0 ${
                  category === c
                    ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]'
                    : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
                }`}
              >
                {c}
              </button>
            ))}
          </div>

          {/* Gift grid */}
          {filtered.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-12">No gifts found.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {filtered.map((gift) => (
                <button
                  key={gift.id}
                  onClick={() => gift.available && openDetail(gift)}
                  className={`bg-white rounded-2xl border border-gray-100 overflow-hidden shadow-sm text-left flex flex-col transition-all hover:shadow-md hover:border-gray-200 active:scale-[0.98] relative ${!gift.available ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
                >
                  {/* Gift image */}
                  <div className="relative w-full">
                    <GiftImage gift={gift} size="card" />
                    {gift.popular && (
                      <span className="absolute top-2 right-2 text-[9px] font-bold bg-amber-100 text-amber-600 px-1.5 py-0.5 rounded-full">
                        Popular
                      </span>
                    )}
                    {!gift.available && (
                      <div className="absolute inset-0 bg-white/70 flex items-center justify-center">
                        <span className="text-xs font-semibold text-gray-500">Out of stock</span>
                      </div>
                    )}
                  </div>

                  <div className="p-3 flex-1 flex flex-col gap-1">
                    <p className="text-[10px] text-gray-400">{gift.brand}</p>
                    <p className="text-xs font-semibold text-gray-900 leading-snug line-clamp-2 flex-1">{gift.name}</p>
                    <p className="text-[10px] text-gray-400 line-clamp-1">{gift.description}</p>
                    <div className="mt-2 pt-2 border-t border-gray-50 flex items-center justify-between">
                      {isFreeAmountGift(gift) ? (
                        <span className="text-sm font-bold text-[var(--brand-primary)]">
                          {gift.amountOptions?.length ? `From ₹${gift.amountOptions[0].toLocaleString('en-IN')}` : 'You set the amount'}
                        </span>
                      ) : (
                        <span className="text-sm font-bold text-[var(--brand-primary)]">{gift.points.toLocaleString('en-IN')} pts</span>
                      )}
                      <span className="text-[10px] text-[var(--brand-primary)] font-medium">View details →</span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── Bottom sheet ── */}
      {sheetStep && selectedGift && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/40"
            onClick={sheetStep === 'detail' || sheetStep === 'success' ? closeSheet : undefined}
          />

          {/* Sheet */}
          <div className="relative bg-white rounded-t-2xl max-h-[92vh] flex flex-col shadow-2xl">
            {/* Handle */}
            <div className="flex justify-center pt-3 pb-0 shrink-0">
              <div className="w-10 h-1 bg-gray-200 rounded-full" />
            </div>

            {/* Sheet header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 shrink-0">
              <div className="flex items-center gap-2">
                {sheetStep !== 'detail' && sheetStep !== 'success' && (
                  <button
                    onClick={() => (sheetStep === 'otp' ? changeAmount() : setSheetStep(
                      sheetStep === 'select_outlet' ? 'detail'
                        : sheetStep === 'confirm' ? (preOutlet ? 'detail' : 'select_outlet')
                        : 'detail'
                    ))}
                    className="p-1 rounded-full hover:bg-gray-100 text-gray-400 -ml-1"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                )}
                <h3 className="text-base font-semibold text-gray-900">
                  {sheetStep === 'detail'        && selectedGift.name}
                  {sheetStep === 'select_outlet' && 'Select Outlet'}
                  {sheetStep === 'confirm'       && 'Confirm Redemption'}
                  {sheetStep === 'otp'           && 'OTP Verification'}
                  {sheetStep === 'success'       && 'Redeemed!'}
                </h3>
              </div>
              {sheetStep !== 'success' && (
                <button onClick={closeSheet} className="p-1.5 rounded-full hover:bg-gray-100 text-gray-400">
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            {/* Body */}
            <div className="overflow-y-auto flex-1">

              {/* ─── Detail view ─── */}
              {sheetStep === 'detail' && (
                <>
                  {/* Large image */}
                  <GiftImage gift={selectedGift} size="detail" />

                  <div className="px-5 pb-6 space-y-5">
                    {/* Name + meta */}
                    <div>
                      <div className="flex items-center gap-2 flex-wrap mt-1 mb-1">
                        {/* The real catalogue sends no brand (it is '' unless a static ref has one) —
                            never a lone "·" before the category. */}
                        {selectedGift.brand && (
                          <>
                            <span className="text-xs text-gray-400 font-medium">{selectedGift.brand}</span>
                            <span className="text-gray-200">·</span>
                          </>
                        )}
                        <span className="text-xs text-gray-400">{selectedGift.category}</span>
                        {selectedGift.popular && (
                          <span className="text-[10px] font-bold bg-amber-100 text-amber-600 px-1.5 py-0.5 rounded-full flex items-center gap-0.5">
                            <Star className="h-2.5 w-2.5 fill-amber-400 text-amber-400" /> Popular
                          </span>
                        )}
                        {!selectedGift.available && (
                          <span className="text-[10px] font-bold bg-red-50 text-red-500 px-1.5 py-0.5 rounded-full">
                            Out of Stock
                          </span>
                        )}
                      </div>

                      {/* Points + delivery */}
                      <div className="flex items-center gap-3 p-3.5 bg-gray-50 rounded-2xl mt-3">
                        <div className="flex-1">
                          {isFreeAmountGift(selectedGift) ? (
                            <>
                              <p className="text-2xl font-bold text-[var(--brand-primary)]">You choose the amount</p>
                              <p className="text-xs text-gray-400 mt-0.5">
                                {selectedGift.amountOptions?.length
                                  ? `Available: ${selectedGift.amountOptions.map((a) => `₹${a.toLocaleString('en-IN')}`).join(' · ')}`
                                  : 'Redeemed as a ₹ amount'}
                              </p>
                            </>
                          ) : (
                            <>
                              <p className="text-2xl font-bold text-[var(--brand-primary)]">{selectedGift.points.toLocaleString('en-IN')} pts</p>
                              <p className="text-xs text-gray-400 mt-0.5">Required to redeem</p>
                            </>
                          )}
                        </div>
                        <div className="text-right">
                          <div className="flex items-center gap-1 justify-end text-xs text-gray-500">
                            <Truck className="h-3.5 w-3.5" />
                            Free delivery
                          </div>
                          <p className="text-xs text-gray-400 mt-0.5">Direct to outlet</p>
                        </div>
                      </div>
                    </div>

                    {/* About */}
                    <div>
                      <h3 className="text-sm font-semibold text-gray-900 mb-1.5">About this gift</h3>
                      <p className="text-sm text-gray-600 leading-relaxed">{selectedGift.details}</p>
                    </div>

                    {/* Features */}
                    {selectedGift.features.length > 0 && (
                      <div>
                        <h3 className="text-sm font-semibold text-gray-900 mb-2">Key features</h3>
                        <ul className="space-y-2">
                          {selectedGift.features.map((f, i) => (
                            <li key={i} className="flex items-start gap-2 text-sm text-gray-600">
                              <Zap className="h-3.5 w-3.5 text-[var(--brand-primary)] shrink-0 mt-0.5" />
                              {f}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Trust badges */}
                    <div className="grid grid-cols-2 gap-2">
                      {[
                        { icon: Package, label: 'Genuine product' },
                        { icon: Truck,   label: 'Free delivery' },
                      ].map((b) => (
                        <div key={b.label} className="flex items-center gap-2 p-2.5 bg-gray-50 rounded-xl">
                          <b.icon className="h-4 w-4 text-[var(--brand-primary)] shrink-0" />
                          <span className="text-xs text-gray-500">{b.label}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {/* ─── Select outlet ─── */}
              {sheetStep === 'select_outlet' && (
                <div className="px-5 py-4 space-y-3">
                  {/* Item mini-summary */}
                  <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl mb-2">
                    <GiftImage gift={selectedGift} size="thumb" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-gray-900 truncate">{selectedGift.name}</p>
                      {isFreeAmountGift(selectedGift) ? (
                        <p className="text-xs text-gray-400 font-medium">Amount you enter</p>
                      ) : (
                        <p className="text-xs text-[var(--brand-primary)] font-bold">{selectedGift.points.toLocaleString('en-IN')} pts</p>
                      )}
                    </div>
                  </div>
                  <p className="text-sm text-gray-500">Which outlet is redeeming?</p>
                  {outlets.map((o) => {
                    const canAfford = o.balance >= (selectedGift?.points ?? 0);
                    return (
                      <button
                        key={o.id}
                        onClick={() => canAfford && selectOutlet(o)}
                        disabled={!canAfford}
                        className={`w-full flex items-center gap-3 p-3.5 rounded-xl border text-left transition-colors ${
                          canAfford
                            ? 'border-gray-200 hover:border-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/5 active:scale-[0.99]'
                            : 'border-gray-100 bg-gray-50 opacity-50 cursor-not-allowed'
                        }`}
                      >
                        <div className="w-9 h-9 rounded-full bg-[var(--brand-primary)]/10 flex items-center justify-center shrink-0">
                          <span className="text-[var(--brand-primary)] font-bold text-xs">
                            {o.name.split(' ').map((w) => w[0]).join('').slice(0, 2)}
                          </span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">{o.name}</p>
                          <p className="text-xs text-gray-400">
                            Balance: {o.balance < 0 ? `−${(-o.balance).toLocaleString('en-IN')}` : o.balance.toLocaleString('en-IN')} pts
                          </p>
                        </div>
                        {/* Owner decision 2 (2026-11-19): a negative balance is said plainly, never as a shortfall to top up */}
                        {!canAfford && (
                          <span className="text-[10px] text-red-400 shrink-0 font-medium">
                            {o.balance < 0 ? 'Not available while the balance is negative' : 'Insufficient'}
                          </span>
                        )}
                        {canAfford && <ChevronRight className="h-4 w-4 text-gray-300 shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* ─── Confirm ─── */}
              {sheetStep === 'confirm' && redeem.outlet && (
                <div className="px-5 py-4 space-y-4">
                  {/* Item mini-summary */}
                  <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl">
                    <GiftImage gift={selectedGift} size="thumb" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-gray-900 truncate">{selectedGift.name}</p>
                      {isFreeAmountGift(selectedGift) ? (
                        <p className="text-xs text-gray-400 font-medium">Amount you enter</p>
                      ) : (
                        <p className="text-xs text-[var(--brand-primary)] font-bold">{selectedGift.points.toLocaleString('en-IN')} pts</p>
                      )}
                    </div>
                  </div>

                  {/* Outlet */}
                  <div className="flex items-center gap-3 p-3.5 bg-blue-50 rounded-xl">
                    <div className="w-9 h-9 rounded-full bg-[var(--brand-primary)]/15 flex items-center justify-center shrink-0">
                      <span className="text-[var(--brand-primary)] font-bold text-xs">
                        {redeem.outlet.name.split(' ').map((w) => w[0]).join('').slice(0, 2)}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-gray-500">Outlet</p>
                      <p className="text-sm font-semibold text-gray-900">{redeem.outlet.name}</p>
                    </div>
                  </div>

                  {/* FREE_AMOUNT (variable) → collect the ₹ amount; FIXED → show the points breakdown. */}
                  {isFreeAmountGift(selectedGift) && selectedGift.amountOptions?.length ? (
                    /* Hubble "choose from amounts": one button per amount (+ its points); no typing. */
                    <div className="bg-gray-50 rounded-xl p-4 space-y-2">
                      <p className="text-xs text-gray-500">Choose an amount</p>
                      <div className="grid grid-cols-3 gap-2" role="group" aria-label="Voucher amount">
                        {selectedGift.amountOptions.map((amt) => {
                          const selected = Number(redeem.amount) === amt;
                          const pts = conversionRate != null ? pointsForAmount(amt, conversionRate) : null;
                          const tooLow = amt < minVoucherAmount;
                          return (
                            <button
                              key={amt}
                              type="button"
                              aria-pressed={selected}
                              aria-label={`₹${amt.toLocaleString('en-IN')}${pts != null ? `, ${pts.toLocaleString('en-IN')} points` : ''}${tooLow ? ' (below the minimum)' : ''}`}
                              disabled={tooLow || redeem.otpSent}
                              onClick={() => setRedeem((r) => ({ ...r, amount: String(amt), error: '' }))}
                              className={`rounded-xl border-2 px-2 py-2 text-center transition-all disabled:opacity-40 ${
                                selected ? 'border-[var(--brand-primary)] bg-white' : 'border-gray-200 bg-white hover:border-gray-300'
                              }`}
                            >
                              <span className="block text-sm font-bold text-gray-900">₹{amt.toLocaleString('en-IN')}</span>
                              {pts != null && (
                                <span className={`block text-[10px] ${pts > redeem.outlet!.balance ? 'text-red-500' : 'text-gray-500'}`}>
                                  {pts.toLocaleString('en-IN')} pts
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                      <div className="flex items-center justify-between pt-1">
                        <span className="text-xs text-gray-500">Current balance</span>
                        <span className="text-sm text-gray-800">{redeem.outlet.balance.toLocaleString('en-IN')} pts</span>
                      </div>
                    </div>
                  ) : isFreeAmountGift(selectedGift) ? (
                    <div className="bg-gray-50 rounded-xl p-4 space-y-2">
                      <label className="block text-xs text-gray-500" htmlFor="redeem-amount">Amount to redeem (₹)</label>
                      {band && !amountUnredeemable && (
                        <p id="redeem-amount-band" className="text-xs text-gray-400" data-testid="redeem-amount-band">
                          ({band.max != null ? `min ${fmtInr(band.min)}, max ${fmtInr(band.max)}` : `min ${fmtInr(band.min)}`})
                        </p>
                      )}
                      {limitsLoading && (
                        <p id="redeem-amount-limits" className="text-xs text-gray-400" data-testid="redeem-limits-loading">
                          Loading redemption limits…
                        </p>
                      )}
                      {limitsFailed && (
                        <p id="redeem-amount-limits" role="alert" className="text-xs text-red-500 flex items-center gap-1 flex-wrap" data-testid="redeem-limits-error">
                          <AlertTriangle className="h-3 w-3" />Couldn&apos;t load redemption limits —{' '}
                          <button type="button" onClick={loadSettings} className="font-medium underline">try again</button>
                        </p>
                      )}
                      {amountUnredeemable && (
                        <p id="redeem-amount-unavailable" data-testid="redeem-unredeemable" className="text-xs text-red-500 flex items-center gap-1">
                          <AlertTriangle className="h-3 w-3" />This voucher can&apos;t be redeemed right now
                        </p>
                      )}
                      <input
                        id="redeem-amount"
                        value={redeem.amount}
                        // Whole rupees only: "750.5" / "750,5" / a pasted decimal stay visible and are
                        // invalid on commit ("Check the amount — whole rupees only"), never shrunk.
                        {...wholeRupeeInputProps(
                          (v) => setRedeem((r) => ({ ...r, amount: v, amountFlagged: false, error: '' })),
                          { onCommit: (bad) => setRedeem((r) => ({ ...r, amountFlagged: bad })), value: redeem.amount },
                        )}
                        // Locked once the OTP is sent — the order already carries this amount —
                        // and when no amount can pass the band.
                        disabled={redeem.otpSent || amountUnredeemable}
                        aria-invalid={amountInvalidShown || !!amountHint ? true : undefined}
                        // The band ("min ₹X, max ₹Y") always describes the field; an error/hint is added to it.
                        aria-describedby={
                          amountUnredeemable
                            ? 'redeem-amount-unavailable'
                            : [band ? 'redeem-amount-band' : limitsLoading || limitsFailed ? 'redeem-amount-limits' : null, amountInvalidShown ? 'redeem-amount-error' : amountHint ? 'redeem-amount-hint' : null]
                                .filter(Boolean).join(' ') || undefined
                        }
                        placeholder="Enter ₹ amount"
                        className={`w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)] ${amountInvalidShown || amountHint ? 'border-red-300' : 'border-gray-300'}`}
                      />
                      {amountInvalidShown && (
                        <p id="redeem-amount-error" role="alert" className="text-xs text-red-500">{WHOLE_RUPEE_INVALID_MESSAGE}</p>
                      )}
                      <div aria-live="polite">
                        {amountHint && !amountInvalidShown && (
                          <p id="redeem-amount-hint" className="text-xs text-red-500">{amountHint}</p>
                        )}
                      </div>
                      <p className="text-[11px] text-gray-400">
                        Points are calculated from this amount at the tenant conversion rate on confirmation.
                      </p>
                      <div className="flex items-center justify-between pt-1">
                        <span className="text-xs text-gray-500">Current balance</span>
                        <span className="text-sm text-gray-800">{redeem.outlet.balance.toLocaleString('en-IN')} pts</span>
                      </div>
                    </div>
                  ) : (
                    <div className="bg-gray-50 rounded-xl p-4 space-y-2">
                      {[
                        { label: 'Current balance',  value: redeem.outlet.balance.toLocaleString('en-IN'),                                 color: 'text-gray-800' },
                        { label: 'Points to deduct', value: `− ${selectedGift.points.toLocaleString('en-IN')}`,                            color: 'text-red-500'  },
                        { label: 'Balance after',    value: (redeem.outlet.balance - selectedGift.points).toLocaleString('en-IN'),          color: 'text-[var(--brand-primary)] font-bold' },
                      ].map((r) => (
                        <div key={r.label} className="flex items-center justify-between">
                          <span className="text-xs text-gray-500">{r.label}</span>
                          <span className={`text-sm ${r.color}`}>{r.value} pts</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* PHYSICAL_GIFT → delivery address, pre-filled from THIS outlet's address on file. */}
                  {isPhysicalGift(selectedGift) && (
                    <div className="space-y-3" data-testid="delivery-address-form">
                      <div>
                        <p className="text-sm font-semibold text-gray-900">Delivery address</p>
                        <p className="text-xs text-gray-500">Who this is for and where to deliver it</p>
                        {showPrefillHint && (
                          <p id="addr-prefill-hint" className="text-xs text-gray-500">From the outlet address</p>
                        )}
                      </div>
                      <div>
                        <label className="text-xs font-medium text-gray-600 block mb-1" htmlFor="recipient-name">Recipient name *</label>
                        <input
                          id="recipient-name"
                          className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
                          placeholder="Full name for the parcel"
                          value={recipientName}
                          onChange={(e) => {
                            const v = e.target.value;
                            setRedeem((r) => ({ ...r, error: '', recipientTouched: true, recipientName: v }));
                          }}
                        />
                      </div>
                      {([
                        { key: 'line1',   label: 'Street address *', placeholder: 'Shop no., street name' },
                        { key: 'city',    label: 'City *',           placeholder: 'City' },
                        { key: 'state',   label: 'State',            placeholder: 'State' },
                        { key: 'pincode', label: 'Pincode *',        placeholder: '400001' },
                      ] as { key: keyof AddressForm; label: string; placeholder: string }[]).map((f) => (
                        <div key={f.key}>
                          <label className="text-xs font-medium text-gray-600 block mb-1" htmlFor={`addr-${f.key}`}>{f.label}</label>
                          <input
                            id={`addr-${f.key}`}
                            aria-describedby={showPrefillHint ? 'addr-prefill-hint' : undefined}
                            inputMode={f.key === 'pincode' ? 'numeric' : undefined}
                            className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
                            placeholder={f.placeholder}
                            value={deliveryAddress[f.key]}
                            onChange={(e) => setAddressField(f.key, e.target.value)}
                          />
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex items-start gap-2 p-3 bg-amber-50 rounded-xl border border-amber-100">
                    <Smartphone className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-700">
                      An OTP will be sent to <strong>{maskedMobile(redeem.outlet.mobile)}</strong> for verification.
                    </p>
                  </div>

                  {redeem.error && (
                    <p className="text-xs text-red-600 text-center">{redeem.error}</p>
                  )}

                  <Button
                    variant="primary"
                    className="w-full"
                    loading={redeem.otpSending}
                    // An INVALID amount text never disables the button (it can't say why): the tap
                    // commits and shows "Check the amount" instead of sending.
                    disabled={
                      // Limits unknown (/me pending or failed) → nothing can be checked → disabled.
                      limitsLoading || limitsFailed || amountUnredeemable || belowMin || aboveMax ||
                      (isFreeAmountGift(selectedGift) &&
                      (selectedGift.amountOptions?.length
                        ? !selectedGift.amountOptions.includes(Number(redeem.amount))
                        : !isWholeRupeeInvalid(redeem.amount) && !((wholeRupeeAmount(redeem.amount) ?? 0) > 0)))
                    }
                    onClick={sendOtp}
                  >
                    {limitsLoading
                      ? 'Loading limits…'
                      : limitsFailed
                      ? 'Limits unavailable'
                      : amountUnredeemable
                      ? 'Not available'
                      : belowMin
                      ? `Min ${fmtInr(band!.min)} required`
                      : aboveMax
                      ? `Max ${fmtInr(band!.max ?? 0)} allowed`
                      : <>Send OTP &amp; Proceed</>}
                  </Button>

                  {!preOutlet && (
                    <button
                      onClick={() => setSheetStep('select_outlet')}
                      className="w-full text-center text-sm text-gray-400 hover:text-gray-600 py-1"
                    >
                      Change outlet
                    </button>
                  )}
                </div>
              )}

              {/* ─── OTP ─── */}
              {sheetStep === 'otp' && redeem.outlet && (
                <div className="px-5 py-4 space-y-5">
                  <div className="text-center space-y-1">
                    <div className="w-14 h-14 bg-[var(--brand-primary)]/10 rounded-full flex items-center justify-center mx-auto">
                      <Smartphone className="h-7 w-7 text-[var(--brand-primary)]" />
                    </div>
                    <p className="text-sm text-gray-700 font-medium">OTP sent to outlet</p>
                    <p className="text-xs text-gray-400">
                      Code sent to <strong>{maskedMobile(redeem.outlet.mobile)}</strong>
                    </p>
                    <p className="text-[10px] text-gray-400">Ask the outlet owner to share the OTP received</p>
                    {redeem.sentAmount != null && (
                      <p className="text-xs text-gray-600">
                        Amount: <strong>₹{redeem.sentAmount.toLocaleString('en-IN')}</strong>{' '}
                        <button
                          type="button"
                          onClick={changeAmount}
                          className="text-[var(--brand-primary)] font-medium underline"
                        >
                          Change amount
                        </button>
                      </p>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs text-gray-500 font-medium">Enter 6-digit OTP</label>
                    <input
                      ref={inputRef}
                      type="number"
                      inputMode="numeric"
                      maxLength={6}
                      value={redeem.otp}
                      onChange={(e) => {
                        const v = e.target.value.replace(/\D/g, '').slice(0, 6);
                        setRedeem((r) => ({ ...r, otp: v, error: '' }));
                      }}
                      placeholder="· · · · · ·"
                      className="w-full text-center text-2xl font-bold tracking-[0.5em] border border-gray-200 rounded-xl py-3 px-4 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
                    />
                    {redeem.error && (
                      <p className="flex items-center gap-1.5 text-xs text-red-500">
                        <AlertTriangle className="h-3.5 w-3.5" /> {redeem.error}
                      </p>
                    )}
                  </div>

                  <Button variant="primary" className="w-full" loading={redeem.verifying} onClick={verifyOtp}>
                    Verify &amp; Redeem
                  </Button>

                  <div className="text-center">
                    {redeem.otpResendCountdown > 0 ? (
                      <p className="text-xs text-gray-400">Resend OTP in <strong>{redeem.otpResendCountdown}s</strong></p>
                    ) : (
                      <button
                        onClick={sendOtp}
                        disabled={redeem.otpSending}
                        className="flex items-center gap-1.5 text-xs text-[var(--brand-primary)] font-medium mx-auto hover:underline disabled:opacity-50"
                      >
                        {redeem.otpSending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                        Resend OTP
                      </button>
                    )}
                  </div>

                  <p className="text-[10px] text-center text-gray-300">
                    The OTP was sent to the outlet&apos;s registered mobile.
                  </p>
                </div>
              )}

              {/* ─── Success ─── */}
              {sheetStep === 'success' && redeem.outlet && (
                <div className="flex flex-col items-center gap-4 py-8 px-5 text-center">
                  <div className="w-20 h-20 bg-[var(--brand-primary)]/10 rounded-full flex items-center justify-center">
                    <CheckCircle className="h-10 w-10 text-[var(--brand-primary)]" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-lg font-bold text-gray-900">Redemption Successful!</p>
                    <p className="text-sm text-gray-500">
                      <strong>{selectedGift.name}</strong> redeemed for <strong>{redeem.outlet.name}</strong>
                    </p>
                  </div>

                  <div className="text-5xl">{selectedGift.emoji}</div>

                  {isFreeAmountGift(selectedGift) ? (
                    <div className="w-full bg-gray-50 rounded-xl p-4 text-left space-y-2">
                      {[
                        { label: 'Item',            value: selectedGift.name },
                        // The amount the ORDER was created with (frozen at OTP-send), never the live field.
                        { label: 'Amount',          value: redeem.sentAmount != null && redeem.sentAmount > 0 ? `₹${redeem.sentAmount.toLocaleString('en-IN')}` : '—' },
                        // The SERVER's requiredPoints frozen at OTP-send (never re-derived from the field).
                        ...(redeem.sentPoints != null
                          ? [
                              { label: 'Points deducted', value: `−${redeem.sentPoints.toLocaleString('en-IN')} pts` },
                              { label: 'New balance',     value: `${(redeem.outlet.balance - redeem.sentPoints).toLocaleString('en-IN')} pts` },
                            ]
                          : [{ label: 'Current balance', value: `${redeem.outlet.balance.toLocaleString('en-IN')} pts` }]),
                      ].map((r) => (
                        <div key={r.label} className="flex justify-between text-sm">
                          <span className="text-gray-500">{r.label}</span>
                          <span className="font-medium text-gray-900">{r.value}</span>
                        </div>
                      ))}
                      <p className="text-[11px] text-gray-400">Points deducted at the conversion rate on confirmation</p>
                    </div>
                  ) : (
                    <div className="w-full bg-gray-50 rounded-xl p-4 text-left space-y-2">
                      {[
                        { label: 'Item',            value: selectedGift.name },
                        { label: 'Points deducted', value: `−${(redeem.sentPoints ?? selectedGift.points).toLocaleString('en-IN')}`, cls: 'text-red-500 font-bold' },
                        { label: 'New balance',     value: `${(redeem.outlet.balance - (redeem.sentPoints ?? selectedGift.points)).toLocaleString('en-IN')} pts`, cls: 'text-[var(--brand-primary)] font-bold' },
                      ].map((r) => (
                        <div key={r.label} className="flex justify-between text-sm">
                          <span className="text-gray-500">{r.label}</span>
                          <span className={`font-medium text-gray-900 ${r.cls ?? ''}`}>{r.value}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <p className="text-xs text-gray-400">Confirmation SMS sent to outlet&apos;s registered number.</p>

                  <div className="w-full space-y-2">
                    <Button variant="primary" className="w-full" onClick={closeSheet}>Done</Button>
                    <button
                      onClick={() => {
                        const savedOutlet = redeem.outlet;
                        setRedeem({ ...INITIAL_REDEEM, outlet: savedOutlet });
                        setSheetStep('detail');
                      }}
                      className="w-full text-sm text-[var(--brand-primary)] font-medium py-2 hover:underline"
                    >
                      Redeem another gift for this outlet
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* ── Sticky bottom CTA — only on detail step ── */}
            {sheetStep === 'detail' && (
              <div className="shrink-0 px-5 py-4 border-t border-gray-100 bg-white">
                {selectedGift.available ? (
                  <Button
                    variant="primary"
                    className="w-full text-base py-3"
                    onClick={() => setSheetStep(preOutlet ? 'confirm' : 'select_outlet')}
                  >
                    {isFreeAmountGift(selectedGift)
                      ? 'Redeem'
                      : `Redeem for ${selectedGift.points.toLocaleString('en-IN')} pts`}
                  </Button>
                ) : (
                  <Button variant="outline" className="w-full" disabled>Out of Stock</Button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Page wrapper ───────────────────────────────────────────────────────────── */

export default function CataloguePage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center min-h-48"><Spinner size="lg" /></div>}>
      <CatalogueInner />
    </Suspense>
  );
}
