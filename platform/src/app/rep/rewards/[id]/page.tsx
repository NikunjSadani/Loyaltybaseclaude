'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Gift, CheckCircle, Truck, Phone, Shield, Package } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';
import { formatPoints } from '@/lib/utils';
import { api, authHeader } from '@/lib/api-client';
import {
  mapCatalogItem,
  affordability,
  type EmployeeCatalogResponse,
  type EmployeeMe,
  type CatalogItem,
  type EmployeeRedeemPayload,
  type EmployeeRedeemResult,
} from '../../_lib/employee';

/* ─── REP reward detail + redeem ──────────────────────────────────────────────
   The backend exposes no single-item employee GET, so we resolve the item from the
   employee catalogue list (which already applies affordability + role/region
   visibility). Redeem is SINGLE-STEP: a confirm → one POST /api/rewards/employee/redeem
   with a fresh `sourceKey` (a UUID held in state so a retry reuses it → the backend
   dedup returns the same order instead of debiting twice). PHYSICAL_GIFT requires a
   delivery address; a VENDOR-sourced item requires a blocking consent tick. On success
   we show the order number + a celebratory state. ──────────────────────────────── */

const CONSENT_TEXT =
  'I agree that my name, delivery address, and phone number will be shared with the fulfilment partner to deliver this gift.';

type Step = 'detail' | 'form' | 'success';

export default function RepRewardDetailPage() {
  const params = useParams();
  const router = useRouter();
  const toast = useToast();
  const id = String(params?.id ?? '');

  const [item, setItem] = useState<CatalogItem | null>(null);
  const [balance, setBalance] = useState(0);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  // Member identity (seeds the delivery recipient + mobile) — from /api/auth/me.
  const [memberName, setMemberName] = useState('');
  const [mobile, setMobile] = useState('');

  // Redeem flow state.
  const [step, setStep] = useState<Step>('detail');
  const [submitting, setSubmitting] = useState(false);
  const [recipientName, setRecipientName] = useState('');
  const [recipientTouched, setRecipientTouched] = useState(false);
  const [address, setAddress] = useState({ line1: '', city: '', state: '', pincode: '' });
  const [consent, setConsent] = useState(false);
  const [order, setOrder] = useState<EmployeeRedeemResult | null>(null);

  // A fresh idempotency key per redeem INTENT (this page view). Reused on retry so a
  // double-submit / network retry returns the existing order instead of debiting twice.
  const [sourceKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch('/api/rewards/employee/catalog?limit=200', { headers: { ...authHeader() } })
        .then((r) => r.json())
        .catch(() => null),
      fetch('/api/auth/me', { headers: { ...authHeader() } })
        .then((r) => r.json())
        .catch(() => null),
    ]).then(([catJson, meJson]) => {
      if (cancelled) return;
      if (catJson?.success && catJson.data) {
        const data = catJson.data as EmployeeCatalogResponse;
        const found = (data.items ?? []).map(mapCatalogItem).find((i) => i.id === id) ?? null;
        setItem(found);
        setBalance(data.userBalance ?? 0);
        if (!found) setNotFound(true);
      } else {
        setNotFound(true);
      }
      if (meJson?.success && meJson.data) {
        const u = (meJson.data as EmployeeMe).user;
        if (u?.name) {
          setMemberName(u.name);
          setRecipientName((prev) => (prev ? prev : u.name!));
        }
        if (u?.phone) setMobile(u.phone);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Seed the recipient name once /me resolves (if untouched).
  useEffect(() => {
    if (!recipientTouched && memberName) setRecipientName(memberName);
  }, [memberName, recipientTouched]);

  const isPhysical = item?.redemptionMode === 'PHYSICAL_GIFT';
  const needConsent = item?.requiresConsent === true;
  const { affordable, shortfall } = useMemo(
    () => affordability(balance, item?.pointsCost ?? 0),
    [balance, item?.pointsCost],
  );

  const doRedeem = async () => {
    if (!item) return;
    if (isPhysical) {
      if (!recipientName.trim()) {
        toast.error('Please enter the recipient name');
        return;
      }
      if (!address.line1 || !address.city || !address.pincode) {
        toast.error('Please fill in all required address fields');
        return;
      }
      if (!/^\d{6}$/.test(address.pincode)) {
        toast.error('Enter a valid 6-digit pincode');
        return;
      }
      if (!/^\d{10}$/.test(mobile)) {
        toast.error('A valid 10-digit registered mobile is required for delivery');
        return;
      }
    }
    if (needConsent && !consent) {
      toast.error('Please agree to share your delivery details to continue');
      return;
    }

    const payload: EmployeeRedeemPayload = {
      rewardId: item.id,
      sourceKey,
      quantity: 1,
      ...(isPhysical
        ? {
            deliveryAddress: {
              name: recipientName.trim(),
              mobile,
              address: address.line1,
              city: address.city,
              state: address.state || address.city,
              pincode: address.pincode,
            },
          }
        : {}),
      ...(needConsent ? { consent: true } : {}),
    };

    setSubmitting(true);
    const result = await api.post<EmployeeRedeemResult>('/api/rewards/employee/redeem', payload);
    setSubmitting(false);
    if (!result.success) {
      toast.error(result.error || 'Could not complete redemption');
      return;
    }
    setOrder(result.data);
    setStep('success');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  if (notFound || !item) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
        <Gift className="h-12 w-12 text-gray-300" />
        <div>
          <p className="text-gray-700 font-semibold">Reward not available</p>
          <p className="text-sm text-gray-500 mt-1">This reward may be out of stock or not available to you.</p>
        </div>
        <Button variant="primary" onClick={() => router.push('/rep/rewards')}>
          Back to Rewards
        </Button>
      </div>
    );
  }

  /* ── Success state ── */
  if (step === 'success' && order) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-4 text-center fade-in">
        <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center">
          <CheckCircle className="h-8 w-8 text-emerald-600" />
        </div>
        <div>
          <p className="text-lg font-bold text-gray-900">Redemption confirmed 🎉</p>
          <p className="text-sm text-gray-500 mt-1">{item.name} — {formatPoints(order.requiredPoints)} pts</p>
          <p className="text-xs text-gray-400 mt-2">
            Order <span className="font-mono font-semibold text-gray-600">{order.orderNumber}</span>
          </p>
          {isPhysical && (
            <p className="text-xs text-gray-400 mt-1">We&apos;ll ship it and share tracking under Orders.</p>
          )}
        </div>
        <div className="flex gap-3 w-full max-w-xs">
          <Button variant="outline" className="flex-1" onClick={() => router.push('/rep/rewards')}>
            Keep browsing
          </Button>
          <Button variant="primary" className="flex-1" onClick={() => router.push(`/rep/orders/${order.orderId}`)}>
            View order
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 fade-in">
      <button
        type="button"
        onClick={() => (step === 'form' ? setStep('detail') : router.push('/rep/rewards'))}
        className="flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-700"
      >
        <ArrowLeft className="h-4 w-4" /> {step === 'form' ? 'Back to details' : 'Back to Rewards'}
      </button>

      {/* Image */}
      <div className="rounded-2xl overflow-hidden bg-gray-50 h-56 flex items-center justify-center">
        {item.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.imageUrl} alt="" className="max-h-full max-w-full object-contain p-4" />
        ) : (
          <Gift className="h-16 w-16 text-gray-300" />
        )}
      </div>

      <div>
        <p className="text-xs text-gray-400">{item.category}</p>
        <h1 className="text-xl font-bold text-gray-900 leading-snug mt-0.5">{item.name}</h1>
      </div>

      {/* Price + affordability */}
      <div className="flex items-center gap-3 p-3.5 bg-gray-50 rounded-2xl">
        <div className="flex-1">
          <p className={`text-2xl font-bold ${affordable ? 'text-[var(--brand-primary)]' : 'text-gray-400'}`}>
            {formatPoints(item.pointsCost)} pts
          </p>
          {affordable ? (
            <p className="text-xs text-emerald-600 mt-0.5 font-medium">
              {formatPoints(balance - item.pointsCost)} pts remaining after
            </p>
          ) : (
            <p className="text-xs text-red-500 mt-0.5 font-semibold">Need {formatPoints(shortfall)} more pts</p>
          )}
        </div>
        {isPhysical && (
          <div className="text-right">
            <div className="flex items-center gap-1 justify-end text-xs text-gray-500">
              <Truck className="h-3.5 w-3.5" /> 5–7 business days
            </div>
            <p className="text-xs text-gray-400 mt-0.5">Free delivery</p>
          </div>
        )}
      </div>

      {step === 'detail' && (
        <>
          {item.description && (
            <div>
              <h3 className="text-sm font-semibold text-gray-900 mb-1.5">About this reward</h3>
              <p className="text-sm text-gray-600 leading-relaxed">{item.description}</p>
            </div>
          )}
          {isPhysical && (
            <div className="grid grid-cols-3 gap-2">
              {[
                { icon: Shield, label: 'Genuine' },
                { icon: Truck, label: 'Free delivery' },
                { icon: Package, label: 'Tracked' },
              ].map((b) => (
                <div key={b.label} className="flex flex-col items-center gap-1 p-2.5 bg-gray-50 rounded-xl">
                  <b.icon className="h-4 w-4 text-[var(--brand-primary)]" />
                  <span className="text-[10px] text-gray-500 text-center leading-tight">{b.label}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Delivery form (PHYSICAL_GIFT) */}
      {step === 'form' && isPhysical && (
        <div className="space-y-4">
          <p className="text-xs text-gray-500">Enter who this is for and where to deliver it</p>
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1" htmlFor="rep-recipient">
              Recipient name *
            </label>
            <input
              id="rep-recipient"
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
              placeholder="Full name for the parcel"
              value={recipientName}
              onChange={(e) => {
                setRecipientTouched(true);
                setRecipientName(e.target.value);
              }}
            />
          </div>
          {[
            { key: 'line1', label: 'Street address *', placeholder: 'House no., street name' },
            { key: 'city', label: 'City *', placeholder: 'City' },
            { key: 'state', label: 'State', placeholder: 'State' },
            { key: 'pincode', label: 'Pincode *', placeholder: '400001' },
          ].map((f) => (
            <div key={f.key}>
              <label className="text-xs font-medium text-gray-600 block mb-1">{f.label}</label>
              <input
                className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
                placeholder={f.placeholder}
                value={(address as Record<string, string>)[f.key]}
                onChange={(e) => setAddress((prev) => ({ ...prev, [f.key]: e.target.value }))}
                inputMode={f.key === 'pincode' ? 'numeric' : undefined}
              />
            </div>
          ))}
          <p className="text-xs text-gray-400 flex items-center gap-1.5">
            <Phone className="h-3.5 w-3.5" /> Delivery updates go to your registered mobile
            {mobile ? ` (${mobile})` : ''}
          </p>
        </div>
      )}

      {/* Vendor-PII consent (before redeem) */}
      {((step === 'form' && isPhysical) || (step === 'detail' && !isPhysical)) && needConsent && (
        <label className="flex items-start gap-2.5 p-3 rounded-xl border border-amber-200 bg-amber-50 cursor-pointer">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            className="mt-0.5 w-4 h-4 accent-[var(--brand-primary)] shrink-0"
          />
          <span className="text-xs text-amber-900 leading-relaxed">{CONSENT_TEXT}</span>
        </label>
      )}

      {/* Action */}
      <div className="pt-1">
        {isPhysical && step === 'detail' ? (
          <Button
            variant="primary"
            className="w-full"
            disabled={!affordable}
            onClick={() => setStep('form')}
          >
            {affordable ? 'Redeem Now' : `Need ${formatPoints(shortfall)} more pts`}
          </Button>
        ) : (
          <Button
            variant="primary"
            className="w-full"
            loading={submitting}
            disabled={!affordable || (needConsent && !consent)}
            onClick={doRedeem}
          >
            {affordable ? 'Confirm redemption' : `Need ${formatPoints(shortfall)} more pts`}
          </Button>
        )}
      </div>
    </div>
  );
}
