import { test, expect } from '@playwright/test';
import { cookieToken, requestAs } from '../helpers/write';

/**
 * SALES_SO KYC first-approve write-persistence (S2 / W5 — gap #38, stage 1).
 *
 * The two-stage KYC model:
 *   Stage 1 — SALES_SO (or ASM / STATE_HEAD) issues POST /v1/kyc/:id/first-approve,
 *              advancing the submission from PENDING_SO_APPROVAL → PENDING_GIFSY.
 *   Stage 2 — GIFSY_ADMIN finalises via per-field verify or bulk-verify.
 *
 * What the SALES_SO role can approve:
 *   canFirstApprove('SALES_SO', status) is TRUE only for PENDING_SO_APPROVAL.
 *   A SALES_SO creates submissions at PENDING_ASM_APPROVAL (because seed-su-1
 *   reports to an ASM manager, so the first-approver above is the ASM). Neither
 *   seed-kyc-1 (PENDING_GIFSY) nor seed-kyc-2 (UNDER_REVIEW) is in
 *   PENDING_SO_APPROVAL. There is no seeded SALES_ISR who would produce a
 *   PENDING_SO_APPROVAL submission.
 *
 * Strategy — check at runtime for a PENDING_SO_APPROVAL row:
 *   a) If one exists (e.g. created by a manual test or a prior run), act on it
 *      and assert the status advance persists.
 *   b) If none exist, SKIP with a clear explanation rather than faking data or
 *      acting on the wrong status (which would 403).
 *
 * This is not a code defect — it reflects the real seed topology. A PENDING_SO_APPROVAL
 * submission can be created by seeding a SALES_ISR user who reports to the SO, or by
 * manually running POST /v1/kyc as that ISR. The spec is written to be re-runnable:
 * once such a row exists, the test passes and subsequent runs will find a PENDING_GIFSY
 * row (which this spec skips), preventing double-approval.
 *
 * Routes used:
 *   GET  /api/kyc?status=PENDING_SO_APPROVAL  — list SALES_SO-approvable submissions
 *   POST /api/kyc/:id/first-approve           — advance to PENDING_GIFSY
 *   GET  /api/kyc/:id                          — fresh re-read to confirm persistence
 *   Cross-role re-read: GET /api/kyc/:id as GIFSY (cross-tenant operator, can read any
 *   submission regardless of tenant) — confirms the new status is persisted in the DB,
 *   not optimistic UI state.
 *
 * Source: api/src/kyc/kyc.controller.ts — POST ':id/first-approve' + GET ':id'.
 *         api/src/kyc/kyc-approval.helper.ts — canFirstApprove + nextStatusAfterFirstApprove.
 */
test.describe('@sales KYC first-approve write-persistence (S2/W5)', () => {
  test('first-approve a PENDING_SO_APPROVAL submission → status becomes PENDING_GIFSY and persists', async ({
    page,
  }) => {
    await page.goto('/sales/kyc');
    const soToken = await cookieToken(page);
    expect(soToken, 'SALES_SO must be logged in (storageState)').toBeTruthy();
    const soAuth = { Authorization: `Bearer ${soToken}` };

    // ── Step 1: find a submission this SO can first-approve ──────────────────
    // The SO can only act on PENDING_SO_APPROVAL (canFirstApprove gate in kyc.service.ts).
    // The seed does NOT have any PENDING_SO_APPROVAL rows for deoleo — see module docblock.
    const listRes = await page.request.get('/api/kyc?status=PENDING_SO_APPROVAL&limit=50', {
      headers: soAuth,
    });
    expect(listRes.status(), 'GET /api/kyc list must succeed').toBe(200);

    const listBody = await listRes.json();
    const submissions: { id: string; status: string }[] = listBody.data?.submissions ?? [];

    // ── SKIP GUARD ────────────────────────────────────────────────────────────
    // No PENDING_SO_APPROVAL submission exists in the current seed state. The seed
    // only provides seed-kyc-1 (PENDING_GIFSY) and seed-kyc-2 (UNDER_REVIEW) for the
    // deoleo tenant. PENDING_SO_APPROVAL is produced by a SALES_ISR → SO chain which is
    // not seeded. This is expected in a fresh dev environment; the test gates correctly
    // rather than silently passing with a 403 or acting on the wrong status.
    if (submissions.length === 0) {
      test.skip(
        true,
        'No PENDING_SO_APPROVAL submission found for the deoleo tenant — the seed does not ' +
          'include a SALES_ISR-created submission that would land in SO-approvable state. ' +
          'To exercise this path: seed or manually create a KYC submission as a SALES_ISR ' +
          "who reports to seed-su-1 (the SALES_SO, phone 9000000003). Once that row exists " +
          'in PENDING_SO_APPROVAL this test will self-activate on the next run.',
      );
      return; // unreachable after skip but TypeScript requires explicit return
    }

    const target = submissions[0];
    expect(target.id, 'picked a real submission id').toBeTruthy();
    expect(target.status, 'pre-condition: submission must be in PENDING_SO_APPROVAL').toBe(
      'PENDING_SO_APPROVAL',
    );

    // ── Step 2: SALES_SO issues first-approve ─────────────────────────────────
    // POST /v1/kyc/:id/first-approve — @Roles(SALES_SO, ...) + @RequirePermission(kyc:approve)
    // On success: status advances to PENDING_GIFSY, returns { nextStatus, submissionId }.
    const approveRes = await page.request.post(`/api/kyc/${target.id}/first-approve`, {
      headers: { ...soAuth, 'Content-Type': 'application/json' },
      data: { remarks: 'E2E first-approve (automated, S2/W5)' },
    });
    expect(
      approveRes.status(),
      `POST /api/kyc/${target.id}/first-approve must succeed (201/200)`,
    ).toBeLessThan(300);

    const approveBody = await approveRes.json();
    expect(
      approveBody.data?.nextStatus ?? approveBody.nextStatus,
      'response nextStatus must be PENDING_GIFSY',
    ).toBe('PENDING_GIFSY');
    expect(
      approveBody.data?.submissionId ?? approveBody.submissionId,
      'response submissionId must match',
    ).toBe(target.id);

    // ── Step 3: PERSISTENCE — re-read as GIFSY (cross-role, cross-tenant operator) ──
    // GIFSY_ADMIN is the canonical cross-tenant reader for KYC (kycTenantFilter returns {}
    // for GIFSY — no clientId filter). This proves the new status actually hit the DB and
    // is not merely an optimistic response from the write endpoint.
    //
    // We do NOT re-read as the SALES_SO because SALES_SO's getOne would see the same
    // in-process response-path. Using GIFSY as the fresh independent reader mirrors the
    // partner/visibility-write.e2e.ts precedent (partner writes → gifsy reads).
    // AF-6: the proxy authenticates from the session COOKIE and ignores any Authorization header, so a
    // page.request read would authenticate as the SALES_SO (the page's cookie), not GIFSY. Use a real
    // GIFSY-cookie request context so this is a genuinely independent cross-role reader.
    const gifsy = await requestAs('gifsy');
    try {
      const readRes = await gifsy.get(`/api/kyc/${target.id}`);
      expect(readRes.status(), `GET /api/kyc/${target.id} as GIFSY must succeed`).toBe(200);

      const readBody = await readRes.json();
      const persistedStatus: string =
        readBody.data?.submission?.status ?? readBody.submission?.status;
      expect(
        persistedStatus,
        `FRESH READ (as GIFSY): submission ${target.id} must be PENDING_GIFSY after SO first-approve`,
      ).toBe('PENDING_GIFSY');
    } finally {
      await gifsy.dispose();
    }
  });
});
