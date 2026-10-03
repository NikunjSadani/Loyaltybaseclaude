import { test, expect } from '@playwright/test';
import { cookieToken } from '../helpers/write';

/**
 * Points Compute Engine — pure rule simulator (clientAdmin → deoleo).
 *
 * POST /api/admin/points-compute/simulate validates a DRAFT rule config and, if valid, evaluates it
 * against ONE sample context — the live authoring aid. It is PURE: no DB, no persistence, no money, and
 * the engine flag is NOT required. output.fieldId is validated for non-emptiness only (NOT resolved
 * against a CreditField), so a placeholder id is fine here.
 *
 * Proves:
 *   1. A valid rate rule (points = CASES_SOLD × 2) over a context {CASES_SOLD:50} → valid:true,
 *      outcome.status 'OK', outcome.points 100.
 *   2. A malformed draft — a POINTS award with rounding.scale 2 (points must be a whole count) — →
 *      valid:false with a non-empty errors list (validateRule rejects it before evaluation).
 *
 * Backend: api/src/points-engine/points-compute.controller.ts (simulate; points_rules:read) →
 *   PointsComputeService.simulate → validateRule/evaluateRule (points-engine.helper.ts).
 */

/** Unwrap the { success, data } TransformInterceptor envelope (or pass a raw body through). */
function unwrap<T>(j: unknown): T {
  return (j && typeof j === 'object' && 'data' in (j as Record<string, unknown>)
    ? (j as { data: T }).data
    : (j as T));
}

test.describe('@clientAdmin Points Engine simulate (pure validate + evaluate)', () => {
  test('valid rate draft → OK/100 points; POINTS-award + rounding.scale 2 → invalid', async ({
    page,
  }) => {
    await page.goto('/admin/dashboard');
    expect(await cookieToken(page), 'CLIENT_ADMIN must be logged in (storageState)').toBeTruthy();

    // ── 1. Valid: rate 2 over CASES_SOLD=50 → 100 points ──────────────────────────────
    const validBody = {
      attachsTo: { scope: 'program_kpi', program: null, programCategory: null, kpiCode: 'CASES_SOLD' },
      output: { awardType: 'POINTS', fieldId: 'sim-field' }, // pure — field is not resolved in the DB
      rounding: { mode: 'half_up', scale: 0 },
      inputs: [{ ref: 'value', kpiCode: 'CASES_SOLD', type: 'number', nullAs: 'reject' }],
      pipeline: [{ type: 'rate', id: 'r1', measure: { var: 'value' }, rate: 2 }],
      context: { achievements: { CASES_SOLD: 50 } },
    };
    const okRes = await page.request.post('/api/admin/points-compute/simulate', { data: validBody });
    const okJson = await okRes.json().catch(() => null);
    expect([200, 201], `simulate valid: ${okRes.status()} ${JSON.stringify(okJson)}`).toContain(
      okRes.status(),
    );
    const ok = unwrap<{
      valid: boolean;
      errors: string[];
      outcome?: { status: string; points?: number };
    }>(okJson);
    expect(ok.valid, `valid draft must pass validation: ${JSON.stringify(ok.errors)}`).toBe(true);
    expect(ok.outcome?.status, 'a well-formed rule over present data → OK').toBe('OK');
    expect(ok.outcome?.points, 'points = 50 cases × rate 2').toBe(100);

    // ── 2. Malformed: a POINTS award cannot use a fractional rounding scale ────────────
    const badBody = {
      ...validBody,
      rounding: { mode: 'half_up', scale: 2 }, // POINTS must round to a whole count → rejected
      context: {}, // context is required (IsObject); validation fails before it is evaluated
    };
    const badRes = await page.request.post('/api/admin/points-compute/simulate', { data: badBody });
    const badJson = await badRes.json().catch(() => null);
    expect([200, 201], `simulate malformed: ${badRes.status()} ${JSON.stringify(badJson)}`).toContain(
      badRes.status(),
    );
    const bad = unwrap<{ valid: boolean; errors: string[] }>(badJson);
    expect(bad.valid, 'POINTS award + rounding.scale 2 must be invalid').toBe(false);
    expect(bad.errors?.length ?? 0, 'an invalid draft must report at least one error').toBeGreaterThan(
      0,
    );
  });
});
