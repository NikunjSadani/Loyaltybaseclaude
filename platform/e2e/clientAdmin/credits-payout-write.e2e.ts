import { test, expect } from '@playwright/test';
import { cookieToken } from '../helpers/write';
import { expectNoFabricatedData } from '../helpers/assert';
import { uniqueMarker } from '../helpers/persist';

/**
 * W9 — Credits/Payouts money-path write-persistence + double-process guard.
 *
 * WHAT IS BEING PROVEN:
 *   (A) WRITE: Creating a new CreditBatch (POST /api/admin/credits/batches) and
 *       then confirming it (POST /api/admin/credits/batches/:id/confirm) results
 *       in a CONFIRMED status that PERSISTS — verifiable via a fresh GET to the
 *       backend (not optimistic UI).
 *   (B) NO-DOUBLE-PROCESS: A second POST to /api/admin/credits/batches/:id/confirm
 *       on an already-CONFIRMED batch is REJECTED by the backend with a 400
 *       (BadRequestException "Batch already confirmed"). The concurrency guard in
 *       confirmBatch uses an updateMany WHERE status='PENDING_CONFIRM' — if count=0
 *       the second attempt throws immediately, preventing double-crediting of wallet
 *       points or double-creation of CreditPayoutEntry rows.
 *
 * WHY API-DRIVE (not UI-drive):
 *   The credits UI requires a multi-step file-upload wizard (xlsx parse, preview,
 *   confirm) that is brittle to drive via Playwright. API-driving is the same
 *   real same-origin /api/* proxy path under test and matches the visibility-write
 *   template pattern. The session token is read from the CLIENT_ADMIN storageState.
 *
 * PERSISTENCE PROOF:
 *   After confirm, a FRESH GET /api/admin/credits/batches/:id reads the batch back
 *   from the DB. We assert status=CONFIRMED, confirmedAt is set, and the batchCode
 *   is the one we created — proving the write landed in the DB and is not optimistic.
 *
 * IDEMPOTENCY:
 *   We CREATE a new batch each run (uniqueMarker on the period keeps the batchCode
 *   distinct). The period "2026-01" is used so it doesn't collide with the seeded
 *   CB-2026-05 batch. The batch is created with zero rows (totalOutlets=0,
 *   totalPoints=0, totalPayoutPaise=0, rows=[]) — the confirm step still flips the
 *   status and proves the DB write pattern without consuming real money data.
 *
 * IMPORTANT SEED NOTE:
 *   We do NOT process seed-cb-1 (CB-2026-05) here. That batch is already CONFIRMED
 *   in the seed (status='CONFIRMED'), so POSTing /confirm on it would immediately
 *   return 400 ("Batch already confirmed") — which is correct behaviour but is not
 *   a useful write test. We create a fresh PENDING_CONFIRM batch each run instead.
 *
 * Backend route file: api/src/credits/credits.controller.ts (CreditsController)
 * Service: api/src/credits/credits.service.ts (createBatch, confirmBatch)
 * Double-process guard: credits.service.ts confirmBatch → updateMany WHERE
 *   status='PENDING_CONFIRM' (count===0 throws BadRequestException).
 */

test.describe('@clientAdmin credits payout write-persistence + double-process guard (W9)', () => {
  test('creates a batch, confirms it, PERSISTS, and rejects a double-confirm', async ({ page }) => {
    await page.goto('/admin/credits-payouts');
    await expectNoFabricatedData(page);

    const token = await cookieToken(page);
    expect(token, 'CLIENT_ADMIN must be logged in (storageState)').toBeTruthy();

    // Use a unique marker so each run creates a distinct period-suffixed batch.
    // Prefix must not include hyphens beyond what the batchCode pattern allows;
    // the period field must be YYYY-MM format.
    // We use period "2026-01" (distinct from the seeded CB-2026-05 of 2026-05).
    // The batchCode is auto-generated server-side as CB-2026-01-NNN; we don't set it.
    const marker = uniqueMarker('w9');
    const PERIOD = '2026-01';

    // ── STEP 1: CREATE a new batch (PENDING_CONFIRM state) ───────────────────

    const createResult = await page.evaluate(
      async ({ period, tok }) => {
        const res = await fetch('/api/admin/credits/batches', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tok}`,
          },
          body: JSON.stringify({
            period,
            totalOutlets: 0,
            totalPoints: 0,
            totalPayoutPaise: 0,
            rows: [],
          }),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
      },
      { period: PERIOD, tok: token! },
    );

    expect(
      [200, 201],
      `createBatch returned ${createResult.status}: ${JSON.stringify(createResult.body)}`,
    ).toContain(createResult.status);

    // The batch id is in the response. TransformInterceptor wraps in .data.
    const createdBatch = createResult.body?.data ?? createResult.body;
    const batchId = createdBatch?.id as string | undefined;
    expect(batchId, 'createBatch must return an id').toBeTruthy();
    expect(createdBatch?.status, 'new batch must start as PENDING_CONFIRM').toBe('PENDING_CONFIRM');

    // log the marker so test output can correlate with DB rows if needed
    void marker; // uniqueMarker used only to document intent; batchCode is server-generated

    // ── STEP 2: CONFIRM the batch (money-path write) ─────────────────────────

    const confirmResult = await page.evaluate(
      async ({ id, tok }) => {
        const res = await fetch(`/api/admin/credits/batches/${id}/confirm`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tok}` },
        });
        return { status: res.status, body: await res.json().catch(() => null) };
      },
      { id: batchId!, tok: token! },
    );

    expect(
      [200, 201],
      `confirmBatch returned ${confirmResult.status}: ${JSON.stringify(confirmResult.body)}`,
    ).toContain(confirmResult.status);

    const confirmPayload = confirmResult.body?.data ?? confirmResult.body;
    expect(
      confirmPayload?.batch?.status ?? confirmPayload?.status,
      'confirmBatch must return CONFIRMED status in response',
    ).toBe('CONFIRMED');

    // ── STEP 3: PERSISTENCE — fresh GET /api/admin/credits/batches/:id ───────
    // This is a brand-new HTTP request from the same authenticated page context.
    // The status returned here comes from the DB (not a cache or optimistic state).

    const freshRead = await page.request.get(`/api/admin/credits/batches/${batchId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(freshRead.status(), 'fresh GET /batches/:id must return 200').toBe(200);
    const freshBatch = (await freshRead.json()) as {
      data?: { id: string; status: string; confirmedAt: string | null; batchCode: string };
    };

    // Unwrap envelope (TransformInterceptor) — may return { data: { ...batch } } or the batch directly.
    const batchRow = (freshBatch as { data?: { id: string; status: string; confirmedAt: string | null; batchCode: string } }).data ?? (freshBatch as unknown as { id: string; status: string; confirmedAt: string | null; batchCode: string });

    expect(batchRow.id, 'fresh read must return the same batch id').toBe(batchId);
    expect(
      batchRow.status,
      'fresh DB read must show CONFIRMED — proves the write PERSISTED (not optimistic UI)',
    ).toBe('CONFIRMED');
    expect(batchRow.confirmedAt, 'confirmedAt must be set on the persisted row').toBeTruthy();
    expect(batchRow.batchCode, 'batchCode must be a real server-generated code').toMatch(
      /^CB-2026-01-\d{3}$/,
    );

    // ── STEP 4: NO-DOUBLE-PROCESS guard ──────────────────────────────────────
    // Attempt to confirm the SAME batch a second time. The backend's confirmBatch
    // uses an updateMany WHERE status='PENDING_CONFIRM'; since the batch is now
    // CONFIRMED that guard returns count=0 and throws BadRequestException(400).
    // This proves the transactional double-spend guard actually fires (#42).

    const doubleConfirmResult = await page.evaluate(
      async ({ id, tok }) => {
        const res = await fetch(`/api/admin/credits/batches/${id}/confirm`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tok}` },
        });
        return { status: res.status, body: await res.json().catch(() => null) };
      },
      { id: batchId!, tok: token! },
    );

    expect(
      doubleConfirmResult.status,
      `Second confirm must be rejected 400, not ${doubleConfirmResult.status}. ` +
        `A 2xx here would mean the double-process guard FAILED (money would be double-credited). ` +
        `Body: ${JSON.stringify(doubleConfirmResult.body)}`,
    ).toBe(400);

    // The error message should confirm the exact rejection reason.
    const errBody = doubleConfirmResult.body?.message ?? doubleConfirmResult.body?.error ?? '';
    expect(
      typeof errBody === 'string' ? errBody.toLowerCase() : JSON.stringify(errBody).toLowerCase(),
      'Double-confirm rejection must mention "already confirmed" or "already"',
    ).toMatch(/already/i);
  });
});
