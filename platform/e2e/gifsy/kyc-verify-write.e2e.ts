import { test, expect } from '@playwright/test';
import { cookieToken } from '../helpers/write';

/**
 * GIFSY KYC per-field verify write-persistence (S2 / W5 — gap #38, stage 2).
 *
 * The two-stage KYC model:
 *   Stage 1 — SALES first-approver advances submission to PENDING_GIFSY.
 *   Stage 2 — GIFSY_ADMIN finalises by verifying each of 7 fields (Lane B portal
 *              path) via POST /v1/kyc/:id/verify. Once all 7 fields are terminal
 *              (APPROVED or REJECTED), the bridge auto-transitions the submission.
 *
 * This spec drives Stage 2: a SINGLE field-level verify on seed-kyc-1 (which is
 * already in PENDING_GIFSY per the seed, so it is ready for Gifsy action without
 * requiring Stage 1 to have run first).
 *
 * Why a single-field verify (not approve-all):
 *   POST /v1/kyc/:id/approve bulk-approves all 7 fields and transitions the status
 *   to APPROVED, which is a terminal state. An APPROVED submission cannot be
 *   re-verified, making the spec non-re-runnable in the same DB state. Instead, we
 *   verify ONE field (PAYMENT), which:
 *     (a) leaves the submission in PENDING_GIFSY (bridge needs all 7 to be terminal),
 *     (b) upserts the KycVerificationItem row idempotently (safe to re-run),
 *     (c) proves the write hit the DB by doing a fresh getOne read and asserting
 *         the field's decision in verificationItems[].
 *
 * Idempotency / re-runnable guarantee:
 *   verifyField uses tx.kycVerificationItem.upsert keyed on
 *   (kycSubmissionId, fieldKey), so running this spec twice writes the same row
 *   rather than duplicating it. The bridge re-evaluates on every call but stays in
 *   PENDING_GIFSY because only 1 of 7 fields is set.
 *
 * SKIP guard:
 *   If seed-kyc-1 is no longer in PENDING_GIFSY (e.g. it was fully approved in a
 *   prior run that exercised the approve-all path), the spec skips gracefully rather
 *   than attempting a verify on a non-PENDING_GIFSY row (which the service would 404).
 *   In that case, set up a fresh PENDING_GIFSY row (re-seed or manual KYC + SO first-approve).
 *
 * Routes used:
 *   GET  /api/kyc/seed-kyc-1          — pre-check submission status (as GIFSY)
 *   POST /api/kyc/seed-kyc-1/verify   — verify one field (PAYMENT = APPROVED)
 *   GET  /api/kyc/seed-kyc-1          — fresh re-read to confirm persistence
 *
 * Source: api/src/kyc/kyc.controller.ts — POST ':id/verify' (verifyField, GIFSY_ADMIN only).
 *         api/src/kyc/kyc.service.ts — verifyField: upserts KycVerificationItem, runs bridge,
 *         returns { submissionId, fieldKey, fieldDecision, bridgeResult }.
 *         KycFieldKey enum: PAYMENT | GST_VALIDATION | GST_DOCUMENT | ADDRESS |
 *                           ADDRESS_DOCUMENT | BOARD_PHOTO | OWNER_PHOTO.
 */

/** The seeded PENDING_GIFSY submission for deoleo (seed-kyc-1, cp-idx=0 / CP001). */
const SUBMISSION_ID = 'seed-kyc-1';

/** The field we verify — PAYMENT is the first field in the KycFieldKey enum. */
const FIELD_KEY = 'PAYMENT';

test.describe('@gifsy KYC per-field verify write-persistence (S2/W5)', () => {
  test('verify one field on seed-kyc-1 → KycVerificationItem PERSISTS in a fresh re-read', async ({
    page,
  }) => {
    // Navigate to the Gifsy KYC approvals workspace to ensure GIFSY session is live.
    await page.goto('/admin/kyc/approvals');
    const token = await cookieToken(page);
    expect(token, 'GIFSY must be logged in (storageState)').toBeTruthy();
    const gifsyAuth = { Authorization: `Bearer ${token}` };

    // ── Step 1: pre-condition check — seed-kyc-1 must be PENDING_GIFSY ────────
    // The service's verifyField re-asserts PENDING_GIFSY inside the transaction
    // (kycTenantFilter(GIFSY) = {} so the record is found regardless of clientId).
    // If seed-kyc-1 has been terminal-approved in a prior run, skip gracefully.
    const preCheckRes = await page.request.get(`/api/kyc/${SUBMISSION_ID}`, {
      headers: gifsyAuth,
    });
    expect(
      preCheckRes.status(),
      `GET /api/kyc/${SUBMISSION_ID} pre-check must succeed`,
    ).toBe(200);

    const preBody = await preCheckRes.json();
    const currentStatus: string =
      preBody.data?.submission?.status ?? preBody.submission?.status;

    // ── SKIP GUARD ────────────────────────────────────────────────────────────
    // verifyField only accepts PENDING_GIFSY submissions. Any other terminal status
    // (APPROVED, REJECTED, RE_UPLOAD_REQUIRED) means the submission has already been
    // finalised; re-running the spec on it would 404. Skip explicitly so the failure
    // message explains what happened rather than an opaque 404.
    if (currentStatus !== 'PENDING_GIFSY') {
      test.skip(
        true,
        `${SUBMISSION_ID} is in status "${currentStatus}" (not PENDING_GIFSY) — it has already ` +
          'been finalised and cannot be re-verified. To re-exercise this path: re-seed the DB ' +
          '(npx prisma db seed) to restore seed-kyc-1 to PENDING_GIFSY, or create a fresh ' +
          'KYC submission and advance it to PENDING_GIFSY via the SO first-approve path.',
      );
      return; // unreachable after skip but TypeScript requires explicit return
    }

    expect(currentStatus, 'pre-condition: seed-kyc-1 must be PENDING_GIFSY').toBe('PENDING_GIFSY');

    // ── Step 2: read the current verificationItems so we can compare after ────
    // verifyField upserts, so if PAYMENT was already APPROVED from a prior run the
    // spec still passes — it just updates the existing row. We capture the pre-state
    // for a clear before/after assertion.
    const preItems: { fieldKey: string; decision: string }[] =
      preBody.data?.submission?.verificationItems ?? preBody.submission?.verificationItems ?? [];
    const prePayment = preItems.find((x) => x.fieldKey === FIELD_KEY);

    // ── Step 3: GIFSY verifies the PAYMENT field ──────────────────────────────
    // POST /v1/kyc/:id/verify — @Roles(GIFSY_ADMIN) + @RequirePermission(kyc:gifsy_approve)
    // Body: { fieldKey, decision } — decision APPROVED does NOT require a remark.
    // The service upserts KycVerificationItem (kycSubmissionId, fieldKey) → APPROVED,
    // then evaluates the bridge. With only 1 of 7 fields set, the bridge returns
    // PENDING_GIFSY (no status change), preserving the submission for re-runs.
    const verifyRes = await page.request.post(`/api/kyc/${SUBMISSION_ID}/verify`, {
      headers: { ...gifsyAuth, 'Content-Type': 'application/json' },
      data: {
        fieldKey: FIELD_KEY,
        decision: 'APPROVED',
        // remark is optional when decision === APPROVED
      },
    });
    expect(
      verifyRes.status(),
      `POST /api/kyc/${SUBMISSION_ID}/verify must succeed (200/201)`,
    ).toBeLessThan(300);

    const verifyBody = await verifyRes.json();
    // The service returns { submissionId, fieldKey, fieldDecision, bridgeResult }.
    const verifyData = verifyBody.data ?? verifyBody;
    expect(
      verifyData.submissionId ?? verifyData.submissionId,
      'response submissionId must match',
    ).toBe(SUBMISSION_ID);
    expect(
      verifyData.fieldKey,
      'response fieldKey must match the requested field',
    ).toBe(FIELD_KEY);
    expect(
      verifyData.fieldDecision,
      'response fieldDecision must be APPROVED',
    ).toBe('APPROVED');

    // This spec verifies exactly ONE of the 7 fields, so the submission can never become fully
    // terminal — its status must remain PENDING_GIFSY (no premature flip). We assert that
    // deterministically below rather than trusting the verify response's bridge field (its shape
    // was unreliable — bridgeResult?.next came back undefined).

    // ── Step 4: PERSISTENCE — fresh re-read to confirm DB write ──────────────
    // A SECOND request (different callsite, no shared in-memory state with the write above)
    // reads back the submission and inspects verificationItems[]. This is the persistence
    // proof: the KycVerificationItem row for PAYMENT must now be present as APPROVED.
    //
    // NB: this read is still made as GIFSY_ADMIN — the same session as the write, but a
    // FRESH HTTP request that hits the DB again rather than returning an in-memory cache.
    // The read role does not need to differ here because GIFSY can already read its own
    // writes and the submission is cross-tenant by design (kycTenantFilter = {} for GIFSY).
    // If bridgeNext is PENDING_GIFSY (partial), the submission status must still be
    // PENDING_GIFSY; if the bridge resolved to APPROVED/RE_UPLOAD_REQUIRED, the new status
    // is the persisted bridge outcome — both are valid.
    const readRes = await page.request.get(`/api/kyc/${SUBMISSION_ID}`, { headers: gifsyAuth });
    expect(
      readRes.status(),
      `FRESH GET /api/kyc/${SUBMISSION_ID} after verify must succeed`,
    ).toBe(200);

    const readBody = await readRes.json();
    const readSubmission = readBody.data?.submission ?? readBody.submission;

    // A single field (1 of 7) can never finalize the submission → status MUST remain PENDING_GIFSY.
    expect(
      readSubmission.status,
      'FRESH READ: status must remain PENDING_GIFSY after a partial (1/7-field) verify',
    ).toBe('PENDING_GIFSY');

    // The KEY persistence assertion: the PAYMENT field item is now in verificationItems[].
    const postItems: { fieldKey: string; decision: string }[] =
      readSubmission.verificationItems ?? [];
    const postPayment = postItems.find((x) => x.fieldKey === FIELD_KEY);
    expect(
      postPayment,
      `FRESH READ: KycVerificationItem for ${FIELD_KEY} must be present after verify`,
    ).toBeDefined();
    expect(
      postPayment?.decision,
      `FRESH READ: ${FIELD_KEY} decision must be APPROVED`,
    ).toBe('APPROVED');

    // If the field was already APPROVED before this run (upsert idempotency case), flag it
    // in the test output so the reader knows this was an update-in-place (still valid).
    if (prePayment?.decision === 'APPROVED') {
      console.log(
        `[idempotent] ${FIELD_KEY} was already APPROVED before this run — ` +
          'verifyField upserted the same value; persistence is still confirmed.',
      );
    }
  });
});
