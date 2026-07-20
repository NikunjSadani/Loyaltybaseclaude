import { test, expect } from '@playwright/test';
import { requestAs } from '../helpers/write';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * W7 — Scheme enrollment write-persistence.
 *
 * Proves that POST /api/schemes/seed-scheme-1/enroll (→ /v1/schemes/seed-scheme-1/enroll)
 * actually writes a SchemeEnrollment row to the DB — not optimistic UI.
 *
 * WHY PARTNER TOKEN (not clientAdmin):
 *   POST /v1/schemes/:id/enroll is role-gated to WHOLESALER / SUB_STOCKIST / SSS /
 *   SALES_* (see schemes.controller.ts line ~115). CLIENT_ADMIN is explicitly NOT in
 *   that list — the admin role manages schemes, not enrollments. The clientAdmin
 *   storageState is therefore used only to navigate (for expectNoFabricatedData on the
 *   page) and to establish the same-origin proxy context; the enrollment write itself
 *   uses the seeded PARTNER token (WHOLESALER = seed-cp-1 / CP001 / phone 9000000002)
 *   read from the partner storageState via tokenFor('partner'). This is the same
 *   cross-role read pattern used in visibility-write.e2e.ts (tokenFor('gifsy')).
 *
 * PERSISTENCE PROOF:
 *   After the POST, we call GET /api/schemes/seed-scheme-1/my-enrollment using the
 *   same partner token. This endpoint returns the caller's own SchemeEnrollment row
 *   from the DB (404 if none). Finding a 200 + status=ACTIVE proves the write landed.
 *
 * SCHEME USED: seed-scheme-1 / DEMO-VIS (ACTIVE, 2020-01-01 → 2030-12-31, no form).
 *   Wide date window → always enrollable regardless of server clock.
 *   No enrollment form configured → `formValues: {}` is accepted without validation.
 *
 * IDEMPOTENCY:
 *   submitEnrollment uses upsert(@@unique[schemeId, userId]) — re-running always
 *   returns 200/201 with ACTIVE status. The persistence assertion is safe to re-run
 *   because the my-enrollment read will always return the (re-upserted) row.
 *
 * SEED DEPENDENCY: partner storageState must exist (.auth/partner.json).
 *   This file is written by the setup project (npm run e2e -- --project=setup).
 *   If missing, tokenFor('partner') throws a clear error.
 *
 * Backend route file: api/src/schemes/schemes.controller.ts (SchemesController)
 * Service: api/src/schemes/schemes.service.ts (submitEnrollment, getMyEnrollment)
 * Seed: api/prisma/seed.ts §3.8 — scheme seed-scheme-1 (DEMO-VIS, ACTIVE)
 *       §3.3 — partner seed-cp-1 (CP001, WHOLESALER, userId=seed-deoleo-partner)
 */

const SCHEME_ID = 'seed-scheme-1';

test.describe('@clientAdmin scheme enrollment write-persistence (W7)', () => {
  test('enrolling the seeded partner in DEMO-VIS PERSISTS in a fresh read', async ({ page }) => {
    // Navigate as CLIENT_ADMIN so we can call expectNoFabricatedData on the schemes page.
    await page.goto('/admin/schemes');
    await expectNoFabricatedData(page);

    // Cross-role: POST /v1/schemes/:id/enroll is role-gated to WHOLESALER/SUB_STOCKIST/SSS/SALES_*
    // (NOT CLIENT_ADMIN). AF-6: the proxy authenticates from the request's session COOKIE and ignores
    // any Authorization header, so an in-page fetch / page.request would run as the CLIENT_ADMIN page
    // session (→ 403 on enroll, wrong caller on my-enrollment). Use a real PARTNER-cookie request
    // context (seed-cp-1 / CP001 / WHOLESALER) so the write + read genuinely run as the partner.
    const partner = await requestAs('partner');
    try {
      // Helper: read the partner's current enrollment for this scheme (fresh DB read).
      const readEnrollment = async (): Promise<{ id: string; status: string } | null> => {
        const r = await partner.get(`/api/schemes/${SCHEME_ID}/my-enrollment`);
        if (r.status() === 404) return null;
        expect(r.status(), 'my-enrollment GET must return 200 or 404').toBe(200);
        const j = await r.json();
        // TransformInterceptor envelope: { data: { enrollment: {...} } } or { enrollment: {...} }
        return (j.data?.enrollment ?? j.enrollment) as { id: string; status: string } | null;
      };

      // Step 1: note pre-enrollment state (may already exist from a previous run — idempotent).
      const before = await readEnrollment();

      // Step 2: POST enroll (SELF mode — the partner enrolls themselves).
      const enrollRes = await partner.post(`/api/schemes/${SCHEME_ID}/enroll`, {
        headers: { 'Content-Type': 'application/json' },
        data: { enrollmentMode: 'SELF', formValues: {} },
      });
      const enrollBody = await enrollRes.json().catch(() => null);

      // Enrollment must succeed (200 or 201). On re-run the upsert returns 200.
      expect(
        [200, 201],
        `enroll returned ${enrollRes.status()}: ${JSON.stringify(enrollBody)}`,
      ).toContain(enrollRes.status());

      const enrollPayload = enrollBody?.data ?? enrollBody;
      const enrollment = enrollPayload?.enrollment as
        | { id: string; status: string; enrollmentMode: string }
        | undefined;

      expect(enrollment?.id, 'enroll response must include an enrollment id').toBeTruthy();
      expect(enrollment?.status, 'enrollment status must be ACTIVE in the response').toBe('ACTIVE');
      expect(enrollment?.enrollmentMode, 'enrollment mode must be SELF').toBe('SELF');

      const newEnrollmentId = enrollment!.id;

      // Step 3: PERSISTENCE PROOF — a FRESH GET /api/schemes/:id/my-enrollment returns
      // this enrollment from the DB (not from response state, not optimistic UI).
      // We poll so transient read-lag in staging is tolerated.
      const freshEnrollment = await expect
        .poll(readEnrollment, {
          timeout: 10_000,
          message: `Fresh GET /api/schemes/${SCHEME_ID}/my-enrollment must return the enrollment after POST`,
        })
        .not.toBeNull();

      // Narrow the type for assertions (expect.poll resolves to the polled value).
      const persisted = (await readEnrollment()) as { id: string; status: string } | null;
      expect(persisted, 'enrollment must be readable from the DB after write').not.toBeNull();
      expect(persisted!.status, 'persisted enrollment must be ACTIVE').toBe('ACTIVE');

      if (before === null) {
        // First-run: the enrollment id must be the one just created.
        expect(persisted!.id, 'new enrollment id must match the response id').toBe(newEnrollmentId);
      } else {
        // Re-run (idempotent upsert): the same record exists and is still ACTIVE.
        // The upsert does not change the id; the persisted id may differ from newEnrollmentId
        // only if the DB re-used the old id (which upsert preserves). Either way, status=ACTIVE.
        expect(persisted!.status, 'idempotent re-enrollment must remain ACTIVE').toBe('ACTIVE');
      }

      // Suppress TS unused-variable warning (freshEnrollment is the poll result for the timeout guard).
      void freshEnrollment;
    } finally {
      await partner.dispose();
    }
  });
});
