'use client';

import React, { useState, useEffect, useMemo } from 'react';
import {
  Gift, Search, CheckCircle, MapPin,
  X, Shield, Package, Truck, Zap, Heart,
  Banknote, CreditCard, Tag, ChevronRight,
  AlertCircle, Phone,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast } from '@/components/ui/toast';
import { formatPoints } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { type GiftCatalogueItem, loadGifts } from '@/lib/gifts';
import { usePartnerSession } from '@/lib/partner-session';
import { getGifsySettings } from '@/lib/gifsy-settings';
import { saveRedemption } from '@/lib/redemption-store';

/* ─── Helpers ─────────────────────────────────────────────────────────────── */

const PHYSICAL_CATEGORIES = ['Electronics', 'Home & Kitchen', 'Personal Appliances', 'Health', 'Travel'];

function deliveryLabel(category: string): string {
  return category === 'Vouchers' ? 'Instant via WhatsApp' : '5–7 business days';
}

function fmtInr(n: number) { return `₹${n.toLocaleString('en-IN')}`; }

/* ─── Image / emoji display ──────────────────────────────────────────────── */

interface GiftImageProps {
  gift: Pick<GiftCatalogueItem, 'imageDataUrl' | 'emoji' | 'gradientFrom' | 'gradientTo'>;
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

function GiftDetailSheet({
  gift, onClose, myBalance, onWishlist, isWishlisted, onRedeemed,
}: {
  gift: GiftCatalogueItem;
  onClose: () => void;
  myBalance: number;
  onWishlist: (id: string) => void;
  isWishlisted: boolean;
  onRedeemed: (pts: number, description: string) => void;
}) {
  const toast = useToast();
  const [step,       setStep]       = useState<RedemptionStep>('detail');
  const [address,    setAddress]    = useState({ line1: '', city: '', state: '', pincode: '' });
  const [otp,        setOtp]        = useState('');
  const [submitting, setSubmitting] = useState(false);
  const canAfford = myBalance >= gift.points;
  const delivery  = deliveryLabel(gift.category);
  const needMore  = !canAfford ? gift.points - myBalance : 0;

  const handleSendOtp = async () => {
    if (!address.line1 || !address.city || !address.pincode) {
      toast.error('Please fill in all required address fields'); return;
    }
    setSubmitting(true);
    await new Promise(r => setTimeout(r, 800));
    setSubmitting(false);
    setStep('otp');
  };

  const handleConfirm = async () => {
    if (otp.length < 6) { toast.error('Enter the OTP'); return; }
    setSubmitting(true);
    await new Promise(r => setTimeout(r, 1000));
    setSubmitting(false);
    setStep('success');
    onRedeemed(gift.points, `Redemption – ${gift.name}`);
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={step === 'detail' ? onClose : undefined} />
      <div className="relative bg-white rounded-t-2xl max-h-[92vh] flex flex-col shadow-2xl">
        <div className="flex justify-center pt-3 pb-0 shrink-0">
          <div className="w-10 h-1 bg-gray-200 rounded-full" />
        </div>
        <button onClick={onClose} className="absolute top-4 right-4 z-10 w-8 h-8 bg-black/10 hover:bg-black/20 rounded-full flex items-center justify-center transition-colors">
          <X className="h-4 w-4 text-gray-700" />
        </button>
        <button onClick={() => onWishlist(gift.id)} className="absolute top-4 right-14 z-10 w-8 h-8 bg-black/10 hover:bg-black/20 rounded-full flex items-center justify-center transition-colors">
          <Heart className={`h-4 w-4 ${isWishlisted ? 'fill-red-500 text-red-500' : 'text-gray-700'}`} />
        </button>

        <div className="overflow-y-auto flex-1">
          {step === 'detail' && (
            <>
              <GiftImage gift={gift} size="large" />
              <div className="px-5 pb-6 space-y-5">
                <div>
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="text-xs text-gray-400 font-medium">{gift.brand}</span>
                    <span className="text-gray-200">·</span>
                    <span className="text-xs text-gray-400">{gift.category}</span>
                    {gift.popular && <Badge variant="warning" className="text-[10px]">Popular</Badge>}
                  </div>
                  <h2 className="text-lg font-bold text-gray-900 leading-snug">{gift.name}</h2>
                </div>
                <div className="flex items-center gap-3 p-3.5 bg-gray-50 rounded-2xl">
                  <div className="flex-1">
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
                <div><h3 className="text-sm font-semibold text-gray-900 mb-1.5">About this reward</h3><p className="text-sm text-gray-600 leading-relaxed">{gift.details}</p></div>
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
              </div>
            </>
          )}

          {step === 'form' && (
            <div className="px-5 pt-4 pb-6 space-y-4">
              <h3 className="text-base font-bold text-gray-900">Delivery Address</h3>
              <p className="text-xs text-gray-500">Enter where you want this delivered</p>
              {[
                { key: 'line1',   label: 'Street address *', placeholder: 'Shop no., street name' },
                { key: 'city',    label: 'City *',           placeholder: 'City' },
                { key: 'state',   label: 'State',            placeholder: 'State' },
                { key: 'pincode', label: 'Pincode *',        placeholder: '400001' },
              ].map(f => (
                <div key={f.key}>
                  <label className="text-xs font-medium text-gray-600 block mb-1">{f.label}</label>
                  <input className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
                    placeholder={f.placeholder}
                    value={(address as Record<string,string>)[f.key]}
                    onChange={e => setAddress(prev => ({ ...prev, [f.key]: e.target.value }))} />
                </div>
              ))}
            </div>
          )}

          {step === 'otp' && (
            <div className="px-5 pt-4 pb-6 space-y-4">
              <h3 className="text-base font-bold text-gray-900">Confirm Redemption</h3>
              <div className="bg-gray-50 rounded-xl p-4 space-y-2">
                <div className="flex justify-between text-sm"><span className="text-gray-500">Item</span><span className="font-semibold">{gift.name}</span></div>
                <div className="flex justify-between text-sm"><span className="text-gray-500">Points</span><span className="font-semibold text-[var(--brand-primary)]">{formatPoints(gift.points)} pts</span></div>
                <div className="flex justify-between text-sm"><span className="text-gray-500">Delivery to</span><span className="font-medium text-right max-w-[180px]">{address.line1}, {address.city}</span></div>
              </div>
              <p className="text-xs text-gray-500 flex items-center gap-1.5"><Phone className="h-3.5 w-3.5" /> OTP sent to your registered mobile</p>
              <input className="w-full border border-gray-200 rounded-xl px-3 py-3 text-center font-mono text-lg tracking-[0.4em] focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
                placeholder="· · · · · ·" maxLength={6} value={otp}
                onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" />
            </div>
          )}

          {step === 'success' && (
            <div className="flex flex-col items-center justify-center py-12 px-5 gap-4 text-center">
              <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center">
                <CheckCircle className="h-8 w-8 text-emerald-600" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-gray-900">Redemption Confirmed!</h3>
                <p className="text-sm text-gray-500 mt-1">{gift.name} is on its way. {delivery}.</p>
                <p className="text-xs text-gray-400 mt-1">You will receive a WhatsApp confirmation shortly.</p>
              </div>
            </div>
          )}
        </div>

        <div className="px-5 pb-6 pt-3 shrink-0 border-t border-gray-100">
          {step === 'detail' && (
            <Button variant="primary" className="w-full" disabled={!canAfford || !gift.available}
              onClick={() => setStep('form')}>
              {!gift.available ? 'Out of Stock' : !canAfford ? `Need ${formatPoints(needMore)} more pts` : 'Redeem Now'}
            </Button>
          )}
          {step === 'form' && (
            <div className="flex gap-3">
              <Button variant="outline" className="flex-1" onClick={() => setStep('detail')}>← Back</Button>
              <Button variant="primary" className="flex-1" loading={submitting} onClick={handleSendOtp}>Send OTP</Button>
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
    </div>
  );
}

/* ─── Voucher redeem sheet ────────────────────────────────────────────────── */

function VoucherRedeemSheet({
  voucher, onClose, myBalance, minFreeAmount, conversionRate, onRedeemed,
}: {
  voucher: GiftCatalogueItem;
  onClose: () => void;
  myBalance: number;
  minFreeAmount: number;
  conversionRate: number;
  onRedeemed: (pts: number, description: string) => void;
}) {
  const toast = useToast();
  const [amount,     setAmount]     = useState('');
  const [otp,        setOtp]        = useState('');
  const [otpSent,    setOtpSent]    = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [success,    setSuccess]    = useState(false);

  const isFixed = voucher.voucherType === 'FIXED';
  const fixedPts = voucher.fixedAmount ?? 0;
  const freeAmt  = parseInt(amount, 10) || 0;
  const ptsNeeded = isFixed ? fixedPts : Math.ceil(freeAmt / conversionRate);
  const canAfford = myBalance >= ptsNeeded && (isFixed || freeAmt >= minFreeAmount);
  const amountError = !isFixed && freeAmt > 0 && freeAmt < minFreeAmount
    ? `Minimum redemption is ${fmtInr(minFreeAmount)}`
    : freeAmt > myBalance * conversionRate
    ? `Exceeds your balance (max ${fmtInr(myBalance * conversionRate)})`
    : '';

  const handleSendOtp = async () => {
    setSubmitting(true);
    await new Promise(r => setTimeout(r, 800));
    setSubmitting(false);
    setOtpSent(true);
  };

  const handleConfirm = async () => {
    if (otp.length < 6) { toast.error('Enter the OTP'); return; }
    setSubmitting(true);
    await new Promise(r => setTimeout(r, 1000));
    setSubmitting(false);
    const desc = isFixed
      ? `Redemption – ${voucher.brand} voucher`
      : `Redemption – ${voucher.brand} voucher ₹${freeAmt}`;
    onRedeemed(ptsNeeded, desc);
    setSuccess(true);
  };

  if (success) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col justify-end">
        <div className="absolute inset-0 bg-black/50" onClick={onClose} />
        <div className="relative bg-white rounded-t-2xl p-8 flex flex-col items-center gap-4 text-center shadow-2xl">
          <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center">
            <CheckCircle className="h-8 w-8 text-emerald-600" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-gray-900">Voucher Sent!</h3>
            <p className="text-sm text-gray-500 mt-1">
              {isFixed ? `${voucher.brand} voucher (${fmtInr(fixedPts)})` : `${voucher.brand} voucher (${fmtInr(freeAmt)})`} sent to your registered WhatsApp number.
            </p>
            <p className="text-xs text-gray-400 mt-1">{ptsNeeded} pts deducted from your balance.</p>
          </div>
          <Button variant="primary" className="w-full" onClick={onClose}>Done</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-t-2xl max-h-[80vh] flex flex-col shadow-2xl">
        <div className="flex justify-center pt-3"><div className="w-10 h-1 bg-gray-200 rounded-full" /></div>
        <button onClick={onClose} className="absolute top-4 right-4 w-8 h-8 bg-black/10 rounded-full flex items-center justify-center">
          <X className="h-4 w-4 text-gray-700" />
        </button>

        <div className="overflow-y-auto flex-1 px-5 pt-4 pb-2 space-y-4">
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
            <p className="text-base font-bold text-emerald-700">{formatPoints(myBalance)} pts = {fmtInr(myBalance * conversionRate)}</p>
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

          {/* OTP field */}
          {otpSent && (
            <div className="space-y-2">
              <p className="text-xs text-gray-500 flex items-center gap-1"><Phone className="h-3.5 w-3.5" /> OTP sent to your registered mobile</p>
              <input
                className="w-full border border-gray-200 rounded-xl px-3 py-3 text-center font-mono text-lg tracking-[0.4em] focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20"
                placeholder="· · · · · ·" maxLength={6} value={otp}
                onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" />
            </div>
          )}
        </div>

        <div className="px-5 pb-6 pt-3 border-t border-gray-100">
          {!otpSent ? (
            <Button variant="primary" className="w-full" loading={submitting}
              disabled={!canAfford || !!amountError || (!isFixed && freeAmt < minFreeAmount)}
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
    </div>
  );
}

/* ─── Bank Transfer sheet ────────────────────────────────────────────────── */

function BankTransferSheet({
  onClose, myBalance, minAmount, conversionRate, bankName, accountNumber, onRedeemed,
}: {
  onClose: () => void;
  myBalance: number;
  minAmount: number;
  conversionRate: number;
  bankName: string;
  accountNumber: string;
  onRedeemed: (pts: number, description: string) => void;
}) {
  const toast = useToast();
  const [amount,     setAmount]     = useState('');
  const [otp,        setOtp]        = useState('');
  const [otpSent,    setOtpSent]    = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [success,    setSuccess]    = useState(false);

  const inrAmt   = parseInt(amount, 10) || 0;
  const ptsNeeded = Math.ceil(inrAmt / conversionRate);
  const maxInr   = Math.floor(myBalance * conversionRate);

  const amountError = inrAmt > 0 && inrAmt < minAmount
    ? `Minimum transfer is ${fmtInr(minAmount)}`
    : inrAmt > maxInr
    ? `Exceeds balance (max ${fmtInr(maxInr)})`
    : '';

  const canProceed = inrAmt >= minAmount && !amountError && myBalance >= ptsNeeded;

  const handleSendOtp = async () => {
    setSubmitting(true);
    await new Promise(r => setTimeout(r, 800));
    setSubmitting(false);
    setOtpSent(true);
  };

  const handleConfirm = async () => {
    if (otp.length < 6) { toast.error('Enter the OTP'); return; }
    setSubmitting(true);
    await new Promise(r => setTimeout(r, 1000));
    setSubmitting(false);
    onRedeemed(ptsNeeded, `Redemption – bank transfer ₹${inrAmt}`);
    setSuccess(true);
  };

  if (success) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col justify-end">
        <div className="absolute inset-0 bg-black/50" onClick={onClose} />
        <div className="relative bg-white rounded-t-2xl p-8 flex flex-col items-center gap-4 text-center shadow-2xl">
          <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center">
            <CheckCircle className="h-8 w-8 text-emerald-600" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-gray-900">Transfer Initiated!</h3>
            <p className="text-sm text-gray-500 mt-1">
              {fmtInr(inrAmt)} will be transferred to {bankName} ({accountNumber}) within 2–3 working days.
            </p>
            <p className="text-xs text-gray-400 mt-1">{ptsNeeded} pts deducted. You will receive a WhatsApp with UTR once paid.</p>
          </div>
          <Button variant="primary" className="w-full" onClick={onClose}>Done</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-t-2xl max-h-[80vh] flex flex-col shadow-2xl">
        <div className="flex justify-center pt-3"><div className="w-10 h-1 bg-gray-200 rounded-full" /></div>
        <button onClick={onClose} className="absolute top-4 right-4 w-8 h-8 bg-black/10 rounded-full flex items-center justify-center">
          <X className="h-4 w-4 text-gray-700" />
        </button>

        <div className="overflow-y-auto flex-1 px-5 pt-4 pb-2 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-blue-100 rounded-2xl flex items-center justify-center">
              <Banknote className="h-6 w-6 text-blue-600" />
            </div>
            <div>
              <h3 className="text-base font-bold text-gray-900">Bank Transfer</h3>
              <p className="text-xs text-gray-500">Redeem points directly to your bank account</p>
            </div>
          </div>

          {/* Bank account details */}
          <div className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 space-y-1.5">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Transfer to</p>
            <p className="text-sm font-semibold text-gray-900">{bankName}</p>
            <p className="text-xs text-gray-500 font-mono">Account ****{accountNumber.slice(-4)}</p>
          </div>

          {/* Balance */}
          <div className="bg-emerald-50 border border-emerald-100 rounded-xl px-4 py-3 flex items-center justify-between">
            <p className="text-xs text-emerald-700 font-medium">Available balance</p>
            <p className="text-base font-bold text-emerald-700">{formatPoints(myBalance)} pts = {fmtInr(maxInr)}</p>
          </div>

          {/* Amount input */}
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">
              Amount to transfer * <span className="text-gray-400 font-normal">(min {fmtInr(minAmount)}, max {fmtInr(maxInr)})</span>
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-gray-500">₹</span>
              <input
                className={cn('w-full border rounded-xl pl-7 pr-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]',
                  amountError ? 'border-red-300' : 'border-gray-200')}
                placeholder={`${minAmount}`}
                value={amount}
                onChange={e => setAmount(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
              />
            </div>
            {amountError && <p className="text-xs text-red-500 mt-1 flex items-center gap-1"><AlertCircle className="h-3 w-3" />{amountError}</p>}
            {inrAmt >= minAmount && !amountError && (
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
                onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" />
            </div>
          )}
        </div>

        <div className="px-5 pb-6 pt-3 border-t border-gray-100">
          {!otpSent ? (
            <Button variant="primary" className="w-full" loading={submitting} disabled={!canProceed} onClick={handleSendOtp}>
              {!canProceed && inrAmt > 0 ? amountError || 'Insufficient balance' : `Transfer ${inrAmt ? fmtInr(inrAmt) : ''}`}
            </Button>
          ) : (
            <div className="flex gap-3">
              <Button variant="outline" className="flex-1" onClick={() => setOtpSent(false)}>← Back</Button>
              <Button variant="primary" className="flex-1" loading={submitting} disabled={otp.length < 6} onClick={handleConfirm}>Confirm</Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Main Page ───────────────────────────────────────────────────────────── */

type MainTab = 'catalogue' | 'vouchers' | 'bank';

export default function RewardsPage() {
  const router  = useRouter();
  const session = usePartnerSession();
  const [gifts,     setGifts]     = useState<GiftCatalogueItem[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [tab,       setTab]       = useState<MainTab>('catalogue');
  const [category,  setCategory]  = useState('All');
  const [search,    setSearch]    = useState('');
  const [wishlist,  setWishlist]  = useState<Set<string>>(new Set());
  const [detail,    setDetail]    = useState<GiftCatalogueItem | null>(null);
  const [voucherDetail, setVoucherDetail] = useState<GiftCatalogueItem | null>(null);
  const [showBank,  setShowBank]  = useState(false);
  const [balance,   setBalance]   = useState(0);
  const settings = getGifsySettings();

  useEffect(() => {
    setBalance(session.pointsBalance);
    const all = loadGifts();
    setGifts(all);
    setLoading(false);
  }, [session.pointsBalance]);

  /* ── Gate: non-wholesalers don't have a points balance ── */
  if (!loading && session.track !== 'POINTS') {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
        <Gift className="h-12 w-12 text-gray-300" />
        <div>
          <p className="text-gray-700 font-semibold">Rewards not available</p>
          <p className="text-sm text-gray-500 mt-1">
            The rewards catalogue is only available for Wholesaler outlets.
            Your earnings are paid out directly to your bank account.
          </p>
        </div>
        <Button variant="primary" onClick={() => router.push('/partner/wallet')}>View My Wallet</Button>
      </div>
    );
  }

  const physicalItems = useMemo(() => gifts.filter(g => g.category !== 'Vouchers'), [gifts]);
  const voucherItems  = useMemo(() => gifts.filter(g => g.category === 'Vouchers'), [gifts]);

  const categories = useMemo(() => {
    const cats = Array.from(new Set(physicalItems.map(g => g.category)));
    return ['All', ...PHYSICAL_CATEGORIES.filter(c => cats.includes(c))];
  }, [physicalItems]);

  // Resolve the effective tab early (needed by filtered memo, which runs before loading gate)
  const ch = settings.redemptionChannels ?? { physicalGifts: true, vouchers: true, bankTransfer: true };
  const effectiveTab: MainTab = (() => {
    if (tab === 'catalogue' && !ch.physicalGifts) return ch.vouchers ? 'vouchers' : 'bank';
    if (tab === 'vouchers'  && !ch.vouchers)      return ch.bankTransfer ? 'bank' : 'catalogue';
    if (tab === 'bank'      && !ch.bankTransfer)   return ch.physicalGifts ? 'catalogue' : 'vouchers';
    return tab;
  })();

  const filtered = useMemo(() => {
    let items = effectiveTab === 'catalogue' ? physicalItems : voucherItems;
    if (effectiveTab === 'catalogue' && category !== 'All') items = items.filter(g => g.category === category);
    if (search) items = items.filter(g => g.name.toLowerCase().includes(search.toLowerCase()) || g.brand.toLowerCase().includes(search.toLowerCase()));
    return items.filter(g => g.available);
  // effectiveTab changes when tab or settings change — exhaustive-deps not needed here
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveTab, physicalItems, voucherItems, category, search]);

  const toggleWishlist = (id: string) => setWishlist(prev => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n;
  });

  const handleRedeemed = (pts: number, description: string) => {
    setBalance(prev => prev - pts);
    saveRedemption({ points: pts, description });
    // Don't close the sheet here — each sheet's success screen "Done" button calls onClose
  };

  if (loading) return <div className="flex items-center justify-center min-h-64"><Spinner size="lg" /></div>;

  const channels = ch; // already computed above

  const TAB_CFG = (
    [
      { key: 'catalogue' as MainTab, label: 'Physical',      icon: Gift,     enabled: channels.physicalGifts },
      { key: 'vouchers'  as MainTab, label: 'Vouchers',      icon: Tag,      enabled: channels.vouchers      },
      { key: 'bank'      as MainTab, label: 'Bank Transfer', icon: Banknote, enabled: channels.bankTransfer  },
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
          <span className="text-[10px] text-emerald-600 font-medium">= {fmtInr(balance * settings.pointsConversionRate)}</span>
        </div>
        <button
          onClick={() => router.push('/partner/rewards/orders')}
          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1 rounded-full border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
        >
          <CheckCircle className="h-3.5 w-3.5" /> Orders
        </button>
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

      {/* ── Bank Transfer tab ── */}
      {activeTab === 'bank' && (
        <div className="space-y-4">
          <div className="bg-blue-50 border border-blue-100 rounded-xl px-4 py-4 space-y-2">
            <div className="flex items-center gap-2">
              <Banknote className="h-4 w-4 text-blue-600 shrink-0" />
              <p className="text-sm font-semibold text-blue-800">Direct Bank Transfer</p>
            </div>
            <p className="text-xs text-blue-700">
              Convert your points to INR and receive directly in your registered bank account.
              1 pt = {fmtInr(settings.pointsConversionRate)}. Minimum transfer: {fmtInr(settings.minBankTransferAmount)}.
            </p>
          </div>

          {/* Bank account on file */}
          <div className="bg-white rounded-xl border border-gray-200 px-4 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-gray-100 rounded-xl flex items-center justify-center">
                <CreditCard className="h-5 w-5 text-gray-500" />
              </div>
              <div>
                <p className="text-sm font-semibold text-gray-900">HDFC Bank</p>
                <p className="text-xs text-gray-500 font-mono">Account ****3210</p>
              </div>
            </div>
            <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full">Verified</span>
          </div>

          <Button
            variant="primary"
            className="w-full"
            disabled={balance < Math.ceil(settings.minBankTransferAmount / settings.pointsConversionRate)}
            onClick={() => setShowBank(true)}
          >
            <Banknote className="h-4 w-4" />
            {balance < Math.ceil(settings.minBankTransferAmount / settings.pointsConversionRate)
              ? `Need ${formatPoints(Math.ceil(settings.minBankTransferAmount / settings.pointsConversionRate) - balance)} more pts`
              : `Transfer Funds`}
          </Button>
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

          {/* Category pills — catalogue only */}
          {activeTab === 'catalogue' && (
            <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none" style={{ scrollbarWidth: 'none' }}>
              {categories.map(cat => (
                <button
                  key={cat}
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
          )}

          {/* Grid */}
          {filtered.length === 0 ? (
            <EmptyState icon={<Gift className="h-8 w-8" />} title="No items found" description="Try a different search or category" />
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {filtered.map(gift => {
                const canAfford   = gift.voucherType === 'FREE_AMOUNT' ? balance >= Math.ceil(settings.minVoucherFreeAmount / settings.pointsConversionRate) : balance >= gift.points;
                const isWishlisted = wishlist.has(gift.id);
                return (
                  <div
                    key={gift.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => gift.voucherType ? setVoucherDetail(gift) : setDetail(gift)}
                    onKeyDown={e => e.key === 'Enter' && (gift.voucherType ? setVoucherDetail(gift) : setDetail(gift))}
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
                            {gift.voucherType === 'FREE_AMOUNT' ? `Need ${formatPoints(Math.ceil(settings.minVoucherFreeAmount / settings.pointsConversionRate) - balance)} more` : `Need ${formatPoints(gift.points - balance)} more pts`}
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="p-3 flex-1 flex flex-col">
                      <p className="text-xs text-gray-400 mb-0.5">{gift.brand}</p>
                      <p className="text-xs font-semibold text-gray-900 leading-snug line-clamp-2 flex-1">{gift.name}</p>
                      <div className="mt-2 pt-2 border-t border-gray-50 flex items-center justify-between">
                        {gift.voucherType === 'FREE_AMOUNT' ? (
                          <span className="text-sm font-bold text-blue-600">Custom</span>
                        ) : (
                          <span className={`text-sm font-bold ${canAfford ? 'text-[var(--brand-primary)]' : 'text-gray-400'}`}>
                            {formatPoints(gift.points)} pts
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
          myBalance={balance} onWishlist={toggleWishlist} isWishlisted={wishlist.has(detail.id)}
          onRedeemed={handleRedeemed}
        />
      )}
      {voucherDetail && (
        <VoucherRedeemSheet
          voucher={voucherDetail} onClose={() => setVoucherDetail(null)}
          myBalance={balance} minFreeAmount={settings.minVoucherFreeAmount}
          conversionRate={settings.pointsConversionRate}
          onRedeemed={handleRedeemed}
        />
      )}
      {showBank && (
        <BankTransferSheet
          onClose={() => setShowBank(false)}
          myBalance={balance} minAmount={settings.minBankTransferAmount}
          conversionRate={settings.pointsConversionRate}
          bankName="HDFC Bank" accountNumber="****3210"
          onRedeemed={handleRedeemed}
        />
      )}
    </div>
  );
}
