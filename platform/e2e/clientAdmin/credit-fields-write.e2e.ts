import { test, expect } from '@playwright/test';
import { uniqueMarker } from '../helpers/persist';

/**
 * W12 — Admin credit-field create + deactivate write-persistence.
 *
 * Proves:
 *   1. POST /api/admin/credits/fields creates a new credit field → fresh GET
 *      /api/admin/credits/fields shows the new field by its unique name.
 *   2. PATCH /api/admin/credits/fields/:id (action=deactivate) deactivates it →
 *      re-read shows isActive=false.
 *
 * Backend controller: api/src/credits/credits.controller.ts (CreditsController)
 *   POST  /v1/admin/credits/fields  (CLIENT_ADMIN, credits:manage_fields)
 *   PATCH /v1/admin/credits/fields/:id  (CLIENT_ADMIN, credits:manage_fields)
 *   GET   /v1/admin/credits/fields  (CLIENT_ADMIN, credits:read)
 * FE proxy: /api/admin/credits/* → /v1/admin/credits/*
 *
 * Seed dependency: none — the test creates its own row.
 * Seed truth: seed-cf-vis ("Visibility Spend") is the pre-existing field and
 *   must NOT be confused with the new row (marker ensures uniqueness).
 *
 * Idempotent concern: each run creates a NEW distinct field (the name includes
 * Date.now()). On re-run a fresh row is always created; the deactivate step
 * then acts on that run's own id.
 */

test.describe('@clientAdmin credit field create + deactivate write-persistence (W12)', () => {
  test('create a credit field → fresh GET shows it; deactivate → re-read reflects it', async ({
    page,
  }) => {
    await page.goto('/admin/credits');

    const token = await page.evaluate(() => localStorage.getItem('token'));
    expect(token, 'CLIENT_ADMIN must be logged in (storageState)').toBeTruthy();

    const auth = { Authorization: `Bearer ${token}` };

    const fieldName = uniqueMarker('E2E-Field');

    // ── Step 1: CREATE ──────────────────────────────────────────────────────────
    const createResult = await page.evaluate(
      async ({ tok, name }) => {
        const res = await fetch('/api/admin/credits/fields', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
          // CreateFieldDto: { name, isSeparatePayout?, outletTypeAwards? }
          // There is NO fieldType property — sending it causes a 400 from the
          // global ValidationPipe (forbidNonWhitelisted). body shape is exact.
          body: JSON.stringify({ name, isSeparatePayout: false, outletTypeAwards: {} }),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
      },
      { tok: token!, name: fieldName },
    );

    expect(
      [200, 201],
      `POST /api/admin/credits/fields returned ${createResult.status}: ${JSON.stringify(createResult.body)}`,
    ).toContain(createResult.status);

    // createField() returns the raw Prisma CreditField record directly (no { field: ... } wrapper).
    // TransformInterceptor envelopes it as { success: true, data: { id, name, isActive, ... } }.
    const newField = (createResult.body?.data ?? createResult.body) as
      | { id: string; name: string; isActive: boolean }
      | undefined;
    expect(newField?.id, 'POST must return the created field with an id').toBeTruthy();
    expect(newField?.name, 'POST must echo the field name').toBe(fieldName);
    const newId = newField!.id;

    // ── Step 2: PERSISTENCE — fresh GET shows the new field ────────────────────
    // listFields() returns a raw Prisma array (findMany). TransformInterceptor
    // wraps it as { success: true, data: [...] } — j.data IS the array, not
    // { fields: [...] }. The previous j.data?.fields always evaluated to undefined.
    const readFields = async (): Promise<{ id: string; name: string; isActive: boolean }[]> => {
      const r = await page.request.get('/api/admin/credits/fields', { headers: auth });
      expect(r.status(), 'GET /api/admin/credits/fields must return 200').toBe(200);
      const j = await r.json();
      const rows = Array.isArray(j.data) ? j.data : (j.data?.fields ?? j.fields ?? []);
      return rows as {
        id: string;
        name: string;
        isActive: boolean;
      }[];
    };

    await expect
      .poll(readFields, {
        timeout: 10_000,
        message: `New field "${fieldName}" (id=${newId}) must appear in fresh GET /api/admin/credits/fields`,
      })
      .toEqual(
        expect.arrayContaining([expect.objectContaining({ id: newId, name: fieldName, isActive: true })]),
      );

    // ── Step 3: DEACTIVATE ──────────────────────────────────────────────────────
    const patchResult = await page.evaluate(
      async ({ tok, id }) => {
        const res = await fetch(`/api/admin/credits/fields/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
          body: JSON.stringify({ action: 'deactivate' }),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
      },
      { tok: token!, id: newId },
    );

    expect(
      [200, 201],
      `PATCH /api/admin/credits/fields/${newId} returned ${patchResult.status}: ${JSON.stringify(patchResult.body)}`,
    ).toContain(patchResult.status);

    // ── Step 4: PERSISTENCE after deactivate ───────────────────────────────────
    // A fresh GET must show isActive=false for this specific field.
    await expect
      .poll(readFields, {
        timeout: 10_000,
        message: `Field ${newId} must show isActive=false after deactivate`,
      })
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: newId, name: fieldName, isActive: false }),
        ]),
      );

    // Confirm with a direct find (poll above can pass vacuously if shape changes).
    const finalList = await readFields();
    const deactivated = finalList.find((f) => f.id === newId);
    expect(deactivated, 'deactivated field must still appear in the list').toBeDefined();
    expect(deactivated!.isActive, 'isActive must be false after deactivate').toBe(false);
  });
});
