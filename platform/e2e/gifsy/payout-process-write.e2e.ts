import { test, expect, type Page } from '@playwright/test';
import { cookieToken } from '../helpers/write';

/**
 * W9 / #42 — the REAL INR-payout DISBURSEMENT money path (distinct from the credits-confirm rail in
 * clientAdmin/credits-payout-write). A GIFSY operator ASSUMES the deoleo tenant context
 * (POST /api/auth/assume-tenant — payouts are GIFSY-only and tenant-scoped) and processes a DRAFT
 * PayoutBatch via POST /api/payouts/batches/:id/process. This proves:
 *
 *   1. DISBURSEMENT PERSISTS — the batch goes DRAFT → SUBMITTED with processedAt set, and the one
 *      PENDING transaction is flagged INITIATED; confirmed by a FRESH backend read.
 *   2. NO DOUBLE-DISBURSEMENT — re-processing the same batch finds ZERO remaining PENDING
 *      transactions (they were already INITIATED once) → flags 0, so money never moves twice. This
 *      is the observable money-safety guarantee behind the #42 atomic-claim guard.
 *   3. The CLAIM GUARD rejects a non-processable (COMPLETED) batch with 400 — only DRAFT/SUBMITTED/
 *      FAILED are re-admitted, so a terminal batch can't be re-run.
 *
 * Seeded targets (api/prisma/seed.ts §3.10): a FundLedger receipt with sufficient balance, PayoutBatch
 * seed-pb-1 (DRAFT, one PENDING txn for CP001 which carries a PAN — required by processBatch
 * validation), and PayoutBatch seed-pb-2 (COMPLETED). The seed RESETS pb-1→DRAFT / pt-1→PENDING on a
 * re-run, so a fresh seed re-arms test 1; without a re-seed it SKIPS (pb-1 already SUBMITTED).
 */
const DRAFT_BATCH = 'seed-pb-1';
const COMPLETED_BATCH = 'seed-pb-2';

/**
 * Enter the deoleo operator context (the A2 assume-tenant flow) so subsequent `page.request.*`
 * calls act as the ASSUMED deoleo operator.
 *
 * AF-6 transport note: the edge proxy `headers.delete('authorization')` UNCONDITIONALLY and then
 * injects its own Bearer from the httpOnly `token` COOKIE — so a manual `Authorization: Bearer`
 * header on a request through the FE `/api/*` proxy is IGNORED. The old spec exchanged the GIFSY
 * session for a deoleo token and sent it as a Bearer on the batch requests; the proxy stripped it
 * and re-authenticated from the still-GIFSY cookie, so the batch reads ran at PLATFORM (gifsy) scope
 * and 404'd the deoleo-scoped PayoutBatch. The robust post-AF-6 fix: capture the assume-tenant
 * token and SWAP the browser context's `token` cookie to it — then the proxy injects the DEOLEO
 * token as the Bearer and the backend runs the batch ops under the assumed tenant scope.
 */
async function assumeDeoleo(page: Page): Promise<void> {
  const gifsyToken = await cookieToken(page);
  expect(gifsyToken, 'a live GIFSY session is required').toBeTruthy();
  // The proxy authenticates this call from the GIFSY `token` cookie (any Bearer is stripped), so
  // it runs as the GIFSY operator assuming deoleo — no explicit Authorization header needed.
  const res = await page.request.post('/api/auth/assume-tenant', {
    data: { clientId: 'deoleo' },
  });
  expect(res.status(), 'assume-tenant deoleo must succeed').toBeLessThan(300);
  const j = await res.json();
  const assumedToken = (j.data ?? j).accessToken as string | undefined;
  expect(assumedToken, 'assumed deoleo token must be returned').toBeTruthy();

  // Swap the context's `token` cookie to the assumed deoleo token so every following request
  // (through the proxy's cookie→Bearer injection) authenticates as the assumed deoleo operator.
  // Use the `url` form so the cookie is HOST-ONLY — matching how the login server action set the
  // original `token` cookie — and reliably OVERWRITES it (rather than adding a duplicate).
  const origin = new URL(page.url()).origin;
  await page.context().addCookies([{ name: 'token', value: assumedToken!, url: origin }]);
}

const unwrap = async (res: { json: () => Promise<unknown> }) => {
  const j = (await res.json()) as { data?: unknown };
  return (j.data ?? j) as Record<string, unknown>;
};

test.describe('@gifsy payout batch process — INR disbursement (W9 / #42)', () => {
  test('process a DRAFT batch → SUBMITTED + INITIATED, persists, and never double-disburses', async ({ page }) => {
    await page.goto('/gifsy');
    await assumeDeoleo(page);

    // Pre-condition: pb-1 must be DRAFT (the seed re-arms it). Skip if a prior run consumed it.
    // Requests carry the swapped deoleo `token` cookie; the proxy injects it as the Bearer.
    const preRes = await page.request.get(`/api/payouts/batches/${DRAFT_BATCH}`);
    expect(preRes.status(), 'read the seeded payout batch').toBe(200);
    // GET batches/:id wraps the row under data.batch (alongside data.transactions).
    const preData = await unwrap(preRes);
    const preBatch = (preData.batch ?? preData) as Record<string, unknown>;
    test.skip(
      preBatch.status !== 'DRAFT',
      `${DRAFT_BATCH} is ${String(preBatch.status)}, not DRAFT — re-seed gifsy_dev to re-arm this test`,
    );

    // 1) Process → SUBMITTED, exactly one transaction flagged for disbursement.
    const p1 = await page.request.post(`/api/payouts/batches/${DRAFT_BATCH}/process`);
    expect(p1.status(), 'first process must succeed').toBeLessThan(300);
    const p1data = await unwrap(p1);
    expect(p1data.status, 'batch finalises to SUBMITTED (fund check passed)').toBe('SUBMITTED');
    const flagged1 = (p1data.steps as { disbursement?: { flagged?: number } })?.disbursement?.flagged;
    expect(flagged1, 'exactly one PENDING txn flagged INITIATED').toBe(1);

    // PERSISTENCE: a FRESH read shows the disbursement stuck (not optimistic) — SUBMITTED + processedAt.
    const afterRes = await page.request.get(`/api/payouts/batches/${DRAFT_BATCH}`);
    const afterData = await unwrap(afterRes);
    const afterBatch = (afterData.batch ?? afterData) as Record<string, unknown>;
    expect(afterBatch.status, 'SUBMITTED persisted in the DB').toBe('SUBMITTED');
    expect(afterBatch.processedAt, 'processedAt set on persist').toBeTruthy();

    // 2) NO DOUBLE-DISBURSEMENT: re-process → zero PENDING left → flags 0. The money cannot move
    //    twice because the transactions are already INITIATED, not PENDING.
    const p2 = await page.request.post(`/api/payouts/batches/${DRAFT_BATCH}/process`);
    expect(p2.status(), 'second process call returns cleanly').toBeLessThan(300);
    const p2data = await unwrap(p2);
    const flagged2 = (p2data.steps as { disbursement?: { flagged?: number } })?.disbursement?.flagged;
    expect(flagged2, 'second process must flag 0 — no double-disbursement').toBe(0);
  });

  test('the claim guard rejects a non-processable (COMPLETED) batch with 400', async ({ page }) => {
    await page.goto('/gifsy');
    await assumeDeoleo(page);
    // The swapped deoleo `token` cookie authenticates this through the proxy (Bearer injected from it).
    const res = await page.request.post(`/api/payouts/batches/${COMPLETED_BATCH}/process`);
    expect(res.status(), 'a COMPLETED batch is not in a processable state').toBe(400);
    const body = await res.json();
    expect(JSON.stringify(body)).toMatch(/not in a processable state/i);
  });
});
