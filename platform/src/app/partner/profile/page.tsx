'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  User, CreditCard, Shield, Coins,
  LogOut, ChevronRight, CheckCircle, Clock, AlertTriangle,
  ImageIcon, ChevronLeft, X as XIcon,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Modal } from '@/components/ui/modal';
import { formatPoints, maskAccountNumber } from '@/lib/utils';
import { KYCStatus, ChannelPartnerClass } from '@/types';
import { usePartnerSession, type OutletType } from '@/lib/partner-session';

/* ─── Types ──────────────────────────────────────────────────────────────────── */

interface ProfileData {
  user: { name: string; mobile: string };
  partner: {
    firmName: string;
    partnerClass: ChannelPartnerClass;
    kycStatus: KYCStatus;
    tier: string;
    outletCode: string;
    gstNumber: string;
    panNumber: string;
    kycPhotos: string[];
  };
  wallet: { available: number; locked: number; redeemable: number };
  bank: { accountNumber: string; ifscCode: string; bankName: string };
}

/* ─── Config ─────────────────────────────────────────────────────────────────── */

const kycConfig: Record<KYCStatus, { icon: React.ReactNode; label: string; variant: 'success' | 'warning' | 'danger' | 'info' | 'default' }> = {
  [KYCStatus.APPROVED]: { icon: <CheckCircle className="h-4 w-4" />, label: 'KYC Approved', variant: 'success' },
  [KYCStatus.PENDING]: { icon: <Clock className="h-4 w-4" />, label: 'KYC Pending', variant: 'warning' },
  [KYCStatus.SUBMITTED]: { icon: <Clock className="h-4 w-4" />, label: 'KYC Submitted', variant: 'info' },
  [KYCStatus.UNDER_REVIEW]: { icon: <Clock className="h-4 w-4" />, label: 'Under Review', variant: 'info' },
  [KYCStatus.PENDING_SO_APPROVAL]:  { icon: <Clock className="h-4 w-4" />, label: 'Awaiting SO',    variant: 'warning' },
  [KYCStatus.PENDING_ASM_APPROVAL]: { icon: <Clock className="h-4 w-4" />, label: 'Awaiting ASM',   variant: 'warning' },
  [KYCStatus.PENDING_RSM_APPROVAL]: { icon: <Clock className="h-4 w-4" />, label: 'Awaiting RSM',   variant: 'warning' },
  [KYCStatus.PENDING_GIFSY]:        { icon: <Clock className="h-4 w-4" />, label: 'Awaiting Gifsy', variant: 'info'    },
  [KYCStatus.REJECTED]: { icon: <AlertTriangle className="h-4 w-4" />, label: 'KYC Rejected', variant: 'danger' },
  [KYCStatus.RESUBMISSION_REQUIRED]: { icon: <AlertTriangle className="h-4 w-4" />, label: 'Re-upload Required', variant: 'danger' },
  [KYCStatus.RE_KYC_REQUIRED]:      { icon: <AlertTriangle className="h-4 w-4" />, label: 'Re-KYC Required',    variant: 'warning' },
  [KYCStatus.NOT_STARTED]:          { icon: <Clock className="h-4 w-4" />,         label: 'KYC Pending',        variant: 'default' },
  [KYCStatus.NOT_INTERESTED]:       { icon: <Clock className="h-4 w-4" />,         label: 'Not Interested',     variant: 'default' },
};

const tierColors: Record<string, string> = {
  GOLD:     'text-amber-700 bg-amber-50 border-amber-200',
  SILVER:   'text-gray-600 bg-gray-100 border-gray-300',
  PLATINUM: 'text-purple-700 bg-purple-50 border-purple-200',
  BRONZE:   'text-orange-700 bg-orange-50 border-orange-200',
};

/** Outlet types that can see Visibility Invoices */
const VISIBILITY_INVOICE_TYPES = new Set<OutletType>(['SSS', 'SSS_TOT']);

/** Outlet types that earn and can see Points Summary (Deoleo: Wholesalers only) */
const POINTS_OUTLET_TYPES = new Set<OutletType>(['WHOLESALER']);

/* ─── Mock data ──────────────────────────────────────────────────────────────── */

const MOCK_PROFILE: ProfileData = {
  user: { name: 'Rajesh Kumar', mobile: '+91 98765 43210' },
  partner: {
    firmName:    'Kumar General Store',
    partnerClass: ChannelPartnerClass.GOLD,
    kycStatus:   KYCStatus.APPROVED,
    tier:        'GOLD',
    outletCode:  'KGS-001',
    gstNumber:   '27AABCU9603R1ZX',
    panNumber:   'AABCU9603R',
    kycPhotos: [
      'https://placehold.co/800x600?text=Outlet+Front+Photo',
      'https://placehold.co/800x600?text=Outlet+Interior+Photo',
    ],
  },
  wallet: { available: 4_250, locked: 0, redeemable: 4_250 },
  bank: { accountNumber: '1234567890123456', ifscCode: 'HDFC0001234', bankName: 'HDFC Bank' },
};

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function ProfilePage() {
  const router  = useRouter();
  const session = usePartnerSession();

  const [profile,      setProfile]      = useState<ProfileData | null>(null);
  const [loading,      setLoading]      = useState(true);
  const [logoutModal,  setLogoutModal]  = useState(false);
  const [photoGallery, setPhotoGallery] = useState(false);
  const [photoIndex,   setPhotoIndex]   = useState(0);

  useEffect(() => {
    const t = setTimeout(() => {
      setProfile(MOCK_PROFILE);
      setLoading(false);
    }, 500);
    return () => clearTimeout(t);
  }, []);

  const handleLogout = () => {
    document.cookie = 'token=; Max-Age=0; path=/';
    router.push('/auth/login');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!profile) return null;

  const kycCfg   = kycConfig[profile.partner.kycStatus];
  const tierClass = tierColors[profile.partner.tier] ?? 'text-gray-700 bg-gray-50 border-gray-200';
  const showVisibilityInvoices = VISIBILITY_INVOICE_TYPES.has(session.outletType);
  const showPointsSummary      = POINTS_OUTLET_TYPES.has(session.outletType);

  return (
    <div className="space-y-5 fade-in">

      {/* ── Profile header ── */}
      <div
        data-testid="profile-header"
        className="bg-gradient-to-br from-[#1A1A2E] to-[#16213E] rounded-2xl p-6 text-white"
      >
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 bg-[var(--brand-primary)] rounded-2xl flex items-center justify-center text-white text-2xl font-bold shrink-0">
            {profile.user.name.charAt(0)}
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-bold text-white">{profile.user.name}</h2>
            <p className="text-white/60 text-sm">{profile.partner.firmName}</p>
            <div className="flex items-center gap-2 mt-2">
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${tierClass}`}>
                {profile.partner.tier} Tier
              </span>
              <span className="text-xs text-white/50">{profile.partner.partnerClass}</span>
            </div>
            <div className="flex items-center gap-1.5 mt-2">
              <span className="text-[10px] text-white/40 uppercase tracking-wide">Outlet Code</span>
              <span
                data-testid="outlet-code-value"
                className="text-[11px] font-mono font-semibold text-white/80 bg-white/10 px-2 py-0.5 rounded"
              >
                {profile.partner.outletCode}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ── KYC status ── */}
      <Card>
        <CardContent className="px-4 py-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-gray-50 rounded-lg">
              <Shield className="h-5 w-5 text-gray-500" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium text-gray-900">KYC Status</p>
              <p className="text-xs text-gray-500">Identity verification</p>
            </div>
            <Badge variant={kycCfg.variant}>{kycCfg.label}</Badge>
          </div>
        </CardContent>
      </Card>

      {/* ── Business Details (GST, PAN, KYC photo) ── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Shield className="h-4 w-4" /> Business Details
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[
              { label: 'GST Number', value: profile.partner.gstNumber, testId: 'gst-number-value', mono: true },
              { label: 'PAN Number', value: profile.partner.panNumber, testId: 'pan-number-value', mono: true },
            ].map((row) => (
              <div key={row.label} className="flex items-center justify-between py-1">
                <span className="text-sm text-gray-500">{row.label}</span>
                <span
                  data-testid={row.testId}
                  className="text-sm font-medium text-gray-900 font-mono tracking-wide"
                >
                  {row.value}
                </span>
              </div>
            ))}

            {/* KYC outlet photos */}
            <div className="flex items-center justify-between py-1">
              <span className="text-sm text-gray-500">Outlet Photos</span>
              <button
                data-testid="kyc-photo-btn"
                onClick={() => { setPhotoIndex(0); setPhotoGallery(true); }}
                className="flex items-center gap-1.5 text-sm font-medium text-[var(--brand-primary)] hover:underline"
              >
                <ImageIcon className="h-3.5 w-3.5" />
                View Photos
                <span className="text-[10px] text-gray-400 font-normal">
                  ({profile.partner.kycPhotos.length})
                </span>
              </button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Contact details ── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <User className="h-4 w-4" /> Contact Details
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[
              { label: 'Full Name', value: profile.user.name },
              { label: 'Mobile',    value: profile.user.mobile },
            ].map((row) => (
              <div key={row.label} className="flex items-center justify-between py-1">
                <span className="text-sm text-gray-500">{row.label}</span>
                <span className="text-sm font-medium text-gray-900">{row.value}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ── Points summary (Wholesalers only) ── */}
      {showPointsSummary && (
        <Card data-testid="points-summary">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Coins className="h-4 w-4" /> Points Summary
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex justify-center">
              <div className="text-center p-3 bg-gray-50 rounded-xl w-full">
                <p className="text-lg font-bold text-[var(--brand-primary)]">
                  {formatPoints(profile.wallet.redeemable)}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">Redeemable</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Payment details ── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CreditCard className="h-4 w-4" /> Payment Details
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {[
              { label: 'Bank',    value: profile.bank.bankName },
              { label: 'Account', value: maskAccountNumber(profile.bank.accountNumber) },
              { label: 'IFSC',    value: profile.bank.ifscCode },
            ].map((row) => (
              <div key={row.label} className="flex items-center justify-between py-1">
                <span className="text-sm text-gray-500">{row.label}</span>
                <span className="text-sm font-medium text-gray-900 font-mono">{row.value}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ── Menu links ── */}
      {[
        ...(showVisibilityInvoices
          ? [{ label: 'Visibility Invoices', href: '/partner/invoices' }]
          : []),
        { label: 'Terms & Conditions', href: '#' },
        { label: 'Privacy Policy',     href: '#' },
      ].map((link) => (
        <a
          key={link.label}
          href={link.href}
          className="flex items-center justify-between p-4 bg-white rounded-xl border border-gray-200 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
        >
          {link.label}
          <ChevronRight className="h-4 w-4 text-gray-400" />
        </a>
      ))}

      {/* ── Sign out ── */}
      <Button
        variant="outline"
        className="w-full text-red-600 border-red-200 hover:bg-red-50"
        onClick={() => setLogoutModal(true)}
      >
        <LogOut className="h-4 w-4" />
        Sign Out
      </Button>

      {/* ── KYC Photo Gallery modal ── */}
      {photoGallery && (
        <div
          data-testid="kyc-photo-gallery"
          className="fixed inset-0 z-50 bg-black/90 flex flex-col items-center justify-center"
          onClick={() => setPhotoGallery(false)}
        >
          {/* Stop propagation on inner content */}
          <div
            className="relative w-full max-w-lg px-4"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Close + counter */}
            <div className="flex items-center justify-between mb-3">
              <span
                data-testid="photo-counter"
                className="text-white text-sm font-semibold"
              >
                {photoIndex + 1} / {profile.partner.kycPhotos.length}
              </span>
              <button
                onClick={() => setPhotoGallery(false)}
                className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
              >
                <XIcon className="h-4 w-4" />
              </button>
            </div>

            {/* Photos — all rendered; only active one visible */}
            {profile.partner.kycPhotos.map((url, i) => (
              <img
                key={i}
                src={url}
                alt={`KYC photo ${i + 1}`}
                className={`w-full rounded-2xl object-cover ${i === photoIndex ? 'block' : 'hidden'}`}
              />
            ))}

            {/* Nav buttons */}
            <div className="flex items-center justify-between mt-4 gap-3">
              <button
                data-testid="photo-prev"
                onClick={() => setPhotoIndex((i) => Math.max(0, i - 1))}
                disabled={photoIndex === 0}
                className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-white/10 hover:bg-white/20 text-white text-sm font-semibold transition-colors disabled:opacity-30"
              >
                <ChevronLeft className="h-4 w-4" />
                Previous
              </button>
              <button
                data-testid="photo-next"
                onClick={() => setPhotoIndex((i) => Math.min(profile.partner.kycPhotos.length - 1, i + 1))}
                disabled={photoIndex === profile.partner.kycPhotos.length - 1}
                className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-white/10 hover:bg-white/20 text-white text-sm font-semibold transition-colors disabled:opacity-30"
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>

            {/* Dot indicators */}
            <div className="flex justify-center gap-1.5 mt-4">
              {profile.partner.kycPhotos.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setPhotoIndex(i)}
                  className={`w-2 h-2 rounded-full transition-all ${
                    i === photoIndex ? 'bg-white scale-125' : 'bg-white/30'
                  }`}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Logout confirmation modal ── */}
      <Modal
        open={logoutModal}
        onOpenChange={setLogoutModal}
        title="Sign Out"
        description="Are you sure you want to sign out of your account?"
      >
        <div className="flex gap-3 mt-2">
          <Button variant="outline" className="flex-1" onClick={() => setLogoutModal(false)}>
            Cancel
          </Button>
          <Button variant="destructive" className="flex-1" onClick={handleLogout}>
            Sign Out
          </Button>
        </div>
      </Modal>
    </div>
  );
}
