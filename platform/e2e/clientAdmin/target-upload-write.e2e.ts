import { test, expect } from '@playwright/test';
import { cookieToken } from '../helpers/write';
import * as XLSX from 'xlsx';

/**
 * W8 — No-compute target upload write-persistence.
 *
 * Proves that the target upload pipeline (POST /api/admin/targets/upload with a
 * valid xlsx) lands OutletTarget rows in the DB, readable via
 * GET /api/admin/targets?month=YYYY-MM.
 *
 * STRATEGY — server-round-trip template:
 *   1. Seed defaults KPIs (POST /api/admin/kpis/seed-defaults — idempotent no-op
 *      if KPIs already exist). Required: uploadTargets rejects if no enabled KPIs.
 *   2. Download the real server template (GET /api/admin/targets/template?months=…).
 *      This gives us the EXACT header rows (row 1 = month group, row 2 = column
 *      labels) that parseTargetUploadBuffer expects, plus the seeded outlet codes.
 *   3. Fill in a non-zero value for each outlet × KPI cell.
 *   4. PREVIEW it (?preview=1, nothing written), check an un-previewed POST is REFUSED (400, owner rule
 *      2026-11-25: preview → confirm for every client), CONFIRM (?confirmToken=…&ack=…) with the same bytes,
 *      and check a second confirm of the same preview is refused (409).
 *   5. PERSISTENCE: GET /api/admin/targets?month=… shows the written values.
 *
 * Using a FUTURE month (2027-07) ensures the upload is never locked (isMonthLocked
 * returns false for any month ≥ current month). The value is 42 — a canary that
 * persists across runs because re-upload is idempotent (upsert on outletCode×month).
 *
 * Backend controller: api/src/targets/targets.controller.ts
 *   POST /v1/admin/kpis/seed-defaults  (CLIENT_ADMIN, targets:manage_config)
 *   GET  /v1/admin/targets/template    (CLIENT_ADMIN, targets:read)
 *   POST /v1/admin/targets/upload      (CLIENT_ADMIN, targets:upload) — multipart, ?preview=1 then ?confirmToken=
 *   GET  /v1/admin/targets             (CLIENT_ADMIN, targets:read)
 * FE proxy: /api/admin/* → /v1/admin/*
 *
 * SKIPS (instead of failing) if:
 *   • Seed-defaults returns 400 (pre-condition failure) → clear re-seed note.
 *   • Template download is empty (no active outlets) → re-seed note.
 * These skips are HONEST: the spec cannot succeed without seeded data; it does
 * NOT guess or fabricate outlet codes.
 */

// A future month well past any lock window.
const UPLOAD_MONTH = '2027-07';
const CANARY_VALUE = 42;

test.describe('@clientAdmin target upload write-persistence (W8)', () => {
  test(
    'upload a filled target template → GET /api/admin/targets shows persisted values',
    async ({ page }) => {
      await page.goto('/admin/targets');

      const token = await cookieToken(page);
      expect(token, 'CLIENT_ADMIN must be logged in (storageState)').toBeTruthy();

      const auth = { Authorization: `Bearer ${token}` };

      // ── Step 1: Seed KPI defaults (idempotent) ────────────────────────────────
      // Required: uploadTargets throws 400 if no enabled KPIs exist.
      const seedRes = await page.request.post('/api/admin/kpis/seed-defaults', { headers: auth });
      if (seedRes.status() >= 400) {
        const body = await seedRes.json().catch(() => ({}));
        test.skip(
          true,
          `POST /api/admin/kpis/seed-defaults returned ${seedRes.status()}: ` +
            `${JSON.stringify(body)} — reseed gifsy_dev or check KPI seed-defaults endpoint`,
        );
        return;
      }

      // ── Step 2: Download the real server template ─────────────────────────────
      // GET /api/admin/targets/template?months=2027-07 streams an xlsx.
      const templateRes = await page.request.get(
        `/api/admin/targets/template?months=${UPLOAD_MONTH}`,
        { headers: auth },
      );
      expect(
        templateRes.status(),
        'GET /api/admin/targets/template must return 200',
      ).toBe(200);

      const templateBytes = await templateRes.body();
      const wb = XLSX.read(templateBytes, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rawAoa = XLSX.utils.sheet_to_json<(string | number | null)[]>(ws, {
        header: 1,
        defval: null,
      });

      // Need at least 3 rows: row 1 (month header), row 2 (column labels), row 3+ (outlets).
      if (rawAoa.length < 3) {
        test.skip(
          true,
          `Target template has only ${rawAoa.length} rows (expected ≥3 = header rows + ≥1 outlet). ` +
            'Run "prisma db seed" to populate the deoleo outlet roster.',
        );
        return;
      }

      const headerRow2 = (rawAoa[1] as (string | null)[]).map((c) => String(c ?? '').trim());
      const outletIdCol = headerRow2.indexOf('Outlet ID');
      if (outletIdCol === -1) {
        throw new Error(
          'Downloaded template is missing "Outlet ID" column — unexpected template format',
        );
      }

      // ── Step 3: Fill in CANARY_VALUE for every data row × KPI column ──────────
      // Columns after the three fixed cols (Outlet ID, Outlet Name, Outlet Type)
      // are KPI cells. We set every non-fixed cell in every data row to CANARY_VALUE.
      const FIXED_COL_COUNT = 3;
      const kpiColCount = headerRow2.length - FIXED_COL_COUNT;

      // Track which outlet codes we're filling so we can assert them later.
      const filledOutletCodes: string[] = [];

      for (let ri = 2; ri < rawAoa.length; ri++) {
        const row = rawAoa[ri] as (string | number | null)[];
        const outletCode = String(row[outletIdCol] ?? '').trim();
        if (!outletCode) continue;

        filledOutletCodes.push(outletCode);

        // Fill each KPI cell.
        for (let ci = FIXED_COL_COUNT; ci < FIXED_COL_COUNT + kpiColCount; ci++) {
          row[ci] = CANARY_VALUE;
        }
        rawAoa[ri] = row;
      }

      if (filledOutletCodes.length === 0) {
        test.skip(
          true,
          'Template has no data rows (no active outlets) — run "prisma db seed" to populate outlets.',
        );
        return;
      }

      // Re-build the xlsx from the modified array.
      const modifiedWs = XLSX.utils.aoa_to_sheet(rawAoa as (string | number | null)[][]);
      const modifiedWb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(modifiedWb, modifiedWs, wb.SheetNames[0]);
      const modifiedBuffer: Buffer = XLSX.write(modifiedWb, {
        type: 'buffer',
        bookType: 'xlsx',
      }) as Buffer;

      // ── Step 4: PREVIEW → (refused without preview) → CONFIRM the filled template ──
      // Owner rule 2026-11-25 (every client): the API refuses an upload that was not previewed. Must be
      // multipart/form-data with field "file"; page.evaluate builds a Blob from the bytes and posts via fetch.
      const modifiedBytes = Array.from(modifiedBuffer);
      const post = (query: string) =>
        page.evaluate(
          async ({ tok, bytes, q }) => {
            const blob = new Blob([new Uint8Array(bytes)], {
              type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            });
            const fd = new FormData();
            fd.append('file', blob, 'targets-e2e.xlsx');
            const res = await fetch(`/api/admin/targets/upload${q}`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${tok}` },
              body: fd,
            });
            return { status: res.status, body: await res.json().catch(() => null) };
          },
          { tok: token!, bytes: modifiedBytes, q: query },
        );

      // 4a. No preview → refused, nothing written.
      const direct = await post('');
      expect(direct.status, `an un-previewed upload must be refused: ${JSON.stringify(direct.body)}`).toBe(400);
      expect(String(direct.body?.error ?? '')).toMatch(/Preview the file first/);

      // 4b. Preview — nothing written; returns the signed token + what will not be applied.
      const previewRes = await post('?preview=1');
      expect(
        [200, 201],
        `POST /api/admin/targets/upload?preview=1 returned ${previewRes.status}: ${JSON.stringify(previewRes.body)}`,
      ).toContain(previewRes.status);
      const preview = previewRes.body?.data as {
        preview: boolean;
        previewToken: string;
        willSaveCount: number;
        notApplied: { category: string; count: number; fingerprint: string }[];
      };
      expect(preview.preview).toBe(true);
      expect(preview.willSaveCount, 'the preview must have something to save (the seeded outlets)').toBeGreaterThan(0);

      // 4c. Confirm with the SAME bytes, acknowledging exactly what the preview listed (count + fingerprint).
      const ack = preview.notApplied.map((c) => `${c.category}:${c.count}:${c.fingerprint}`).join(',');
      const uploadResult = await post(
        `?confirmToken=${encodeURIComponent(preview.previewToken)}&ack=${encodeURIComponent(ack)}`,
      );

      expect(
        [200, 201],
        `POST /api/admin/targets/upload?confirmToken= returned ${uploadResult.status}: ${JSON.stringify(uploadResult.body)}`,
      ).toContain(uploadResult.status);

      const uploadData = uploadResult.body?.data as { status?: string; acceptedCount?: number; savedCount?: number } | undefined;
      expect(uploadData?.status, 'the confirmed upload must report APPLIED').toBe('APPLIED');
      const accepted = uploadData?.acceptedCount ?? 0;
      expect(
        accepted,
        'Upload must accept at least one row (the seeded outlets)',
      ).toBeGreaterThan(0);

      // 4d. The same preview cannot be applied twice.
      const again = await post(
        `?confirmToken=${encodeURIComponent(preview.previewToken)}&ack=${encodeURIComponent(ack)}`,
      );
      expect(again.status, `a second confirm of the same preview must be refused: ${JSON.stringify(again.body)}`).toBe(409);

      // ── Step 5: PERSISTENCE — GET /api/admin/targets?month= shows the values ──
      // TargetsService.listTargets() returns the raw Prisma outletTarget array directly
      // (NOT wrapped in { targets: [...] }).  TransformInterceptor envelopes it as
      // { success: true, data: [...] } — so j.data IS the array.
      // The previous j.data?.targets always evaluated to undefined (arrays have no
      // .targets property), which caused this function to always return [].
      const readTargets = async (): Promise<{ outletCode: string; targetValues: unknown }[]> => {
        const r = await page.request.get(
          `/api/admin/targets?month=${UPLOAD_MONTH}`,
          { headers: auth },
        );
        expect(r.status(), 'GET /api/admin/targets must return 200').toBe(200);
        const j = await r.json();
        // j.data is the array itself (listTargets returns a bare array).
        const rows = Array.isArray(j.data) ? j.data : (j.data?.targets ?? j.targets ?? []);
        return rows as { outletCode: string; targetValues: unknown }[];
      };

      // At least one uploaded outlet's target row must appear.
      const firstFilledCode = filledOutletCodes[0];
      await expect
        .poll(readTargets, {
          timeout: 10_000,
          message: `Outlet "${firstFilledCode}" must have a target row for month ${UPLOAD_MONTH}`,
        })
        .toEqual(
          expect.arrayContaining([expect.objectContaining({ outletCode: firstFilledCode })]),
        );

      // Confirm a KPI value persisted (targetValues is a JSON object keyed by KPI code).
      const allTargets = await readTargets();
      const persisted = allTargets.find((t) => t.outletCode === firstFilledCode);
      expect(persisted, `Target row for outlet "${firstFilledCode}" must exist`).toBeDefined();
      const vals = persisted!.targetValues as Record<string, unknown>;
      const persistedValues = Object.values(vals);
      expect(
        persistedValues.some((v) => v === CANARY_VALUE),
        `At least one KPI value for outlet "${firstFilledCode}" must equal ${CANARY_VALUE}`,
      ).toBe(true);
    },
  );

  // ── Negative path: bad file is rejected ─────────────────────────────────────
  // Always runs (no seed dependency). Proves the upload endpoint exists and
  // correctly rejects a non-xlsx file with 400.
  test('uploading a non-xlsx file is rejected with 400', async ({ page }) => {
    await page.goto('/admin/targets');

    const token = await cookieToken(page);
    expect(token, 'CLIENT_ADMIN must be logged in (storageState)').toBeTruthy();

    const result = await page.evaluate(
      async ({ tok }) => {
        // A CSV disguised as an xlsx — the FileInterceptor fileFilter checks the
        // extension (.csv fails the /\.(xlsx|xls)$/i test) and returns 400.
        const blob = new Blob(['outlet_id,outlet_name\nO001,Test'], { type: 'text/csv' });
        const fd = new FormData();
        fd.append('file', blob, 'targets.csv');
        const res = await fetch('/api/admin/targets/upload?preview=1', {
          method: 'POST',
          headers: { Authorization: `Bearer ${tok}` },
          body: fd,
        });
        return { status: res.status };
      },
      { tok: token! },
    );

    expect(
      result.status,
      'Uploading a non-xlsx file must be rejected with 400',
    ).toBe(400);
  });
});
