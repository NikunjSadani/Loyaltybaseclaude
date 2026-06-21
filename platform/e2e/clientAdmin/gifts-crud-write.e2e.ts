import { test, expect } from '@playwright/test';
import { uniqueMarker } from '../helpers/persist';

/**
 * W10 — Admin Reward Catalog CRUD write-persistence.
 *
 * Proves:
 *   1. POST /api/admin/rewards/catalog creates a new catalog item → fresh GET
 *      /api/admin/rewards/catalog shows it by its unique name.
 *   2. PATCH /api/admin/rewards/catalog/:id updates the item → re-read reflects
 *      the new description (and proves the id from step 1 is the real DB id).
 *
 * Backend controller: api/src/rewards/admin-rewards.controller.ts (AdminRewardsController)
 *   POST   /v1/admin/rewards/catalog  (CLIENT_ADMIN, rewards:manage_inventory)
 *   PATCH  /v1/admin/rewards/catalog/:id  (CLIENT_ADMIN, rewards:manage_inventory)
 *   GET    /v1/admin/rewards/catalog  (CLIENT_ADMIN, rewards:read)
 * FE proxy: /api/admin/rewards/* → /v1/admin/rewards/*
 *
 * Seed dependency: category seed-rcat-1 ("VOUCHERS") must exist (seeded in §3.5).
 *
 * Idempotent: the marker contains Date.now() so every run creates a distinct row.
 * The test NEVER deletes the row (no cleanup needed — the Dev DB accumulates test
 * rows; the seed re-runs start fresh).
 */

const CATEGORY_ID = 'seed-rcat-1';

test.describe('@clientAdmin reward catalog CRUD write-persistence (W10)', () => {
  test('create a reward → fresh GET shows it; PATCH → re-read reflects update', async ({ page }) => {
    await page.goto('/admin/rewards');

    const token = await page.evaluate(() => localStorage.getItem('token'));
    expect(token, 'CLIENT_ADMIN must be logged in (storageState)').toBeTruthy();

    const auth = { Authorization: `Bearer ${token}` };

    const itemName = uniqueMarker('E2E-Gift');
    const itemCode = `E2E-${Date.now().toString(36).toUpperCase()}`;

    // ── Step 1: CREATE ──────────────────────────────────────────────────────────
    const createResult = await page.evaluate(
      async ({ tok, name, code, categoryId }) => {
        const res = await fetch('/api/admin/rewards/catalog', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
          body: JSON.stringify({
            categoryId,
            code,
            name,
            pointsCost: 250,
            redemptionMode: 'GIFT_CARD',
            description: 'E2E test gift item — create step',
          }),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
      },
      { tok: token!, name: itemName, code: itemCode, categoryId: CATEGORY_ID },
    );

    expect(
      [200, 201],
      `POST /api/admin/rewards/catalog returned ${createResult.status}: ${JSON.stringify(createResult.body)}`,
    ).toContain(createResult.status);

    const created = (createResult.body?.data ?? createResult.body) as
      | { item?: { id: string; name: string } }
      | undefined;
    const newItem = created?.item;
    expect(newItem?.id, 'POST must return the created item with an id').toBeTruthy();
    expect(newItem?.name, 'POST must echo the item name').toBe(itemName);
    const newId = newItem!.id;

    // ── Step 2: PERSISTENCE — fresh GET lists show the new item ────────────────
    const readCatalog = async (): Promise<{ id: string; name: string }[]> => {
      const r = await page.request.get('/api/admin/rewards/catalog?limit=200', { headers: auth });
      expect(r.status(), 'GET /api/admin/rewards/catalog must return 200').toBe(200);
      const j = await r.json();
      return ((j.data?.items ?? j.items ?? []) as { id: string; name: string }[]);
    };

    // The created item must appear in a fresh list read, identifiable by its id.
    const catalogAfterCreate = await expect
      .poll(readCatalog, {
        timeout: 10_000,
        message: `Newly created reward "${itemName}" (id=${newId}) must appear in fresh catalog list`,
      })
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: newId, name: itemName })]));
    void catalogAfterCreate;

    // Confirm it's really there (avoid polling shape confusion).
    const listedAfterCreate = (await readCatalog()).find((i) => i.id === newId);
    expect(listedAfterCreate, 'created item must be findable by id in the fresh list').toBeDefined();

    // ── Step 3: UPDATE ──────────────────────────────────────────────────────────
    const updatedDesc = uniqueMarker('E2E-Gift-Updated');
    const patchResult = await page.evaluate(
      async ({ tok, id, desc }) => {
        const res = await fetch(`/api/admin/rewards/catalog/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
          body: JSON.stringify({ description: desc }),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
      },
      { tok: token!, id: newId, desc: updatedDesc },
    );

    expect(
      [200, 201],
      `PATCH /api/admin/rewards/catalog/${newId} returned ${patchResult.status}: ${JSON.stringify(patchResult.body)}`,
    ).toContain(patchResult.status);

    // ── Step 4: PERSISTENCE after update — GET the specific item by listing ────
    // The catalog list includes description; verify via single-item list filter by code.
    // GET /api/admin/rewards/catalog does not have a GET-by-id route, so we read the list
    // and find our id.
    const catalogAfterPatch = await expect
      .poll(readCatalog, { timeout: 10_000 })
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: newId })]));
    void catalogAfterPatch;

    // Confirm description persisted by fetching full list and inspecting the item.
    const listFull = await page.request.get('/api/admin/rewards/catalog?limit=200', { headers: auth });
    const jFull = await listFull.json();
    const itemsFull = (jFull.data?.items ?? jFull.items ?? []) as {
      id: string;
      description?: string;
    }[];
    const updatedItem = itemsFull.find((i) => i.id === newId);
    expect(updatedItem, 'updated item must still exist in the catalog').toBeDefined();
    expect(updatedItem!.description, 'description must reflect the PATCH value').toBe(updatedDesc);
  });
});
