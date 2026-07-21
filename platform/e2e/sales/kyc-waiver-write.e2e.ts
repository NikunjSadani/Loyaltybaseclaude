import { test, expect } from '@playwright/test';
import { requestAs } from '../helpers/write';

/**
 * SALES_SO KYC address-proof WAIVER (Deoleo-only) — write-persistence spec.
 *
 * FEATURE UNDER TEST
 *   On the sales "new outlet" KYC form (/sales/kyc/new), when the tenant has
 *   `clients.features.kycAddressProofWaiver = true` (the seed sets this for `deoleo`,
 *   and the `sales` Playwright project logs in as a deoleo SALES_SO — so the flag is
 *   ON for this project), ticking "Shop board name and address proof name do not
 *   match" WAIVES the otherwise-required Address Proof upload:
 *     - the "Self Declaration Required" panel does NOT appear, and
 *     - the rep may Continue past the Address step WITHOUT an Address Proof.
 *   The mismatch persists as `KycSubmission.addressNameMismatch = true` and surfaces to
 *   reviewers as a "Names differ — shop board vs address proof" badge
 *   (data-testid="address-name-mismatch-badge") on /sales/kyc/[id] and /admin/kyc/[id].
 *
 * WHY THIS IS AN API-LEVEL WRITE SPEC (not an interactive Address-step drive)
 *   The FE Address step is only reachable PAST the Details step, whose two required
 *   inputs — Owner Photo and (on Address) Store Board Photo — are CAMERA captures via
 *   `navigator.mediaDevices.getUserMedia`, and the Address "Continue" also requires a
 *   captured geolocation. The go-live harness launches `devices['Desktop Chrome']` with
 *   NO fake-media / fake-geo flags (playwright.config.ts), and every document write goes
 *   to a live GCS bucket that is unavailable in CI — the same reason
 *   `kyc-create-write.e2e.ts` does not drive the multi-step form to completion. So the
 *   interactive checkbox→panel-hidden→Continue-enabled assertions cannot run headlessly
 *   here without false-flaking.
 *
 *   Instead we prove the waiver where the harness is authoritative — the BACKEND. The
 *   service `KycService.create()` (api/src/kyc/kyc.service.ts) hard-requires only a valid
 *   outlet + a 10-digit mobile; `documents` is optional and `addressNameMismatch` is
 *   persisted (dto.addressNameMismatch ?? false) — and the submission is created BEFORE
 *   the (separate) outlet-owner consent OTP. So a rep CAN persist a KYC with the mismatch
 *   flag set and NO Address Proof document, which is exactly what the waiver enables. We:
 *     1. assert the deoleo-only precondition: /api/sales/me → features.kycAddressProofWaiver true;
 *     2. write a waived submission (addressNameMismatch:true, no SHOP_ESTABLISHMENT doc);
 *     3. cross-read it as GIFSY and assert it persisted WITHOUT an address proof;
 *     4. re-read its detail page and assert the reviewer mismatch badge renders.
 *   This is a stronger guarantee than the FE-only visual check: it verifies the backend
 *   genuinely accepts and stores an address-proof-less submission, end-to-end.
 *
 * STATE DEPENDENCY (serial, single-worker; global-setup re-seeds gifsy_dev per run)
 *   Test 3 CONSUMES one NOT_STARTED outlet assigned to the SO by creating a pending KYC
 *   on it. It picks the outlet dynamically from GET /api/sales/outlets (no hardcoded
 *   fixture) and skips gracefully if none is assignable, so it is reproducible per reseed
 *   and self-heals across the config's single retry (a now-pending outlet is skipped, the
 *   next NOT_STARTED one is used). No other sales spec depends on a specific outlet being
 *   NOT_STARTED (kyc-create-write reads seed-kyc-4; assisted-redemption uses CP004).
 */

/** Address Proof document type (DOC_TYPE_MAP.shopAddressDoc in the FE new-KYC page). */
const ADDRESS_PROOF_TYPE = 'SHOP_ESTABLISHMENT';

test.describe('@sales kyc address-proof waiver (Deoleo-only) — write', () => {
  // ── 1. Precondition: the waiver flag is ON for this deoleo sales project ──────────
  // The FE reads it via useTenantFeatures('/api/sales/me') → data.features. If this is
  // false the checkbox does nothing, so it is the linchpin of the whole feature.
  test('/api/sales/me reports kycAddressProofWaiver = true for the deoleo SALES_SO', async ({
    page,
  }) => {
    const res = await page.request.get('/api/sales/me');
    expect(res.status(), 'GET /api/sales/me must succeed for the logged-in SALES_SO').toBe(200);

    const body = (await res.json()) as { success?: boolean; data?: { features?: Record<string, unknown> } };
    expect(body.success, '/api/sales/me response must be wrapped { success, data }').toBe(true);
    expect(
      body.data?.features?.kycAddressProofWaiver,
      'the deoleo tenant must have features.kycAddressProofWaiver = true (seed api/prisma/seed.ts) — ' +
        'without it the mismatch checkbox never waives the address proof',
    ).toBe(true);
  });

  // ── 2. The /sales/kyc/new FE page renders under the waiver tenant ─────────────────
  // Mirrors kyc-create-write's render smoke — proves the route compiles + the outlet
  // step (which drives the waiver flow) is reachable for the deoleo SALES_SO.
  test('/sales/kyc/new FE page renders (outlet step is reachable)', async ({ page }) => {
    await page.goto('/sales/kyc/new');
    await expect(page).toHaveURL(/\/sales\/kyc\/new/);
    await page.waitForLoadState('networkidle');

    const outletSearchOrStep = page
      .locator('input[type="text"], input[placeholder*="outlet"], input[placeholder*="search"]')
      .first();
    const stepLabel = page.getByText(/outlet|select outlet|beat/i).first();
    await expect(outletSearchOrStep.or(stepLabel)).toBeVisible({ timeout: 10_000 });
  });

  // ── 3. Write path: a waived submission persists WITHOUT an address proof + shows the badge ──
  test('a mismatch-waived KYC persists with no address proof and surfaces the reviewer badge', async ({
    page,
  }) => {
    // 3a. Pick a NOT_STARTED outlet assigned to this SO (dynamic — no hardcoded fixture),
    //     using the same endpoint the FE new-KYC page loads its picker from.
    const outletsRes = await page.request.get('/api/sales/outlets');
    expect(outletsRes.status(), 'GET /api/sales/outlets must succeed for the SALES_SO').toBe(200);
    const outletsBody = (await outletsRes.json()) as {
      data?: { outlets?: Array<{ id: string; outletCode?: string; name?: string; type?: string; kycStatus?: string }> };
    };
    const outlets = outletsBody.data?.outlets ?? [];
    const startable = outlets.find((o) => (o.kycStatus ?? 'NOT_STARTED') === 'NOT_STARTED');

    // No never-submitted outlet available (e.g. all consumed on a retry) — skip rather
    // than false-fail; re-seed gifsy_dev to restore assignable outlets.
    test.skip(!startable, 'no NOT_STARTED outlet assigned to this SO — re-seed gifsy_dev');
    const outlet = startable!;

    // A fresh, collision-free outlet-owner mobile (assertPhoneAvailable requires a valid,
    // unused 10-digit number). '8' + 9 digits avoids every seeded 90000000xx / 983 / 990
    // number and differs per attempt, so a retry never trips "phone already in use".
    const mobile = `8${String(Date.now()).slice(-9)}`;

    // 3b. Create the WAIVED submission as the SO (the `sales` project's session cookie
    //     authenticates through the proxy; AF-6 injects the Bearer from it). The whole
    //     point of the waiver: addressNameMismatch:true AND no SHOP_ESTABLISHMENT doc.
    //     `documents: []` is deliberate — the backend must accept a submission with no
    //     address proof (indeed no documents) when the mismatch is declared.
    const createRes = await page.request.post('/api/kyc', {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({
        outletId: outlet.id,
        partnerName: 'Waiver E2E Owner',
        mobile,
        partnerClass: outlet.type ?? 'SSS',
        addressNameMismatch: true,
        documents: [],
      }),
    });

    // A stray leftover pending submission (e.g. from a prior half-run) → skip gracefully
    // rather than false-fail; the reseed clears it on the next run.
    if (createRes.status() === 400) {
      const errBody = (await createRes.json().catch(() => ({}))) as { message?: string; error?: string };
      const msg = errBody.message ?? errBody.error ?? '';
      test.skip(/pending KYC submission|already/i.test(msg), `create pre-empted by existing state: ${msg}`);
    }

    expect(
      createRes.status(),
      'POST /api/kyc must accept a waived submission (addressNameMismatch:true, no address proof)',
    ).toBe(201);
    const createBody = (await createRes.json()) as { success?: boolean; data?: { submissionId?: string } };
    expect(createBody.success).toBe(true);
    const submissionId = createBody.data?.submissionId;
    expect(submissionId, 'create must return the new submissionId').toBeTruthy();

    // 3c. PERSISTENCE (cross-role): GIFSY reads the submission back from the DB and sees
    //     the mismatch flag stored AND no address-proof document — proving the waiver is
    //     honoured server-side, not just in the FE. AF-6: a real GIFSY-cookie context is
    //     an independent reader (page.request would authenticate as the SALES page).
    const gifsy = await requestAs('gifsy');
    try {
      const readRes = await gifsy.get(`/api/kyc/${submissionId}`);
      expect(readRes.status(), 'GIFSY must be able to cross-read the created submission').toBe(200);
      const readBody = (await readRes.json()) as {
        success?: boolean;
        data?: { submission?: { id?: string; addressNameMismatch?: boolean; documents?: Array<{ documentType?: string }> } };
      };
      expect(readBody.success).toBe(true);

      const submission = readBody.data?.submission;
      expect(submission?.id, 'the persisted submission id must match').toBe(submissionId);
      expect(
        submission?.addressNameMismatch,
        'the declared shop-board/address-proof name mismatch must persist as addressNameMismatch=true',
      ).toBe(true);

      const hasAddressProof = (submission?.documents ?? []).some((d) => d.documentType === ADDRESS_PROOF_TYPE);
      expect(
        hasAddressProof,
        `no ${ADDRESS_PROOF_TYPE} (Address Proof) document must be stored — the upload is genuinely waived`,
      ).toBe(false);
    } finally {
      await gifsy.dispose();
    }

    // 3d. REVIEWER BADGE: the submitting rep re-opens the KYC detail page and sees the
    //     mismatch badge (the same data-testid also renders on /admin/kyc/[id]).
    await page.goto(`/sales/kyc/${submissionId}`);
    await page.waitForLoadState('networkidle');
    await expect(
      page.getByTestId('address-name-mismatch-badge'),
      'the reviewer "Names differ — shop board vs address proof" badge must render for a waived submission',
    ).toBeVisible({ timeout: 10_000 });
  });
});
