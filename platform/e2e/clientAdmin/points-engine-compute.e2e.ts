import { test, expect } from '@playwright/test';
import { cookieToken } from '../helpers/write';

/**
 * Points Compute Engine — authoring → preview → direct-credit commit (clientAdmin → deoleo).
 *
 * Proves the real Wave-1/2 money chain end-to-end through the FE proxy:
 *   1. POST /api/admin/points-rules           — create a DRAFT rate rule (points = CASES_SOLD × 2)
 *      POST /api/admin/points-rules/:id/publish — publish it (→ the active rule for the attachment)
 *   2. POST /api/admin/points-compute/preview — read-only compute → an OK row per seeded outlet with
 *      points = achievement × 2 (O001: 137 cases → 274 pts; from api/prisma/seed.ts fixtures).
 *   3. POST /api/admin/points-compute/commit  — direct-credit → a PENDING_CONFIRM CreditBatch; a SECOND
 *      identical commit returns the SAME batch with idempotentHit=true (no double-credit).
 *
 * Backend contract:
 *   api/src/points-engine/points-engine.controller.ts   (CRUD, CLIENT_ADMIN + points_rules:write)
 *   api/src/points-engine/points-compute.controller.ts  (preview/commit, credits:upload for commit)
 *   api/src/points-engine/points-compute.service.ts     (previewCompute / commitCompute + sourceKey)
 * FE proxy: /api/admin/* → /v1/admin/* (httpOnly `token` cookie auth via page.request.*).
 *
 * Seed dependency (api/prisma/seed.ts — "Points Engine e2e fixtures" block):
 *   - programSetting pointsEngine = { enabled:true, directCreditEnabled:true } for deoleo
 *   - KpiDef CASES_SOLD (enabled)                            — required for publish()'s KPI reconcile
 *   - CreditField "Scheme Points Q2" (isActive, POINTS for WHOLESALER/SSS) — the rule's output bucket
 *   - OutletSalesRecord/OutletTarget for O001 (137/100) + O004 (212/150) in month 2026-05
 *
 * Re-runnable: archives any pre-existing published CASES_SOLD rule first (publish 409s on an
 * overlapping clash from a prior run), creates+publishes a fresh rule, and archives it in a finally.
 * The commit's createBatch deletes any stale PENDING_CONFIRM points-engine batch for the period, so
 * a prior run's uncommitted batch never blocks the next run.
 */

// = POINTS_ENGINE_PERIOD in api/prisma/seed.ts (the month the seeded achievements/targets live in).
const PERIOD = '2026-05';
const KPI = 'CASES_SOLD';

/** Unwrap the { success, data } TransformInterceptor envelope (or pass a raw body through). */
function unwrap<T>(j: unknown): T {
  return (j && typeof j === 'object' && 'data' in (j as Record<string, unknown>)
    ? (j as { data: T }).data
    : (j as T));
}

test.describe('@clientAdmin Points Engine compute → preview → commit (idempotent money path)', () => {
  test('publish a rate rule, preview OK rows, commit twice → one batch (no double-credit)', async ({
    page,
  }) => {
    await page.goto('/admin/dashboard');
    const token = await cookieToken(page);
    expect(token, 'CLIENT_ADMIN must be logged in (storageState)').toBeTruthy();

    // ── Resolve the seeded POINTS credit field id by its distinctive name ──────────────
    const fieldsRes = await page.request.get('/api/admin/credits/fields');
    const fieldsJson = await fieldsRes.json().catch(() => null);
    expect(fieldsRes.status(), `GET credit fields: ${JSON.stringify(fieldsJson)}`).toBe(200);
    const fields = unwrap<Array<{ id: string; name: string }>>(fieldsJson);
    const field = fields.find((f) => f.name === 'Scheme Points Q2');
    expect(field, 'seeded CreditField "Scheme Points Q2" must exist — run the seed').toBeTruthy();
    const fieldId = field!.id;

    // ── Isolation: archive any already-published rule for this KPI so publish() can't 409 on a
    //    pre-existing overlapping attachment left by a prior run. ──
    const existingRes = await page.request.get(
      `/api/admin/points-rules?kpiCode=${KPI}&status=published`,
    );
    const existing = unwrap<Array<{ id: string }>>(await existingRes.json().catch(() => ({ data: [] })));
    for (const r of existing ?? []) {
      await page.request.post(`/api/admin/points-rules/${r.id}/archive`, { data: {} });
    }

    // ── Create a DRAFT rate rule: points = CASES_SOLD × 2 (program:null wildcard → all outlets) ──
    const draft = {
      effectiveFrom: '2026-01-01', // before PERIOD so the rule is effective for 2026-05
      attachsTo: { scope: 'program_kpi', program: null, programCategory: null, kpiCode: KPI },
      output: { awardType: 'POINTS', fieldId },
      rounding: { mode: 'half_up', scale: 0 },
      inputs: [{ ref: 'value', kpiCode: KPI, type: 'number', nullAs: 'reject' }],
      pipeline: [{ type: 'rate', id: 'r1', measure: { var: 'value' }, rate: 2 }],
    };
    const createRes = await page.request.post('/api/admin/points-rules', { data: draft });
    const createJson = await createRes.json().catch(() => null);
    expect([200, 201], `create rule: ${createRes.status()} ${JSON.stringify(createJson)}`).toContain(
      createRes.status(),
    );
    const rule = unwrap<{ id: string; ruleId: string; status: string }>(createJson);
    expect(rule?.id, 'create must return the draft rule with an id').toBeTruthy();
    const ruleRowId = rule.id;

    try {
      // ── Publish the draft → the active rule for (null × null × CASES_SOLD) ──
      const pubRes = await page.request.post(`/api/admin/points-rules/${ruleRowId}/publish`, {
        data: {},
      });
      const pubJson = await pubRes.json().catch(() => null);
      expect([200, 201], `publish: ${pubRes.status()} ${JSON.stringify(pubJson)}`).toContain(
        pubRes.status(),
      );
      expect(unwrap<{ status: string }>(pubJson).status, 'rule must be published').toBe('published');

      // ── Preview: read-only compute for the period ──
      const prevRes = await page.request.post('/api/admin/points-compute/preview', {
        data: { period: PERIOD },
      });
      const prevJson = await prevRes.json().catch(() => null);
      expect([200, 201], `preview: ${prevRes.status()} ${JSON.stringify(prevJson)}`).toContain(
        prevRes.status(),
      );
      const preview = unwrap<{
        counts: { ok: number };
        totalPoints: number;
        engineDisabled: boolean;
        rows: Array<{ outletCode: string; status: string; points?: number; achievement?: number | null }>;
      }>(prevJson);

      expect(preview.engineDisabled, 'engine must be enabled for deoleo (seed pointsEngine)').toBe(false);
      expect(preview.counts.ok, 'at least one OK compute row').toBeGreaterThanOrEqual(1);
      expect(preview.totalPoints, 'run must total > 0 points').toBeGreaterThan(0);

      const o1 = preview.rows.find((r) => r.outletCode === 'O001');
      expect(o1, 'O001 must appear as a compute row').toBeTruthy();
      expect(o1!.status, 'O001 must be an OK row').toBe('OK');
      expect(o1!.achievement, 'O001 CASES_SOLD achievement (seed)').toBe(137);
      expect(o1!.points, 'O001 points = 137 cases × rate 2').toBe(274);

      // ── Commit (direct-credit) → a PENDING_CONFIRM batch (money moves only on later confirm) ──
      const commit1Res = await page.request.post('/api/admin/points-compute/commit', {
        data: { period: PERIOD },
      });
      const commit1Json = await commit1Res.json().catch(() => null);
      expect([200, 201], `commit #1: ${commit1Res.status()} ${JSON.stringify(commit1Json)}`).toContain(
        commit1Res.status(),
      );
      const commit1 = unwrap<{ batchId: string; batchCode: string; status: string }>(commit1Json);
      expect(commit1.batchCode, 'commit must return a batchCode').toBeTruthy();
      expect(commit1.batchId, 'commit must return a batchId').toBeTruthy();
      expect(commit1.status, 'a fresh commit lands as PENDING_CONFIRM (confirm-to-credit)').toBe(
        'PENDING_CONFIRM',
      );

      // ── Commit AGAIN, identical run → idempotent: the SAME batch, no second credit ──
      const commit2Res = await page.request.post('/api/admin/points-compute/commit', {
        data: { period: PERIOD },
      });
      const commit2Json = await commit2Res.json().catch(() => null);
      expect([200, 201], `commit #2: ${commit2Res.status()} ${JSON.stringify(commit2Json)}`).toContain(
        commit2Res.status(),
      );
      const commit2 = unwrap<{ batchId: string; idempotentHit: boolean }>(commit2Json);
      expect(commit2.batchId, 're-commit must return the SAME batch (no double-credit)').toBe(
        commit1.batchId,
      );
      expect(commit2.idempotentHit, 're-commit of an identical run must be flagged idempotent').toBe(
        true,
      );
    } finally {
      // ── Cleanup: archive our rule so the next run / other KPI specs start from a clean slate. ──
      await page.request.post(`/api/admin/points-rules/${ruleRowId}/archive`, { data: {} });
    }
  });
});
