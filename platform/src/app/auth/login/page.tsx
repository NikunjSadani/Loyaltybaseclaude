'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { sendOTP, verifyOTP } from './actions';
import { cn } from '@/lib/utils';
import { clearAssumedContext } from '@/lib/auth-client';

type Step = 'mobile' | 'otp';

const RESEND_COUNTDOWN = 60;

function getRoleDashboard(role?: string): string {
  const r = role ?? '';
  // Role values match the backend UserRole enum.
  if (r === 'GIFSY_ADMIN') return '/gifsy';
  if (['SSS', 'WHOLESALER', 'SUB_STOCKIST'].includes(r)) return '/partner/dashboard';
  if (['SALES_HO', 'SALES_STATE_HEAD', 'SALES_ASM', 'SALES_SO', 'SALES_ISR'].includes(r)) return '/sales/dashboard';
  return '/admin/dashboard'; // CLIENT_ADMIN, MIS_USER
}

export default function LoginPage() {
  const router = useRouter();
  const toast = useToast();

  const [step, setStep] = useState<Step>('mobile');
  const [mobile, setMobile] = useState('');
  const [mobileError, setMobileError] = useState('');
  // OTP is delivered via SMS only (MSG91). No channel selection — we always send SMS.
  // DEV-ONLY org override (#39): localhost has no real subdomain, so a GIFSY admin (or any non-default
  // tenant) supplies their clientId here. Hidden + ignored in production (Host subdomain is authoritative).
  const [clientId, setClientId] = useState('');
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

  // SessionExpiryGuard bounces here with ?expired=1 when a token expires mid-session.
  // Surface a clear notice so the redirect isn't confusing.
  useEffect(() => {
    if (
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('expired') === '1'
    ) {
      toast.info('Session expired', 'Please sign in again.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

    // A server action can reject at the framework level (the client→server POST
    // failing, a serialization error, etc.) — without try/finally the spinner
    // would never clear. Guarantee it always clears and an error always shows.
    try {
      const result = await sendOTP(mobile, 'SMS');
      if (!result.success) {
        toast.error(result.error ?? 'Failed to send OTP');
        return;
      }
      toast.success('OTP sent via SMS');
      setStep('otp');
      setCountdown(RESEND_COUNTDOWN);
      setTimeout(() => otpRefs.current[0]?.focus(), 100);
    } catch {
      toast.error('Could not send the OTP. Please check your connection and try again.');
    } finally {
      setSending(false);
    }
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

    // Without try/finally a framework-level server-action rejection (the
    // client→server POST failing, a serialization error, etc.) would leave the
    // Verify spinner stuck forever with no error — the "sat forever after I
    // entered the OTP" bug. Guarantee the spinner clears and an error surfaces.
    try {
      const result = await verifyOTP(mobile, code, clientId.trim() || undefined);

      if (!result.success) {
        toast.error(result.error ?? 'Incorrect OTP');
        setOtpError(result.error ?? 'Incorrect OTP');
        setOtp(['', '', '', '', '', '']);
        setTimeout(() => otpRefs.current[0]?.focus(), 100);
        return;
      }

      // A fresh login is a clean session — drop any GIFSY operator assumed-tenant context
      // left over from a prior session, so a stale "working in <brand>" banner can never
      // outlive its token (the banner/token desync that showed an operator empty tenant data).
      clearAssumedContext();

      // Store the JWT where api-client.ts reads it (localStorage → Authorization: Bearer).
      if (result.token) {
        localStorage.setItem('token', result.token);
        if (result.user) localStorage.setItem('user', JSON.stringify(result.user));
      }

      toast.success('Logged in successfully!');
      window.location.href = getRoleDashboard(result.role);
    } catch {
      const msg = 'Could not verify the OTP. Please check your connection and try again.';
      toast.error(msg);
      setOtpError(msg);
      setOtp(['', '', '', '', '', '']);
      setTimeout(() => otpRefs.current[0]?.focus(), 100);
    } finally {
      setVerifying(false);
    }
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
    const result = await sendOTP(mobile, 'SMS');
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
            <div className="flex items-stretch rounded-lg border border-gray-300 overflow-hidden focus-within:border-[var(--brand-primary)] focus-within:ring-2 focus-within:ring-[var(--brand-primary)]/20 transition-all">
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

          {/* DEV-ONLY org override (#39) — hidden in production (subdomain is authoritative there) */}
          {process.env.NODE_ENV !== 'production' && (
            <div>
              <label className="text-sm font-medium text-gray-700 block mb-1.5">
                Organization <span className="text-gray-400 font-normal">(dev — blank = deoleo)</span>
              </label>
              <input
                type="text"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="e.g. gifsy, deoleo, clientb"
                className="w-full px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 bg-white rounded-lg border border-gray-300 focus:outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary)]/20 transition-all"
              />
            </div>
          )}

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
                    'focus:outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary)]/20',
                    digit ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)]/5 text-[var(--brand-primary)]' : 'border-gray-300 bg-white',
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
                <>Resend OTP in <span className="font-semibold text-[var(--brand-primary)]">{countdown}s</span></>
              ) : (
                <>
                  Didn&apos;t receive it?{' '}
                  <button
                    onClick={handleResend}
                    disabled={sending}
                    className="font-semibold text-[var(--brand-primary)] hover:underline disabled:opacity-50"
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
