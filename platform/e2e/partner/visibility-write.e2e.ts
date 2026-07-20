import { test, expect } from '@playwright/test';
import { cookieToken, requestAs } from '../helpers/write';

/**
 * Visibility write-persistence (P0.6 dead-write port) — proves POST /api/visibility/submit now
 * forwards through the :3000 proxy to the backend (POST /v1/visibility/submit) and PERSISTS,
 * instead of hitting the deleted local platform-Prisma route (gap #36).
 *
 * Why an authenticated proxied request instead of driving the UI: the partner visibility page
 * requires navigator.geolocation + a camera/file capture, which is impractical to drive reliably
 * in CI. The write here still goes through the REAL same-origin /api/* proxy with a REAL partner
 * session (storageState), which is exactly the next.config forwarding under test.
 *
 * Persistence is proven by a FRESH read showing the new submissionId — NOT optimistic UI. The
 * read is performed as GIFSY_ADMIN: A4 (#2) correctly denylists partner roles from the tenant-wide
 * GET /visibility/submissions (a partner listing it would leak other partners' submissions), and
 * the partner UI never lists — it only POSTs /submit. GIFSY is the cross-tenant operator that CAN
 * list, so it's the right reader to confirm the row landed.
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
    const token = await cookieToken(page);
    expect(token, 'partner must be logged in (storageState)').toBeTruthy();

    // Read the persisted list as GIFSY (cross-tenant operator) — partners are denylisted from this
    // tenant-wide list by A4 (#2), and the partner UI never calls it. AF-6: the proxy authenticates
    // from the session COOKIE and ignores any Authorization header, so page.request would authenticate
    // as the PARTNER (the page's cookie) and be denylisted — use a real GIFSY-cookie request context.
    const gifsy = await requestAs('gifsy');
    const submissionIds = async (): Promise<string[]> => {
      const r = await gifsy.get('/api/visibility/submissions?limit=200');
      const j = await r.json();
      return ((j.data?.submissions ?? []) as { id: string }[]).map((s) => s.id);
    };

    try {
      const before = await submissionIds();

      // Build the multipart body in the page context (Node Blob/FormData differs across versions).
      // AF-6: this same-origin fetch carries the partner's httpOnly `token` cookie automatically and the
      // proxy authenticates from it (any Authorization header would be stripped), so the partner submits
      // their OWN visibility photo — no explicit Bearer needed.
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
            body: fd,
          });
          return { status: res.status, body: await res.json().catch(() => null) };
        },
        { programId: PROGRAM_ID, b64: PNG_BASE64 },
      );

      // The proxy forwarded to the backend (NOT the deleted local 404), and it created a submission.
      expect(submit.status, JSON.stringify(submit.body)).toBe(201);
      expect(submit.body?.success).toBe(true);
      const newId = submit.body?.data?.submissionId as string | undefined;
      expect(newId, 'a real submissionId').toBeTruthy();
      expect(submit.body?.data?.status).toBe('SUBMITTED');

      // PERSISTENCE: the new submissionId was NOT in the pre-submit list and IS in a fresh read —
      // proof it actually landed in the DB (not optimistic UI), read back by a role that can list.
      expect(before, 'the new id must not pre-exist').not.toContain(newId);
      await expect.poll(submissionIds, { timeout: 10_000 }).toContain(newId);
    } finally {
      await gifsy.dispose();
    }
  });
});
