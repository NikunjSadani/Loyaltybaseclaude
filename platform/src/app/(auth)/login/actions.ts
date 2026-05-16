'use server';

import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';

interface SendOTPResult {
  success: boolean;
  error?: string;
}

interface VerifyOTPResult {
  success: boolean;
  role?: string;
  error?: string;
}

export async function sendOTP(
  mobile: string,
  channel: 'SMS' | 'WHATSAPP',
): Promise<SendOTPResult> {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
    const res = await fetch(`${baseUrl}/api/auth/send-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile, channel }),
    });

    const data = await res.json();

    if (!res.ok) {
      return { success: false, error: data.error ?? 'Failed to send OTP. Please try again.' };
    }

    return { success: true };
  } catch {
    return { success: false, error: 'Network error. Please check your connection.' };
  }
}

export async function verifyOTP(
  mobile: string,
  otp: string,
): Promise<VerifyOTPResult> {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
    const res = await fetch(`${baseUrl}/api/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile, otp }),
    });

    const data = await res.json();

    if (!res.ok) {
      return { success: false, error: data.error ?? 'Invalid OTP. Please try again.' };
    }

    // Set session cookie
    const cookieStore = await cookies();
    cookieStore.set('session', data.data?.token ?? '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: '/',
    });

    return { success: true, role: data.data?.user?.role };
  } catch {
    return { success: false, error: 'Network error. Please check your connection.' };
  }
}

export async function redirectByRole(role: string) {
  const partnerRoles = ['RETAILER', 'WHOLESALER', 'SUB_STOCKIST'];
  const salesRoles = [
    'SALES_EXECUTIVE',
    'TERRITORY_SALES_OFFICER',
    'AREA_SALES_MANAGER',
    'SALES_MANAGER',
  ];
  const adminRoles = ['GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER'];

  if (partnerRoles.includes(role)) {
    redirect('/dashboard');
  } else if (salesRoles.includes(role)) {
    redirect('/sales/dashboard');
  } else if (adminRoles.includes(role)) {
    redirect('/admin/dashboard');
  } else {
    redirect('/dashboard');
  }
}
