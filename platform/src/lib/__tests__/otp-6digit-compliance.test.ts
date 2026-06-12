/// <reference types="vitest/globals" />
/**
 * TDD — All OTP flows must use 6-digit codes (not 4-digit).
 *
 * RED: these tests fail while the UI pages still say "4-digit".
 * GREEN: passes after every page is updated to 6-digit.
 *
 * Files under test (UI pages):
 *   A — sales/tasks/page.tsx        (scheme-enrollment OTP modal)
 *   B — sales/kyc/new/page.tsx      (KYC submission OTP)
 *   C — sales/kyc/[id]/edit/page.tsx (KYC edit OTP)
 *   D — partner/rewards/page.tsx    (gift/voucher/cashback redemption OTP, ×3 flows)
 *
 * Utility functions (already correct — guarded here to prevent regression):
 *   E — lib/auth.ts           generateOTP()
 *   F — lib/utils.ts          generateOTPCode()
 *   G — lib/msg91.ts          default otp_length
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, it, expect } from 'vitest';
import { generateOTP } from '@/lib/auth';
import { generateOTPCode } from '@/lib/utils';

const src = (rel: string) =>
  readFileSync(resolve(__dirname, '../..', rel), 'utf-8');

// ── A — sales/tasks/page.tsx ────────────────────────────────────────────────

describe('A — sales/tasks/page.tsx OTP modal', () => {
  const code = src('app/sales/tasks/page.tsx');

  it('A1: label does NOT say "4-digit OTP"', () => {
    expect(code).not.toMatch(/4-digit OTP/i);
  });

  it('A2: label DOES say "6-digit OTP"', () => {
    expect(code).toMatch(/6-digit OTP/i);
  });

  it('A3: OTP state array has 6 slots, not 4', () => {
    // 4-element empty-string array: ['','','','']
    expect(code).not.toMatch(/\[['"]['"]\s*,\s*['"]['"]\s*,\s*['"]['"]\s*,\s*['"]['"]]/);
  });

  it('A4: validation threshold is 6, not 4', () => {
    expect(code).not.toMatch(/code\.length\s*<\s*4/);
    expect(code).not.toMatch(/\.join\(['"]['"]?\)\.length\s*<\s*4/);
  });

  it('A5: demo hint says "6 digits", not "4 digits"', () => {
    expect(code).not.toMatch(/any 4 digits/i);
  });
});

// ── B — sales/kyc/new/page.tsx ──────────────────────────────────────────────

describe('B — sales/kyc/new/page.tsx submission OTP', () => {
  const code = src('app/sales/kyc/new/page.tsx');

  it('B1: copy does NOT say "4-digit code"', () => {
    expect(code).not.toMatch(/4-digit code/i);
  });

  it('B2: copy DOES say "6-digit code"', () => {
    expect(code).toMatch(/6-digit code/i);
  });

  it('B3: label does NOT say "Enter 4-digit OTP"', () => {
    expect(code).not.toMatch(/Enter 4-digit OTP/i);
  });

  it('B4: label DOES say "Enter 6-digit OTP"', () => {
    expect(code).toMatch(/Enter 6-digit OTP/i);
  });

  it('B5: OTP input maxLength is 6', () => {
    expect(code).not.toMatch(/maxLength=\{4\}/);
    expect(code).toMatch(/maxLength=\{6\}/);
  });

  it('B6: slice cap is 6', () => {
    // .slice(0, 4) on the submitOtp field → must be .slice(0, 6)
    expect(code).not.toMatch(/slice\(0,\s*4\)/);
  });

  it('B7: validation checks length === 6', () => {
    expect(code).not.toMatch(/submitOtp\.length\s*===\s*4/);
    expect(code).not.toMatch(/submitOtp\.length\s*!==\s*4/);
    expect(code).toMatch(/submitOtp\.length\s*===\s*6/);
  });
});

// ── C — sales/kyc/[id]/edit/page.tsx ────────────────────────────────────────

describe('C — sales/kyc/[id]/edit/page.tsx OTP', () => {
  const code = src('app/sales/kyc/[id]/edit/page.tsx');

  it('C1: OTP input maxLength is 6', () => {
    expect(code).not.toMatch(/maxLength=\{4\}/);
    expect(code).toMatch(/maxLength=\{6\}/);
  });

  it('C2: slice cap is 6', () => {
    expect(code).not.toMatch(/slice\(0,\s*4\)/);
  });

  it('C3: validation checks length === 6', () => {
    expect(code).not.toMatch(/otp\.length\s*===\s*4/);
    expect(code).not.toMatch(/otp\.length\s*!==\s*4/);
    expect(code).toMatch(/otp\.length\s*===\s*6/);
  });
});

// ── D — partner/rewards/page.tsx ─────────────────────────────────────────────

describe('D — partner/rewards/page.tsx redemption OTP (×3 flows)', () => {
  const code = src('app/partner/rewards/page.tsx');

  it('D1: no maxLength={4} anywhere in the file', () => {
    expect(code).not.toMatch(/maxLength=\{4\}/);
  });

  it('D2: at least 3 occurrences of maxLength={6} (one per flow)', () => {
    const matches = code.match(/maxLength=\{6\}/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it('D3: no "length < 4" guard anywhere in the file', () => {
    expect(code).not.toMatch(/otp\.length\s*<\s*4/);
  });

  it('D4: all three handleConfirm guards use length < 6', () => {
    const matches = code.match(/otp\.length\s*<\s*6/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it('D5: placeholder shows 6 dots (not 4)', () => {
    // · · · · is 4-dot placeholder
    expect(code).not.toMatch(/placeholder="· · · ·"/);
    // 6-dot placeholder
    expect(code).toMatch(/placeholder="· · · · · ·"/);
  });

  it('D6: disabled guard uses length < 6', () => {
    expect(code).not.toMatch(/disabled=\{otp\.length\s*<\s*4\}/);
  });
});

// ── E — lib/auth.ts generateOTP() ────────────────────────────────────────────

describe('E — generateOTP() in lib/auth.ts', () => {
  it('E1: returns a string of exactly 6 digits', () => {
    const otp = generateOTP();
    expect(otp).toMatch(/^\d{6}$/);
  });

  it('E2: generates values in range 100000–999999', () => {
    for (let i = 0; i < 20; i++) {
      const n = parseInt(generateOTP(), 10);
      expect(n).toBeGreaterThanOrEqual(100000);
      expect(n).toBeLessThanOrEqual(999999);
    }
  });
});

// ── F — lib/utils.ts generateOTPCode() ───────────────────────────────────────

describe('F — generateOTPCode() in lib/utils.ts', () => {
  it('F1: returns a string of exactly 6 digits', () => {
    const code = generateOTPCode();
    expect(code).toMatch(/^\d{6}$/);
  });
});
