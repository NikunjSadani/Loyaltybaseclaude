import { test, expect } from '@playwright/test';
import { requestAs } from '../helpers/write';

/**
 * SALES_SO KYC address-proof name-mismatch WAIVER (Deoleo-only) — write-persistence spec.
 *
 * FEATURE UNDER TEST
 *   On the sales "new outlet" KYC form (/sales/kyc/new), when the tenant has
 *   `clients.features.kycAddressProofWaiver = true` (the seed sets this for `deoleo`,
 *   and the `sales` Playwright project logs in as a deoleo SALES_SO — so the flag is
 *   ON for this project), ticking "Shop board name and address proof name do not
 *   match" DROPS the extra signed SELF-DECLARATION document that a non-waiver tenant
 *   would otherwise have to download, fill, sign, and upload:
 *     - the "Self Declaration Required" panel does NOT appear, and
 *     - the rep may Continue past the Address step without that self-declaration.
 *   The **Address Proof upload itself stays required** either way — the waiver only
 *   removes the self-declaration. The mismatch persists as
 *   `KycSubmission.addressNameMismatch = true` and surfaces to reviewers as a
 *   "Names differ — shop board vs address proof" badge
 *   (data-testid="address-name-mismatch-badge") on /sales/kyc/[id] and /admin/kyc/[id].
 *
 *   The FE document gating itself (address proof ALWAYS required; self-declaration
 *   dropped only when the waiver is ON) is pure and unit-tested in
 *   platform/src/lib/__tests__/kyc-document-gating.test.ts — that is where the
 *   "address proof never becomes optional" guarantee is locked. This spec proves the
 *   two backend-observable halves: the tenant precondition and the mismatch-flag
 *   persistence + reviewer surface.
 *
 * WHY THIS IS AN API-LEVEL WRITE SPEC (not an interactive Address-step drive)
 *   The FE Address step is only reachable PAST the Details step, whose required inputs —
 *   Owner Photo and (on Address) Store Board Photo — are CAMERA captures via
 *   `navigator.mediaDevices.getUserMedia`, and the Address "Continue" also requires a
 *   captured geolocation. The go-live harness launches `devices['Desktop Chrome']` with
 *   NO fake-media / fake-geo flags (playwright.config.ts), and every document write goes
 *   to a live GCS bucket that is unavailable in CI — the same reason
 *   `kyc-create-write.e2e.ts` does not drive the multi-step form to completion. So the
 *   interactive checkbox→panel-hidden→Continue-enabled assertions cannot run headlessly
 *   here without false-flaking.
 *
 *   Instead we prove the backend-observable behaviour where the harness is authoritative.
 *   The service `KycService.create()` (api/src/kyc/kyc.service.ts) hard-requires only a
 *   valid outlet + a 10-digit mobile; `documents` is optional and `addressNameMismatch`
 *   is persisted (dto.addressNameMismatch ?? false) — the flag is accepted on ANY tenant
 *   (document requirements are an FE gate, not a backend one). We:
 *     1. assert the deoleo-only precondition: /api/sales/me → features.kycAddressProofWaiver true;
 *     2. write a submission with the mismatch declared (addressNameMismatch:true);
 *     3. cross-read it as GIFSY and assert the flag persisted server-side;
 *     4. re-read its detail page and assert the reviewer mismatch badge renders.
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

test.describe('@sales kyc address-proof name-mismatch waiver (Deoleo-only) — write', () => {
  // ── 1. Precondition: the waiver flag is ON for this deoleo sales project ──────────
  // The FE reads it via useTenantFeatures('/api/sales/me') → data.features. If this is
  // false the checkbox never drops the self-declaration, so it is the linchpin.
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
        'without it the mismatch checkbox never drops the self-declaration',
    ).toBe(true);
  });

  // ── 2. The /sales/kyc/new FE page renders under the waiver tenant ─────────────────
  // Mirrors kyc-create-write's render smoke — proves the route compiles + the outlet
  // step (which drives the mismatch flow) is reachable for the deoleo SALES_SO.
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

  // ── 3. Write path: a declared-mismatch KYC persists the flag + surfaces the badge ──
  test('a declared-mismatch KYC persists addressNameMismatch and surfaces the reviewer badge', async ({
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

    // 3b. Create the submission as the SO (the `sales` project's session cookie
    //     authenticates through the proxy; AF-6 injects the Bearer from it) with the
    //     mismatch declared. The backend accepts addressNameMismatch on any tenant and
    //     `documents` is optional server-side (document requirements are the FE's job),
    //     so a minimal submission is sufficient to exercise the persistence path.
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
      'POST /api/kyc must accept a submission with the mismatch declared (addressNameMismatch:true)',
    ).toBe(201);
    const createBody = (await createRes.json()) as { success?: boolean; data?: { submissionId?: string } };
    expect(createBody.success).toBe(true);
    const submissionId = createBody.data?.submissionId;
    expect(submissionId, 'create must return the new submissionId').toBeTruthy();

    // 3c. PERSISTENCE (cross-role): GIFSY reads the submission back from the DB and sees
    //     the mismatch flag stored — proving the audit trail is honoured server-side, not
    //     just in the FE. AF-6: a real GIFSY-cookie context is an independent reader
    //     (page.request would authenticate as the SALES page).
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

      // Sanity: this minimal API-level submission carried no documents. (The FE keeps the
      // Address Proof mandatory — see kyc-document-gating.test.ts — but the backend does
      // not enforce it, which is why this API-level write path can persist without one.)
      const hasAddressProof = (submission?.documents ?? []).some((d) => d.documentType === ADDRESS_PROOF_TYPE);
      expect(
        hasAddressProof,
        `this minimal submission was created with documents:[] — no ${ADDRESS_PROOF_TYPE} is expected server-side`,
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
      'the reviewer "Names differ — shop board vs address proof" badge must render for a declared-mismatch submission',
    ).toBeVisible({ timeout: 10_000 });
  });
});
