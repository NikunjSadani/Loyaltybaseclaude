'use client';

import React, { useState, useEffect } from 'react';
import { Gift, Search, SlidersHorizontal, MapPin, CheckCircle } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast } from '@/components/ui/toast';
import { formatPoints } from '@/lib/utils';
import { cn } from '@/lib/utils';

interface RewardItem {
  id: string;
  name: string;
  description: string;
  pointsCost: number;
  category: string;
  available: boolean;
  popular?: boolean;
  color: string;
}

const CATEGORIES = ['All', 'Vouchers', 'Electronics', 'Lifestyle', 'Food', 'Travel'];

const MOCK_REWARDS: RewardItem[] = [
  { id: 'r1', name: 'Amazon Gift Voucher ₹200', description: 'Redeemable on amazon.in', pointsCost: 200, category: 'Vouchers', available: true, popular: true, color: '#FF9900' },
  { id: 'r2', name: 'Swiggy Credits ₹100', description: 'Food delivery credits', pointsCost: 100, category: 'Food', available: true, color: '#FC8019' },
  { id: 'r3', name: 'Bluetooth Speaker', description: 'JBL portable speaker', pointsCost: 2500, category: 'Electronics', available: true, popular: true, color: '#C8102E' },
  { id: 'r4', name: 'Movie Tickets (2x)', description: 'PVR/INOX cinemas', pointsCost: 400, category: 'Lifestyle', available: true, color: '#7c3aed' },
  { id: 'r5', name: 'Makemytrip Voucher ₹500', description: 'Hotel & flight bookings', pointsCost: 500, category: 'Travel', available: false, color: '#e91e63' },
  { id: 'r6', name: 'Flipkart Voucher ₹300', description: 'Redeemable on flipkart.com', pointsCost: 300, category: 'Vouchers', available: true, color: '#1a73e8' },
  { id: 'r7', name: 'Zomato Credits ₹150', description: 'Food delivery credits', pointsCost: 150, category: 'Food', available: true, color: '#e53935' },
  { id: 'r8', name: 'Wireless Earbuds', description: 'boAt Airdopes earbuds', pointsCost: 1800, category: 'Electronics', available: true, color: '#059669' },
];

type RedemptionStep = 'form' | 'otp' | 'success';

export default function RewardsPage() {
  const toast = useToast();
  const [rewards, setRewards] = useState<RewardItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');
  const [selected, setSelected] = useState<RewardItem | null>(null);
  const [step, setStep] = useState<RedemptionStep>('form');
  const [address, setAddress] = useState({ line1: '', city: '', state: '', pincode: '' });
  const [otp, setOtp] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setRewards(MOCK_REWARDS);
      setLoading(false);
    }, 500);
    return () => clearTimeout(t);
  }, []);

  const filtered = rewards.filter((r) => {
    const matchesSearch = r.name.toLowerCase().includes(search.toLowerCase());
    const matchesCat = category === 'All' || r.category === category;
    return matchesSearch && matchesCat;
  });

  const handleRedeem = async () => {
    if (step === 'form') {
      if (!address.line1 || !address.city || !address.pincode) {
        toast.error('Please fill in all address fields');
        return;
      }
      setSubmitting(true);
      await new Promise((r) => setTimeout(r, 800));
      setSubmitting(false);
      setStep('otp');
      return;
    }

    if (step === 'otp') {
      if (otp.length < 6) {
        toast.error('Enter the 6-digit OTP');
        return;
      }
      setSubmitting(true);
      await new Promise((r) => setTimeout(r, 1000));
      setSubmitting(false);
      setStep('success');
    }
  };

  const closeModal = () => {
    setSelected(null);
    setStep('form');
    setAddress({ line1: '', city: '', state: '', pincode: '' });
    setOtp('');
  };

  return (
    <div className="space-y-5 fade-in">
      <h1 className="text-xl font-bold text-gray-900">Rewards Catalog</h1>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search rewards..."
          className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-gray-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#C8102E]/20 focus:border-[#C8102E]"
        />
      </div>

      {/* Category filters */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {CATEGORIES.map((cat) => (
          <button
            key={cat}
            onClick={() => setCategory(cat)}
            className={cn(
              'px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors shrink-0',
              category === cat
                ? 'bg-[#C8102E] text-white'
                : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300',
            )}
          >
            {cat}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-48">
          <Spinner size="lg" />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Gift className="h-8 w-8" />}
          title="No rewards found"
          description="Try adjusting your search or category filter."
        />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {filtered.map((reward) => (
            <div
              key={reward.id}
              className={cn(
                'bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm',
                'flex flex-col transition-all hover:shadow-md hover:border-gray-300',
                !reward.available && 'opacity-60',
              )}
            >
              {/* Colored image placeholder */}
              <div
                className="h-24 flex items-center justify-center relative"
                style={{ backgroundColor: `${reward.color}15` }}
              >
                <Gift className="h-10 w-10" style={{ color: reward.color }} />
                {reward.popular && (
                  <Badge variant="warning" className="absolute top-2 right-2 text-[10px]">
                    Popular
                  </Badge>
                )}
                {!reward.available && (
                  <div className="absolute inset-0 bg-white/70 flex items-center justify-center">
                    <span className="text-xs font-semibold text-gray-500">Out of stock</span>
                  </div>
                )}
              </div>

              <div className="p-3 flex-1 flex flex-col">
                <p className="text-xs font-semibold text-gray-900 leading-snug line-clamp-2">
                  {reward.name}
                </p>
                <p className="text-[10px] text-gray-400 mt-0.5 line-clamp-1">{reward.description}</p>
                <div className="mt-auto pt-3 flex items-center justify-between">
                  <span className="text-sm font-bold text-[#C8102E]">
                    {formatPoints(reward.pointsCost)} pts
                  </span>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!reward.available}
                    onClick={() => {
                      if (reward.available) {
                        setSelected(reward);
                        setStep('form');
                      }
                    }}
                  >
                    Redeem
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Redemption Modal */}
      {selected && (
        <Modal
          open={!!selected}
          onOpenChange={(o) => !o && closeModal()}
          title={step === 'success' ? 'Redemption Successful!' : `Redeem – ${selected.name}`}
          description={
            step === 'form'
              ? `This will deduct ${formatPoints(selected.pointsCost)} points from your wallet.`
              : step === 'otp'
              ? 'Enter the OTP sent to your registered mobile number.'
              : undefined
          }
        >
          {step === 'form' && (
            <div className="space-y-4">
              <Input
                label="Address Line 1"
                placeholder="House no, Street name"
                value={address.line1}
                onChange={(e) => setAddress((a) => ({ ...a, line1: e.target.value }))}
              />
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="City"
                  placeholder="Mumbai"
                  value={address.city}
                  onChange={(e) => setAddress((a) => ({ ...a, city: e.target.value }))}
                />
                <Input
                  label="State"
                  placeholder="Maharashtra"
                  value={address.state}
                  onChange={(e) => setAddress((a) => ({ ...a, state: e.target.value }))}
                />
              </div>
              <Input
                label="PIN Code"
                placeholder="400001"
                maxLength={6}
                value={address.pincode}
                onChange={(e) => setAddress((a) => ({ ...a, pincode: e.target.value.replace(/\D/g, '') }))}
              />
              <Button variant="primary" className="w-full" loading={submitting} onClick={handleRedeem}>
                Send OTP to confirm
              </Button>
            </div>
          )}

          {step === 'otp' && (
            <div className="space-y-4">
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                <p className="text-sm text-blue-800">
                  <MapPin className="inline h-3.5 w-3.5 mr-1" />
                  Delivering to: {address.line1}, {address.city} – {address.pincode}
                </p>
              </div>
              <Input
                label="6-Digit OTP"
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                placeholder="Enter OTP"
              />
              <Button variant="primary" className="w-full" loading={submitting} onClick={handleRedeem}>
                Confirm Redemption
              </Button>
              <button
                className="w-full text-xs text-gray-500 hover:text-gray-700"
                onClick={() => setStep('form')}
              >
                ← Change address
              </button>
            </div>
          )}

          {step === 'success' && (
            <div className="text-center py-4">
              <div className="flex items-center justify-center mb-4">
                <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center">
                  <CheckCircle className="h-9 w-9 text-emerald-500" />
                </div>
              </div>
              <p className="text-base font-semibold text-gray-900">{selected.name}</p>
              <p className="text-sm text-gray-500 mt-1">
                Your order has been placed. You&apos;ll receive a confirmation SMS.
              </p>
              <div className="mt-4 p-3 bg-gray-50 rounded-xl text-sm text-gray-600 text-left">
                <p><span className="font-medium">Points deducted:</span> {formatPoints(selected.pointsCost)}</p>
                <p className="mt-1"><span className="font-medium">Delivery:</span> {address.city}, {address.pincode}</p>
              </div>
              <Button variant="primary" className="mt-6 w-full" onClick={closeModal}>
                Done
              </Button>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
