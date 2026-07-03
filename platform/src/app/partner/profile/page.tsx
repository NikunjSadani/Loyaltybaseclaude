'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  User, CreditCard, Shield, Coins,
  LogOut, ChevronRight, CheckCircle, Clock, AlertTriangle, RefreshCw,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Modal } from '@/components/ui/modal';
import { formatPoints, maskAccountNumber } from '@/lib/utils';
import { KYCStatus } from '@/types';
import { usePartnerSession, type OutletType } from '@/lib/partner-session';
import { api } from '@/lib/api-client';
import { logoutAction } from '@/lib/auth-actions';
import PwaAppSettings from '@/components/pwa/PwaAppSettings';

/* ─── Types ──────────────────────────────────────────────────────────────────── */

interface ProfileData {
  user: { name: string; mobile: string };
  partner: {
    firmName: string;
    kycStatus?: KYCStatus;        // shown only when the API supplies a real status
    outletCode: string;
    gstNumber: string;
    panNumber: string;
  };
  wallet: { redeemable: number; locked: number };
  /** Beneficiary on file (from /auth/me). Any field may be null when not captured yet. */
  bank: {
    bankName: string | null;
    accountNumber: string | null;
    ifscCode: string | null;
    upiId: string | null;
  };
}

/* ─── Config ─────────────────────────────────────────────────────────────────── */

const kycConfig: Record<KYCStatus, { icon: React.ReactNode; label: string; variant: 'success' | 'warning' | 'danger' | 'info' | 'default' }> = {
  [KYCStatus.APPROVED]: { icon: <CheckCircle className="h-4 w-4" />, label: 'KYC Approved', variant: 'success' },
  [KYCStatus.PENDING]: { icon: <Clock className="h-4 w-4" />, label: 'KYC Pending', variant: 'warning' },
  [KYCStatus.DRAFT]: { icon: <Clock className="h-4 w-4" />, label: 'Pending', variant: 'warning' },
  [KYCStatus.SUBMITTED]: { icon: <Clock className="h-4 w-4" />, label: 'KYC Submitted', variant: 'info' },
  [KYCStatus.UNDER_REVIEW]: { icon: <Clock className="h-4 w-4" />, label: 'Under Review', variant: 'info' },
  [KYCStatus.PENDING_SO_APPROVAL]:  { icon: <Clock className="h-4 w-4" />, label: 'Awaiting SO',    variant: 'warning' },
  [KYCStatus.PENDING_ASM_APPROVAL]: { icon: <Clock className="h-4 w-4" />, label: 'Awaiting ASM',   variant: 'warning' },
  [KYCStatus.PENDING_RSM_APPROVAL]: { icon: <Clock className="h-4 w-4" />, label: 'Awaiting RSM',   variant: 'warning' },
  [KYCStatus.PENDING_GIFSY]:        { icon: <Clock className="h-4 w-4" />, label: 'Awaiting Gifsy', variant: 'info'    },
  [KYCStatus.REJECTED]: { icon: <AlertTriangle className="h-4 w-4" />, label: 'KYC Rejected', variant: 'danger' },
  [KYCStatus.RE_UPLOAD_REQUIRED]: { icon: <AlertTriangle className="h-4 w-4" />, label: 'KYC Rejected', variant: 'danger' },
  [KYCStatus.RESUBMISSION_REQUIRED]: { icon: <AlertTriangle className="h-4 w-4" />, label: 'KYC Rejected', variant: 'danger' },
  [KYCStatus.RE_KYC_REQUIRED]:      { icon: <AlertTriangle className="h-4 w-4" />, label: 'Re-KYC Required',    variant: 'warning' },
  [KYCStatus.NOT_STARTED]:          { icon: <Clock className="h-4 w-4" />,         label: 'KYC Pending',        variant: 'default' },
  [KYCStatus.NOT_INTERESTED]:       { icon: <Clock className="h-4 w-4" />,         label: 'Not Interested',     variant: 'default' },
};

/** Outlet types that can see Visibility Invoices */
const VISIBILITY_INVOICE_TYPES = new Set<OutletType>(['SSS', 'SSS_TOT']);

/** Outlet types that earn and can see Points Summary (Deoleo: Wholesalers only) */
const POINTS_OUTLET_TYPES = new Set<OutletType>(['WHOLESALER']);

/** Display helper — show a real value, else an em-dash (never a fabricated placeholder). */
const orDash = (v?: string | null): string => (v && v.trim() ? v : '—');

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function ProfilePage() {
  const router  = useRouter();
  const session = usePartnerSession();

  const [profile,     setProfile]     = useState<ProfileData | null>(null);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState<string | null>(null);
  const [logoutModal, setLogoutModal] = useState(false);
  // "Log out from all devices" — two-step confirm inside the same modal.
  const [confirmAllDevices, setConfirmAllDevices] = useState(false);
  const [loggingOutAll,     setLoggingOutAll]     = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    // The partner's OWN profile from /auth/me — real identity, wallet, and the
    // beneficiary (bank/UPI) the server holds. No mock fallback: a missing field
    // renders as "—" and a failed load shows an honest error, never fabricated data.
    api.get<{
      user: {
        name?:  string;
        phone?: string;
        channelPartner?: {
          businessName?:      string;
          partnerCode?:       string;
          gstNumber?:         string;
          panNumber?:         string;
          kycStatus?:         string;
          bankName?:          string | null;
          bankAccountNumber?: string | null;
          ifscCode?:          string | null;
          upiId?:             string | null;
          wallets?: Array<{ redeemablePoints?: number; lockedPoints?: number }>;
        } | null;
      };
    }>('/api/auth/me')
      .then((result) => {
        if (result.success && result.data?.user) {
          const u  = result.data.user;
          const cp = u.channelPartner;
          const w  = cp?.wallets?.[0];
          setProfile({
            user: {
              name:   u.name  ?? '',
              mobile: u.phone ?? '',
            },
            partner: {
              firmName:   cp?.businessName ?? '',
              kycStatus:  (cp?.kycStatus as KYCStatus | undefined) ?? undefined,
              outletCode: cp?.partnerCode ?? '',
              gstNumber:  cp?.gstNumber ?? '',
              panNumber:  cp?.panNumber ?? '',
            },
            wallet: {
              redeemable: w?.redeemablePoints ?? 0,
              locked:     w?.lockedPoints     ?? 0,
            },
            bank: {
              bankName:      cp?.bankName          ?? null,
              accountNumber: cp?.bankAccountNumber ?? null,
              ifscCode:      cp?.ifscCode          ?? null,
              upiId:         cp?.upiId             ?? null,
            },
          });
        } else {
          setError('Could not load your profile. Please try again.');
        }
      })
      .catch(() => setError('Could not load your profile. Please try again.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleLogout = () => {
    document.cookie = 'token=; Max-Age=0; path=/';
    router.push('/auth/login');
  };

  // Revoke every session server-side (all devices), then clear THIS device's cookies
  // and bounce to login. Other devices are signed out within the session window / on
  // their next refresh — not instantly (access tokens live until they expire).
  const handleLogoutAllDevices = async () => {
    setLoggingOutAll(true);
    try {
      await api.post('/api/auth/logout-all', {});
    } finally {
      await logoutAction();
      router.push('/auth/login');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="flex flex-col items-center justify-center min-h-64 gap-3 text-center px-6">
        <p className="text-sm text-gray-600">{error ?? 'Profile unavailable.'}</p>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="h-4 w-4" /> Retry
        </Button>
      </div>
    );
  }

  const kycCfg = profile.partner.kycStatus ? kycConfig[profile.partner.kycStatus] : null;
  const showVisibilityInvoices = VISIBILITY_INVOICE_TYPES.has(session.outletType);
  const showPointsSummary      = POINTS_OUTLET_TYPES.has(session.outletType);

  const { bankName, accountNumber, ifscCode, upiId } = profile.bank;
  const hasBank = Boolean(bankName || accountNumber || ifscCode);
  const hasPaymentDetails = hasBank || Boolean(upiId);

  return (
    <div className="space-y-5 fade-in">

      {/* ── Profile header ── */}
      <div
        data-testid="profile-header"
        className="bg-gradient-to-br from-[#1A1A2E] to-[#16213E] rounded-2xl p-6 text-white"
      >
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 bg-[var(--brand-primary)] rounded-2xl flex items-center justify-center text-white text-2xl font-bold shrink-0">
            {(profile.user.name || profile.partner.firmName || '?').charAt(0)}
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-bold text-white">{orDash(profile.user.name)}</h2>
            <p className="text-white/60 text-sm">{orDash(profile.partner.firmName)}</p>
            <div className="flex items-center gap-1.5 mt-2">
              <span className="text-[10px] text-white/40 uppercase tracking-wide">Outlet Code</span>
              <span
                data-testid="outlet-code-value"
                className="text-[11px] font-mono font-semibold text-white/80 bg-white/10 px-2 py-0.5 rounded"
              >
                {orDash(profile.partner.outletCode)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ── KYC status (only when the server supplies a real status) ── */}
      {kycCfg && (
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
      )}

      {/* ── Business Details (GST, PAN) ── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Shield className="h-4 w-4" /> Business Details
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[
              { label: 'GST Number', value: orDash(profile.partner.gstNumber), testId: 'gst-number-value' },
              { label: 'PAN Number', value: orDash(profile.partner.panNumber), testId: 'pan-number-value' },
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
              { label: 'Full Name', value: orDash(profile.user.name) },
              { label: 'Mobile',    value: orDash(profile.user.mobile) },
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

      {/* ── Payment details (real beneficiary, or an honest empty state) ── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CreditCard className="h-4 w-4" /> Payment Details
          </CardTitle>
        </CardHeader>
        <CardContent>
          {hasPaymentDetails ? (
            <div className="space-y-2">
              {hasBank && (
                <>
                  <div className="flex items-center justify-between py-1">
                    <span className="text-sm text-gray-500">Bank</span>
                    <span className="text-sm font-medium text-gray-900 font-mono">{orDash(bankName)}</span>
                  </div>
                  <div className="flex items-center justify-between py-1">
                    <span className="text-sm text-gray-500">Account</span>
                    <span data-testid="bank-account-value" className="text-sm font-medium text-gray-900 font-mono">
                      {accountNumber ? maskAccountNumber(accountNumber) : '—'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between py-1">
                    <span className="text-sm text-gray-500">IFSC</span>
                    <span className="text-sm font-medium text-gray-900 font-mono">{orDash(ifscCode)}</span>
                  </div>
                </>
              )}
              {upiId && (
                <div className="flex items-center justify-between py-1">
                  <span className="text-sm text-gray-500">UPI</span>
                  <span className="text-sm font-medium text-gray-900 font-mono">{upiId}</span>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-gray-500 py-1">No payment details on file yet.</p>
          )}
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

      {/* ── App & Notifications (PWA install / push) ── */}
      <PwaAppSettings />

      {/* ── Sign out ── */}
      <Button
        variant="outline"
        className="w-full text-red-600 border-red-200 hover:bg-red-50"
        onClick={() => setLogoutModal(true)}
      >
        <LogOut className="h-4 w-4" />
        Sign Out
      </Button>

      {/* ── Logout confirmation modal ── */}
      <Modal
        open={logoutModal}
        onOpenChange={(open) => { setLogoutModal(open); if (!open) setConfirmAllDevices(false); }}
        title="Sign Out"
        description={
          confirmAllDevices
            ? 'This signs you out on all your devices. Other devices are signed out within the session window (on their next refresh), not instantly.'
            : 'Are you sure you want to sign out of your account?'
        }
      >
        {confirmAllDevices ? (
          <div className="flex gap-3 mt-2">
            <Button
              variant="outline"
              className="flex-1"
              disabled={loggingOutAll}
              onClick={() => setConfirmAllDevices(false)}
            >
              Back
            </Button>
            <Button
              variant="destructive"
              className="flex-1"
              disabled={loggingOutAll}
              onClick={handleLogoutAllDevices}
            >
              {loggingOutAll ? 'Signing out…' : 'Log out everywhere'}
            </Button>
          </div>
        ) : (
          <div className="space-y-2 mt-2">
            <div className="flex gap-3">
              <Button variant="outline" className="flex-1" onClick={() => setLogoutModal(false)}>
                Cancel
              </Button>
              <Button variant="destructive" className="flex-1" onClick={handleLogout}>
                Sign Out
              </Button>
            </div>
            <Button
              variant="ghost"
              className="w-full text-red-600 hover:bg-red-50"
              onClick={() => setConfirmAllDevices(true)}
            >
              Log out from all devices
            </Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
