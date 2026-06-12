/// <reference types="vitest/globals" />
/**
 * TDD — KYC Wiring
 *
 * Source-read tests that verify the KYC form wiring and API routes are
 * structurally correct without requiring a live DB or HTTP server.
 *
 * Groups:
 *   A — POST /api/kyc route: accepts full form payload
 *   B — KYC new page:  handleSubmit calls real API
 *   C — KYC edit page: handleSubmit calls PATCH API + accountHolderName
 *   D — KYC consent route: exists and validates OTP
 *   E — Prisma schema: bank + lifecycle fields
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve }                  from 'path';

const src = (rel: string) =>
  readFileSync(resolve(__dirname, '../../..', rel), 'utf-8');
const exists = (rel: string) =>
  existsSync(resolve(__dirname, '../../..', rel));

// ─── A: POST /api/kyc ────────────────────────────────────────────────────────

describe('A — POST /api/kyc route', () => {
  it('A1: accepts accountHolderName in schema', () => {
    const code = src('src/app/api/kyc/route.ts');
    expect(code).toMatch(/accountHolderName/);
  });

  it('A2: accepts documents array', () => {
    const code = src('src/app/api/kyc/route.ts');
    expect(code).toMatch(/documents.*z\.array/s);
  });

  it('A3: accepts signatureDataUrl', () => {
    const code = src('src/app/api/kyc/route.ts');
    expect(code).toMatch(/signatureDataUrl/);
  });

  it('A4: creates KycDocument with type SIGNATURE', () => {
    const code = src('src/app/api/kyc/route.ts');
    expect(code).toMatch(/SIGNATURE/);
    expect(code).toMatch(/kycDocument\.create/);
  });

  it('A5: accepts boardPhotoGeo and paymentGeo', () => {
    const code = src('src/app/api/kyc/route.ts');
    expect(code).toMatch(/boardPhotoGeo/);
    expect(code).toMatch(/paymentGeo/);
  });

  it('A6: updates ChannelPartner with bank details', () => {
    const code = src('src/app/api/kyc/route.ts');
    expect(code).toMatch(/channelPartner\.update/);
    expect(code).toMatch(/bankAccountNumber|bankName/);
  });

  it('A7: preserves escalation routing', () => {
    const code = src('src/app/api/kyc/route.ts');
    expect(code).toMatch(/initialKycStatus/);
    expect(code).toMatch(/detectEscalation/);
  });

  it('A8: has DEMO_MODE fast path', () => {
    const code = src('src/app/api/kyc/route.ts');
    expect(code).toMatch(/DEMO_MODE/);
    expect(code).toMatch(/kyc-demo/);
  });
});

// ─── B: KYC new page handleSubmit ────────────────────────────────────────────

describe('B — KYC new page wiring', () => {
  it('B1: form state includes accountHolderName', () => {
    const code = src('src/app/sales/kyc/new/page.tsx');
    expect(code).toMatch(/accountHolderName:\s*['"]/);
  });

  it('B2: handleSubmit calls fetch("/api/kyc")', () => {
    const code = src('src/app/sales/kyc/new/page.tsx');
    expect(code).toMatch(/fetch\(['"]\/api\/kyc['"]/);
  });

  it('B3: handleSubmit collects signatureDataUrl from canvas', () => {
    const code = src('src/app/sales/kyc/new/page.tsx');
    expect(code).toMatch(/signatureDataUrl/);
    expect(code).toMatch(/toDataURL/);
  });

  it('B4: handleSubmit includes documents array in payload', () => {
    const code = src('src/app/sales/kyc/new/page.tsx');
    expect(code).toMatch(/documents/);
    expect(code).toMatch(/GST_CERTIFICATE|SELFIE|CANCELLED_CHEQUE/);
  });

  it('B5: handleVerifySubmitOtp calls /api/kyc/consent', () => {
    const code = src('src/app/sales/kyc/new/page.tsx');
    expect(code).toMatch(/\/api\/kyc\/consent/);
  });

  it('B6: accountHolderName is passed to BankOrUpiSection', () => {
    const code = src('src/app/sales/kyc/new/page.tsx');
    expect(code).toMatch(/accountHolderName=\{form\.accountHolderName\}/);
  });

  it('B7: sets submissionId from API response', () => {
    const code = src('src/app/sales/kyc/new/page.tsx');
    expect(code).toMatch(/setSubmissionId/);
    expect(code).toMatch(/submissionId/);
  });
});

// ─── C: KYC edit page ────────────────────────────────────────────────────────

describe('C — KYC edit page', () => {
  it('C1: form state includes accountHolderName', () => {
    const code = src('src/app/sales/kyc/[id]/edit/page.tsx');
    expect(code).toMatch(/accountHolderName/);
  });

  it('C2: handleSubmit calls fetch with PATCH method', () => {
    const code = src('src/app/sales/kyc/[id]/edit/page.tsx');
    expect(code).toMatch(/method.*PATCH/s);
    expect(code).toMatch(/\/api\/kyc\//);
  });

  it('C3: Account Holder Name is passed as prop to BankOrUpiSection', () => {
    const code = src('src/app/sales/kyc/[id]/edit/page.tsx');
    // The edit page now uses <BankOrUpiSection accountHolderName={...} /> —
    // the label itself is rendered inside the component, not inline here.
    expect(code).toMatch(/BankOrUpiSection/);
    expect(code).toMatch(/accountHolderName=\{form\.accountHolderName\}/);
  });

  it('C4: accountHolderName included in PATCH body', () => {
    const code = src('src/app/sales/kyc/[id]/edit/page.tsx');
    expect(code).toMatch(/accountHolderName.*form\.accountHolderName/s);
  });

  it('C5: step3Valid includes accountHolderName check', () => {
    const code = src('src/app/sales/kyc/[id]/edit/page.tsx');
    expect(code).toMatch(/step3Valid.*accountHolderName/s);
  });
});

// ─── D: Consent route ────────────────────────────────────────────────────────

describe('D — /api/kyc/consent route', () => {
  it('D1: file exists', () => {
    expect(exists('src/app/api/kyc/consent/route.ts')).toBe(true);
  });

  it('D2: accepts submissionId, mobile, and otp', () => {
    const code = src('src/app/api/kyc/consent/route.ts');
    expect(code).toMatch(/submissionId/);
    expect(code).toMatch(/mobile/);
    expect(code).toMatch(/otp/);
  });

  it('D3: has DEMO_MODE path that accepts any 6-digit OTP', () => {
    const code = src('src/app/api/kyc/consent/route.ts');
    expect(code).toMatch(/DEMO_MODE/);
    expect(code).toMatch(/\\d\{6\}|6.*digits/);
  });
});

// ─── E: Prisma schema ────────────────────────────────────────────────────────

describe('E — Prisma schema changes', () => {
  it('E1: ChannelPartner has bankName field', () => {
    const code = src('prisma/schema.prisma');
    expect(code).toMatch(/bankName\s+String\?/);
  });

  it('E2: ChannelPartner has bankAccountHolder field', () => {
    const code = src('prisma/schema.prisma');
    expect(code).toMatch(/bankAccountHolder\s+String\?/);
  });

  it('E3: ChannelPartner has bankAccountNumber field', () => {
    const code = src('prisma/schema.prisma');
    expect(code).toMatch(/bankAccountNumber\s+String\?/);
  });

  it('E4: Outlet has deactivatedAt field', () => {
    const code = src('prisma/schema.prisma');
    expect(code).toMatch(/deactivatedAt\s+DateTime\?/);
  });

  it('E5: Outlet has reactivatedAt field', () => {
    const code = src('prisma/schema.prisma');
    expect(code).toMatch(/reactivatedAt\s+DateTime\?/);
  });

  it('E6: deactivate route sets deactivatedAt', () => {
    const code = src('src/app/api/admin/outlets/deactivate/route.ts');
    expect(code).toMatch(/deactivatedAt.*new Date/);
  });

  it('E7: reactivate route sets reactivatedAt', () => {
    const code = src('src/app/api/admin/outlets/reactivate/route.ts');
    expect(code).toMatch(/reactivatedAt.*new Date/);
  });
});
