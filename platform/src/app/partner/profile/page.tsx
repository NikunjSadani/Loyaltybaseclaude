'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  User, Phone, CreditCard, Shield, Coins,
  LogOut, ChevronRight, CheckCircle, Clock, AlertTriangle,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Modal } from '@/components/ui/modal';
import { formatPoints, maskAccountNumber } from '@/lib/utils';
import { KYCStatus, ChannelPartnerClass } from '@/types';

interface ProfileData {
  user: { name: string; mobile: string; email?: string };
  partner: { firmName: string; partnerClass: ChannelPartnerClass; kycStatus: KYCStatus; tier: string };
  wallet: { available: number; locked: number; redeemable: number };
  bank: { accountNumber: string; ifscCode: string; bankName: string };
  consent: { dataProcessing: boolean; marketing: boolean; lastUpdated: string };
}

const kycConfig: Record<KYCStatus, { icon: React.ReactNode; label: string; variant: 'success' | 'warning' | 'danger' | 'info' | 'default' }> = {
  [KYCStatus.APPROVED]: { icon: <CheckCircle className="h-4 w-4" />, label: 'KYC Approved', variant: 'success' },
  [KYCStatus.PENDING]: { icon: <Clock className="h-4 w-4" />, label: 'KYC Pending', variant: 'warning' },
  [KYCStatus.SUBMITTED]: { icon: <Clock className="h-4 w-4" />, label: 'KYC Submitted', variant: 'info' },
  [KYCStatus.UNDER_REVIEW]: { icon: <Clock className="h-4 w-4" />, label: 'Under Review', variant: 'info' },
  [KYCStatus.REJECTED]: { icon: <AlertTriangle className="h-4 w-4" />, label: 'KYC Rejected', variant: 'danger' },
  [KYCStatus.RESUBMISSION_REQUIRED]: { icon: <AlertTriangle className="h-4 w-4" />, label: 'Re-upload Required', variant: 'danger' },
};

const tierColors: Record<string, string> = {
  GOLD: 'text-amber-700 bg-amber-50 border-amber-200',
  SILVER: 'text-gray-600 bg-gray-100 border-gray-300',
  PLATINUM: 'text-purple-700 bg-purple-50 border-purple-200',
  BRONZE: 'text-orange-700 bg-orange-50 border-orange-200',
};

const MOCK_PROFILE: ProfileData = {
  user: { name: 'Rajesh Kumar', mobile: '+91 98765 43210', email: 'rajesh@example.com' },
  partner: { firmName: 'Kumar General Store', partnerClass: ChannelPartnerClass.GOLD, kycStatus: KYCStatus.APPROVED, tier: 'GOLD' },
  wallet: { available: 4250, locked: 1200, redeemable: 4250 },
  bank: { accountNumber: '1234567890123456', ifscCode: 'HDFC0001234', bankName: 'HDFC Bank' },
  consent: { dataProcessing: true, marketing: true, lastUpdated: '2026-01-15' },
};

export default function ProfilePage() {
  const router = useRouter();
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [logoutModal, setLogoutModal] = useState(false);
  const [consent, setConsent] = useState({ dataProcessing: true, marketing: true });

  useEffect(() => {
    const t = setTimeout(() => {
      setProfile(MOCK_PROFILE);
      setConsent(MOCK_PROFILE.consent);
      setLoading(false);
    }, 500);
    return () => clearTimeout(t);
  }, []);

  const handleLogout = () => {
    document.cookie = 'session=; Max-Age=0; path=/';
    router.push('/login');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!profile) return null;

  const kycCfg = kycConfig[profile.partner.kycStatus];
  const tierClass = tierColors[profile.partner.tier] ?? 'text-gray-700 bg-gray-50 border-gray-200';

  return (
    <div className="space-y-5 fade-in">
      {/* Profile header */}
      <div className="bg-gradient-to-br from-[#1A1A2E] to-[#16213E] rounded-2xl p-6 text-white">
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 bg-[#C8102E] rounded-2xl flex items-center justify-center text-white text-2xl font-bold">
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
          </div>
        </div>
      </div>

      {/* KYC status */}
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
            <Badge variant={kycCfg.variant}>
              {kycCfg.label}
            </Badge>
          </div>
        </CardContent>
      </Card>

      {/* Contact details */}
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
              { label: 'Mobile', value: profile.user.mobile },
              { label: 'Email', value: profile.user.email ?? '—' },
            ].map((row) => (
              <div key={row.label} className="flex items-center justify-between py-1">
                <span className="text-sm text-gray-500">{row.label}</span>
                <span className="text-sm font-medium text-gray-900">{row.value}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Points mini card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Coins className="h-4 w-4" /> Points Summary
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: 'Available', value: profile.wallet.available, color: 'text-emerald-600' },
              { label: 'Locked', value: profile.wallet.locked, color: 'text-purple-600' },
              { label: 'Redeemable', value: profile.wallet.redeemable, color: 'text-[#C8102E]' },
            ].map((item) => (
              <div key={item.label} className="text-center p-3 bg-gray-50 rounded-xl">
                <p className={`text-lg font-bold ${item.color}`}>{formatPoints(item.value)}</p>
                <p className="text-xs text-gray-500 mt-0.5">{item.label}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Bank details */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CreditCard className="h-4 w-4" /> Payment Details
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {[
              { label: 'Bank', value: profile.bank.bankName },
              { label: 'Account', value: maskAccountNumber(profile.bank.accountNumber) },
              { label: 'IFSC', value: profile.bank.ifscCode },
            ].map((row) => (
              <div key={row.label} className="flex items-center justify-between py-1">
                <span className="text-sm text-gray-500">{row.label}</span>
                <span className="text-sm font-medium text-gray-900 font-mono">{row.value}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* DPDP Consent management */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Shield className="h-4 w-4" /> Your Data (DPDP)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-gray-500 mb-4">
            Manage how Deoleo uses your personal data under the Digital Personal Data Protection Act.
          </p>
          <div className="space-y-3">
            {[
              { key: 'dataProcessing', label: 'Data Processing', desc: 'Required to operate your loyalty account' },
              { key: 'marketing', label: 'Marketing Communications', desc: 'Scheme updates and promotional messages' },
            ].map((item) => (
              <div key={item.key} className="flex items-start gap-3">
                <button
                  onClick={() => setConsent((c) => ({ ...c, [item.key]: !c[item.key as keyof typeof c] }))}
                  className={`mt-0.5 w-10 h-5 rounded-full transition-colors shrink-0 ${
                    consent[item.key as keyof typeof consent] ? 'bg-[#C8102E]' : 'bg-gray-200'
                  }`}
                >
                  <div
                    className={`w-4 h-4 bg-white rounded-full shadow transition-transform mx-0.5 ${
                      consent[item.key as keyof typeof consent] ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
                <div>
                  <p className="text-sm font-medium text-gray-900">{item.label}</p>
                  <p className="text-xs text-gray-500">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Menu links */}
      {[
        { label: 'Change Mobile Number', href: '#' },
        { label: 'Terms & Conditions', href: '#' },
        { label: 'Privacy Policy', href: '#' },
        { label: 'Help & Support', href: '#' },
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

      {/* Logout */}
      <Button
        variant="outline"
        className="w-full text-red-600 border-red-200 hover:bg-red-50"
        onClick={() => setLogoutModal(true)}
      >
        <LogOut className="h-4 w-4" />
        Sign Out
      </Button>

      {/* Logout confirmation modal */}
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
