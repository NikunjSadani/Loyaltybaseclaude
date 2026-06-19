import { test, expect } from '@playwright/test';

/**
 * Visibility write-persistence (P0.6 dead-write port) — proves POST /api/visibility/submit now
 * forwards through the :3000 proxy to the backend (POST /v1/visibility/submit) and PERSISTS,
 * instead of hitting the deleted local platform-Prisma route (gap #36).
 *
 * Why an authenticated proxied request instead of driving the UI: the partner visibility page
 * requires navigator.geolocation + a camera/file capture, which is impractical to drive reliably
 * in CI. The write here still goes through the REAL same-origin /api/* proxy with a REAL partner
 * session (storageState), which is exactly the next.config forwarding under test. Persistence is
 * proven by a FRESH GET /api/visibility/submissions showing the new row — not optimistic UI.
 *
 * Seeded target: VisibilityProgram VP001 (seed-vp-1), partner CP001 with one active outlet.
 */
const PROGRAM_ID = 'seed-vp-1';

// 1x1 PNG (valid image/png) so the backend MIME + buffer checks pass.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test.describe('@partner visibility write-persistence (P0.6)', () => {
  test('submitting a visibility photo forwards to the backend and PERSISTS', async ({ page }) => {
    await page.goto('/partner/visibility');
    const token = await page.evaluate(() => localStorage.getItem('token'));
    expect(token, 'partner must be logged in (storageState)').toBeTruthy();

    const auth = { Authorization: `Bearer ${token}` };
    const countSubmissions = async (): Promise<number> => {
      const r = await page.request.get('/api/visibility/submissions?limit=100', { headers: auth });
      const j = await r.json();
      return (j.data?.submissions ?? []).length as number;
    };

    const before = await countSubmissions();

    // Build the multipart body in the page context (Node Blob/FormData differs across versions).
    const submit = await page.evaluate(
      async ({ programId, b64 }) => {
        const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const fd = new FormData();
        fd.append('image', new Blob([bin], { type: 'image/png' }), 'store.png');
        fd.append('programId', programId);
        fd.append('geoLat', '18.5204');
        fd.append('geoLng', '73.8567');
        const res = await fetch('/api/visibility/submit', {
          method: 'POST',
          headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
          body: fd,
        });
        return { status: res.status, body: await res.json().catch(() => null) };
      },
      { programId: PROGRAM_ID, b64: PNG_BASE64 },
    );

    // The proxy forwarded to the backend (NOT the deleted local 404), and it created a submission.
    expect(submit.status, JSON.stringify(submit.body)).toBe(201);
    expect(submit.body?.success).toBe(true);
    expect(submit.body?.data?.submissionId, 'a real submissionId').toBeTruthy();
    expect(submit.body?.data?.status).toBe('SUBMITTED');

    // PERSISTENCE: a fresh list read shows exactly one more submission (scoped to this partner).
    await expect.poll(countSubmissions, { timeout: 10_000 }).toBe(before + 1);
  });
});
