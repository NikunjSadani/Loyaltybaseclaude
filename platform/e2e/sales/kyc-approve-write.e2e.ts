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
 *   The seed provides seed-kyc-4 (partner CP001/O001) in PENDING_SO_APPROVAL as the dedicated
 *   first-approve target (seed.ts §3.9). Its update path RE-ARMS the status to
 *   PENDING_SO_APPROVAL on every re-seed, so a fresh DB always has exactly this row to act on.
 *   (seed-kyc-1 is PENDING_GIFSY and seed-kyc-2 is UNDER_REVIEW — neither is SO-approvable.)
 *
 * Strategy — find the PENDING_SO_APPROVAL row at runtime:
 *   a) If one exists (seed-kyc-4 on a fresh seed, or any downline row), act on it and assert
 *      the status advance persists.
 *   b) If none exist (a prior run already advanced seed-kyc-4 and the DB was not re-seeded),
 *      SKIP with a clear explanation rather than acting on the wrong status (which would 403).
 *
 * Re-runnable: once seed-kyc-4 is advanced to PENDING_GIFSY it is no longer SO-approvable, so a
 * second run without a re-seed skips (preventing double-approval). Re-seed to re-arm.
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
    // The seed provides seed-kyc-4 (partner CP001/O001) in PENDING_SO_APPROVAL — the update
    // path RE-ARMS it to PENDING_SO_APPROVAL on every re-seed (seed.ts §3.9), so a fresh DB
    // always has exactly this target.
    //
    // NOTE: GET /api/kyc honours the `?status=` filter ONLY for tenant-wide readers
    // (kyc.service.ts:1353 — `q.status && canReadTenantWide(role)`). A SALES_SO is NOT
    // tenant-wide, so the status query param is IGNORED and the list returns the SO's WHOLE
    // downline in every status, newest-first. We therefore filter client-side for the
    // PENDING_SO_APPROVAL row rather than trusting submissions[0] (which is nondeterministic
    // once runtime downline rows exist).
    const listRes = await page.request.get('/api/kyc?status=PENDING_SO_APPROVAL&limit=50', {
      headers: soAuth,
    });
    expect(listRes.status(), 'GET /api/kyc list must succeed').toBe(200);

    const listBody = await listRes.json();
    const submissions: { id: string; status: string }[] = listBody.data?.submissions ?? [];
    const target = submissions.find((s) => s.status === 'PENDING_SO_APPROVAL');

    // ── SKIP GUARD ────────────────────────────────────────────────────────────
    // No PENDING_SO_APPROVAL submission is currently in the SO's downline. This happens when
    // a prior run already advanced seed-kyc-4 to PENDING_GIFSY and the DB has not been
    // re-seeded. The test gates correctly rather than acting on the wrong status (which would
    // 403) — re-seed gifsy_dev (npx prisma db seed) to re-arm seed-kyc-4.
    if (!target) {
      test.skip(
        true,
        'No PENDING_SO_APPROVAL submission found in the SO downline — seed-kyc-4 was likely ' +
          'already advanced to PENDING_GIFSY by a prior run. Re-seed gifsy_dev (npx prisma db ' +
          'seed) to re-arm the seed-kyc-4 first-approve target; this test then self-activates.',
      );
      return; // unreachable after skip but TypeScript requires explicit return
    }

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
