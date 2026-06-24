/// <reference types="vitest/globals" />
/**
 * TDD — KYC Wiring (page-side)
 *
 * Source-read tests that verify the KYC form PAGE wiring is structurally correct.
 * The route-side + Prisma-schema groups (old A/D/E) were retired with D2 (#31) —
 * those `app/api/kyc/*` routes + the platform `prisma/schema.prisma` are gone; the
 * KYC backend logic now lives in `api/src/kyc`. The surviving groups assert the FE
 * pages call the (proxied) `/api/kyc*` endpoints with the right payload.
 *
 *   B — KYC new page:  handleSubmit calls real API
 *
 * (The standalone KYC edit page was retired — re-entry/resubmission now routes the
 *  junior back into the pre-filled new-KYC wizard via /sales/kyc/new?outletId=...,
 *  so the old `[id]/edit` page + its source-read tests (group C) were removed.)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve }      from 'path';

const src = (rel: string) =>
  readFileSync(resolve(__dirname, '../../..', rel), 'utf-8');

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
