'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { MessageSquare, Phone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { sendOTP, verifyOTP } from './actions';
import { cn } from '@/lib/utils';

type Channel = 'SMS' | 'WHATSAPP';
type Step = 'mobile' | 'otp';

const RESEND_COUNTDOWN = 60;

function getRoleDashboard(role?: string): string {
  const partnerRoles = ['RETAILER', 'WHOLESALER', 'SUB_STOCKIST'];
  const salesRoles = ['SALES_EXECUTIVE', 'TERRITORY_SALES_OFFICER', 'AREA_SALES_MANAGER', 'SALES_MANAGER'];
  if (partnerRoles.includes(role ?? '')) return '/dashboard';
  if (salesRoles.includes(role ?? '')) return '/sales/dashboard';
  return '/admin/dashboard';
}

export default function LoginPage() {
  const router = useRouter();
  const toast = useToast();

  const [step, setStep] = useState<Step>('mobile');
  const [mobile, setMobile] = useState('');
  const [mobileError, setMobileError] = useState('');
  const [channel, setChannel] = useState<Channel>('SMS');
  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [otpError, setOtpError] = useState('');
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [countdown, setCountdown] = useState(0);

  const otpRefs = useRef<Array<HTMLInputElement | null>>([]);

  // Countdown timer
  useEffect(() => {
    if (countdown <= 0) return;
    const id = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [countdown]);

  const validateMobile = (value: string) => {
    if (!value) return 'Mobile number is required';
    if (!/^[6-9]\d{9}$/.test(value)) return 'Enter a valid 10-digit Indian mobile number';
    return '';
  };

  const handleSendOTP = async () => {
    const err = validateMobile(mobile);
    if (err) { setMobileError(err); return; }
    setMobileError('');
    setSending(true);

    const result = await sendOTP(mobile, channel);
    setSending(false);

    if (!result.success) {
      toast.error(result.error ?? 'Failed to send OTP');
      return;
    }

    toast.success(`OTP sent via ${channel === 'SMS' ? 'SMS' : 'WhatsApp'}`);
    setStep('otp');
    setCountdown(RESEND_COUNTDOWN);
    setTimeout(() => otpRefs.current[0]?.focus(), 100);
  };

  const handleOTPChange = (idx: number, value: string) => {
    if (!/^\d?$/.test(value)) return;
    const newOtp = [...otp];
    newOtp[idx] = value;
    setOtp(newOtp);
    setOtpError('');

    if (value && idx < 5) {
      otpRefs.current[idx + 1]?.focus();
    }
  };

  const handleOTPKeyDown = (idx: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !otp[idx] && idx > 0) {
      otpRefs.current[idx - 1]?.focus();
    }
  };

  const handleOTPPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (text.length === 6) {
      setOtp(text.split(''));
      otpRefs.current[5]?.focus();
    }
  };

  const handleVerifyOTP = useCallback(async () => {
    const code = otp.join('');
    if (code.length < 6) { setOtpError('Enter the 6-digit OTP'); return; }
    setOtpError('');
    setVerifying(true);

    const result = await verifyOTP(mobile, code);
    setVerifying(false);

    if (!result.success) {
      toast.error(result.error ?? 'Incorrect OTP');
      setOtpError(result.error ?? 'Incorrect OTP');
      setOtp(['', '', '', '', '', '']);
      setTimeout(() => otpRefs.current[0]?.focus(), 100);
      return;
    }

    toast.success('Logged in successfully!');
    router.push(getRoleDashboard(result.role));
  }, [otp, mobile, router, toast]);

  // Auto-submit when all 6 digits filled
  useEffect(() => {
    if (otp.every((d) => d !== '') && step === 'otp') {
      handleVerifyOTP();
    }
  }, [otp, step, handleVerifyOTP]);

  const handleResend = async () => {
    if (countdown > 0) return;
    setSending(true);
    const result = await sendOTP(mobile, channel);
    setSending(false);
    if (result.success) {
      toast.info('OTP resent');
      setCountdown(RESEND_COUNTDOWN);
      setOtp(['', '', '', '', '', '']);
      setOtpError('');
      setTimeout(() => otpRefs.current[0]?.focus(), 100);
    } else {
      toast.error(result.error ?? 'Failed to resend');
    }
  };

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">
          {step === 'mobile' ? 'Sign in to your account' : 'Enter OTP'}
        </h1>
        <p className="text-sm text-gray-500 mt-2">
          {step === 'mobile'
            ? 'Enter your registered mobile number to continue'
            : `We sent a 6-digit code to +91 ${mobile}`}
        </p>
      </div>

      {step === 'mobile' ? (
        <div className="space-y-5">
          {/* Mobile input */}
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1.5">
              Mobile Number
            </label>
            <div className="flex items-stretch rounded-lg border border-gray-300 overflow-hidden focus-within:border-[#C8102E] focus-within:ring-2 focus-within:ring-[#C8102E]/20 transition-all">
              <div className="px-3 py-2.5 bg-gray-50 border-r border-gray-300 text-sm text-gray-500 font-medium flex items-center">
                +91
              </div>
              <input
                type="tel"
                inputMode="numeric"
                maxLength={10}
                value={mobile}
                onChange={(e) => {
                  const v = e.target.value.replace(/\D/g, '');
                  setMobile(v);
                  if (mobileError) setMobileError(validateMobile(v));
                }}
                onKeyDown={(e) => e.key === 'Enter' && handleSendOTP()}
                placeholder="9876543210"
                className="flex-1 px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 bg-white focus:outline-none"
              />
            </div>
            {mobileError && (
              <p className="mt-1 text-xs text-red-600">{mobileError}</p>
            )}
          </div>

          {/* Channel selector */}
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-2">
              Receive OTP via
            </label>
            <div className="grid grid-cols-2 gap-3">
              {([
                { value: 'SMS', label: 'SMS', icon: Phone },
                { value: 'WHATSAPP', label: 'WhatsApp', icon: MessageSquare },
              ] as const).map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setChannel(value)}
                  className={cn(
                    'flex items-center gap-2 px-4 py-3 rounded-lg border-2 text-sm font-medium transition-all',
                    channel === value
                      ? 'border-[#C8102E] bg-[#C8102E]/5 text-[#C8102E]'
                      : 'border-gray-200 text-gray-600 hover:border-gray-300',
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </button>
              ))}
            </div>
          </div>

          <Button
            variant="primary"
            size="lg"
            className="w-full"
            loading={sending}
            onClick={handleSendOTP}
          >
            Send OTP
          </Button>
        </div>
      ) : (
        <div className="space-y-6">
          {/* OTP inputs */}
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-3">
              6-Digit OTP
            </label>
            <div className="flex gap-2 justify-between">
              {otp.map((digit, idx) => (
                <input
                  key={idx}
                  ref={(el) => { otpRefs.current[idx] = el; }}
                  type="text"
                  inputMode="numeric"
                  maxLength={1}
                  value={digit}
                  onChange={(e) => handleOTPChange(idx, e.target.value)}
                  onKeyDown={(e) => handleOTPKeyDown(idx, e)}
                  onPaste={idx === 0 ? handleOTPPaste : undefined}
                  className={cn(
                    'w-11 h-12 text-center text-lg font-semibold rounded-lg border-2 transition-all',
                    'focus:outline-none focus:border-[#C8102E] focus:ring-2 focus:ring-[#C8102E]/20',
                    digit ? 'border-[#C8102E] bg-[#C8102E]/5 text-[#C8102E]' : 'border-gray-300 bg-white',
                    otpError && !digit ? 'border-red-400' : '',
                  )}
                />
              ))}
            </div>
            {otpError && (
              <p className="mt-2 text-xs text-red-600">{otpError}</p>
            )}
          </div>

          <Button
            variant="primary"
            size="lg"
            className="w-full"
            loading={verifying}
            onClick={handleVerifyOTP}
          >
            Verify OTP
          </Button>

          {/* Resend */}
          <div className="text-center">
            <p className="text-sm text-gray-500">
              {countdown > 0 ? (
                <>Resend OTP in <span className="font-semibold text-[#C8102E]">{countdown}s</span></>
              ) : (
                <>
                  Didn&apos;t receive it?{' '}
                  <button
                    onClick={handleResend}
                    disabled={sending}
                    className="font-semibold text-[#C8102E] hover:underline disabled:opacity-50"
                  >
                    Resend OTP
                  </button>
                </>
              )}
            </p>
          </div>

          {/* Back */}
          <button
            onClick={() => {
              setStep('mobile');
              setOtp(['', '', '', '', '', '']);
              setOtpError('');
            }}
            className="w-full text-sm text-gray-500 hover:text-gray-700 transition-colors"
          >
            ← Change mobile number
          </button>
        </div>
      )}
    </div>
  );
}
