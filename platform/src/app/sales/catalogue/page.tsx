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
import { type GiftCatalogueItem, loadGifts } from '@/lib/gifts';

type GiftItem = GiftCatalogueItem;

/* ─── Outlet mock data ───────────────────────────────────────────────────────── */

interface Outlet {
  id: string;
  kycId: string;
  name: string;
  mobile: string;
  balance: number;
}

const OUTLET_MAP: Record<string, string> = { o1: 'k1', o2: 'k2', o3: 'k3', o4: 'k4', o5: 'k5' };

const OUTLETS: Outlet[] = [
  { id: 'o1', kycId: 'k1', name: 'Kumar General Store', mobile: '9876543210', balance: 3_240 },
  { id: 'o2', kycId: 'k2', name: 'Sharma Kirana',       mobile: '9765432109', balance:   820 },
  { id: 'o3', kycId: 'k3', name: 'Patel Grocery',       mobile: '9654321098', balance:   145 },
  { id: 'o4', kycId: 'k4', name: 'Singh Supermart',     mobile: '9543210987', balance: 5_900 },
  { id: 'o5', kycId: 'k5', name: 'Mehta Provisions',    mobile: '9432109876', balance: 1_060 },
];

/* ─── Flow types ─────────────────────────────────────────────────────────────── */

type SheetStep = 'detail' | 'select_outlet' | 'confirm' | 'otp' | 'success';

interface RedeemState {
  outlet: Outlet | null;
  otpSending: boolean;
  otpSent: boolean;
  otp: string;
  verifying: boolean;
  error: string;
  otpResendCountdown: number;
}

const INITIAL_REDEEM: RedeemState = {
  outlet: null, otpSending: false, otpSent: false, otp: '',
  verifying: false, error: '', otpResendCountdown: 0,
};

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
  const searchParams   = useSearchParams();
  const preselectedId  = searchParams.get('outletId') ?? '';
  const preselectedKyc = OUTLET_MAP[preselectedId] ?? preselectedId;
  const preOutlet      = OUTLETS.find((o) => o.kycId === preselectedKyc || o.id === preselectedId) ?? null;

  const [gifts,        setGifts]        = useState<GiftItem[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [category,     setCategory]     = useState('All');
  const [search,       setSearch]       = useState('');

  // Sheet state
  const [selectedGift, setSelectedGift] = useState<GiftItem | null>(null);
  const [sheetStep,    setSheetStep]    = useState<SheetStep | null>(null);
  const [redeem,       setRedeem]       = useState<RedeemState>({ ...INITIAL_REDEEM, outlet: preOutlet });

  const otpRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setGifts(loadGifts()); // includes all gifts (available + out-of-stock shown to sales team)
      setLoading(false);
    }, 350);
    return () => clearTimeout(t);
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
  };

  const closeSheet = () => {
    setSheetStep(null);
    setTimeout(() => { setSelectedGift(null); setRedeem({ ...INITIAL_REDEEM, outlet: preOutlet }); }, 300);
  };

  /* ── Redemption handlers ── */

  const selectOutlet = (outlet: Outlet) => {
    setRedeem((r) => ({ ...r, outlet }));
    setSheetStep('confirm');
  };

  const sendOtp = async () => {
    setRedeem((r) => ({ ...r, otpSending: true, error: '' }));
    await new Promise((res) => setTimeout(res, 1_200));
    setRedeem((r) => ({ ...r, otpSending: false, otpSent: true, otpResendCountdown: 30 }));
    setSheetStep('otp');
  };

  const verifyOtp = async () => {
    if (redeem.otp.length < 6) {
      setRedeem((r) => ({ ...r, error: 'Please enter the 6-digit OTP.' }));
      return;
    }
    setRedeem((r) => ({ ...r, verifying: true, error: '' }));
    await new Promise((res) => setTimeout(res, 1_200));
    if (redeem.otp === '999999') {
      setRedeem((r) => ({ ...r, verifying: false, error: 'Invalid OTP. Please try again.' }));
    } else {
      setRedeem((r) => ({ ...r, verifying: false }));
      setSheetStep('success');
    }
  };

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

          {/* Category chips */}
          <div className="flex gap-1.5 flex-nowrap overflow-x-auto pb-0.5" style={{ scrollbarWidth: 'none' }}>
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
                      <span className="text-sm font-bold text-[var(--brand-primary)]">{gift.points.toLocaleString()} pts</span>
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
                    onClick={() => setSheetStep(
                      sheetStep === 'select_outlet' ? 'detail'
                        : sheetStep === 'confirm' ? (preOutlet ? 'detail' : 'select_outlet')
                        : sheetStep === 'otp' ? 'confirm'
                        : 'detail'
                    )}
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
                        <span className="text-xs text-gray-400 font-medium">{selectedGift.brand}</span>
                        <span className="text-gray-200">·</span>
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
                          <p className="text-2xl font-bold text-[var(--brand-primary)]">{selectedGift.points.toLocaleString()} pts</p>
                          <p className="text-xs text-gray-400 mt-0.5">Required to redeem</p>
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
                      <p className="text-xs text-[var(--brand-primary)] font-bold">{selectedGift.points.toLocaleString()} pts</p>
                    </div>
                  </div>
                  <p className="text-sm text-gray-500">Which outlet is redeeming?</p>
                  {OUTLETS.map((o) => {
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
                          <p className="text-xs text-gray-400">Balance: {o.balance.toLocaleString()} pts</p>
                        </div>
                        {!canAfford && <span className="text-[10px] text-red-400 shrink-0 font-medium">Insufficient</span>}
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
                      <p className="text-xs text-[var(--brand-primary)] font-bold">{selectedGift.points.toLocaleString()} pts</p>
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

                  {/* Points breakdown */}
                  <div className="bg-gray-50 rounded-xl p-4 space-y-2">
                    {[
                      { label: 'Current balance',  value: redeem.outlet.balance.toLocaleString(),                                 color: 'text-gray-800' },
                      { label: 'Points to deduct', value: `− ${selectedGift.points.toLocaleString()}`,                            color: 'text-red-500'  },
                      { label: 'Balance after',    value: (redeem.outlet.balance - selectedGift.points).toLocaleString(),          color: 'text-[var(--brand-primary)] font-bold' },
                    ].map((r) => (
                      <div key={r.label} className="flex items-center justify-between">
                        <span className="text-xs text-gray-500">{r.label}</span>
                        <span className={`text-sm ${r.color}`}>{r.value} pts</span>
                      </div>
                    ))}
                  </div>

                  <div className="flex items-start gap-2 p-3 bg-amber-50 rounded-xl border border-amber-100">
                    <Smartphone className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-700">
                      An OTP will be sent to <strong>{maskedMobile(redeem.outlet.mobile)}</strong> for verification.
                    </p>
                  </div>

                  <Button variant="primary" className="w-full" loading={redeem.otpSending} onClick={sendOtp}>
                    Send OTP &amp; Proceed
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
                    Demo: any 6 digits work (avoid 999999 to test invalid OTP)
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

                  <div className="w-full bg-gray-50 rounded-xl p-4 text-left space-y-2">
                    {[
                      { label: 'Item',            value: selectedGift.name },
                      { label: 'Points deducted', value: `−${selectedGift.points.toLocaleString()}`, cls: 'text-red-500 font-bold' },
                      { label: 'New balance',     value: `${(redeem.outlet.balance - selectedGift.points).toLocaleString()} pts`, cls: 'text-[var(--brand-primary)] font-bold' },
                    ].map((r) => (
                      <div key={r.label} className="flex justify-between text-sm">
                        <span className="text-gray-500">{r.label}</span>
                        <span className={`font-medium text-gray-900 ${r.cls ?? ''}`}>{r.value}</span>
                      </div>
                    ))}
                  </div>

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
                    Redeem for {selectedGift.points.toLocaleString()} pts
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
