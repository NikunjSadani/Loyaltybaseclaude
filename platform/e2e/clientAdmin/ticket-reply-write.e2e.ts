import { test, expect } from '@playwright/test';
import { uniqueMarker } from '../helpers/persist';
import { cookieToken, requestAs } from '../helpers/write';

/**
 * W13 — Admin replies to a partner ticket → the PARTNER session sees the reply.
 *
 * This is the cross-session write proof:
 *   • The CLIENT_ADMIN (storageState) posts a reply to the seeded ticket DEO-0001
 *     (POST /api/tickets/seed-ticket-1/messages).
 *   • A FRESH GET /api/tickets/seed-ticket-1 using the PARTNER's token (cross-role,
 *     tokenFor('partner')) shows the new message in the ticket thread.
 *
 * This proves two things:
 *   1. The admin reply PERSISTS to the DB (not optimistic UI).
 *   2. The PARTNER can read the admin reply in their own ticket (cross-role read).
 *
 * Backend controller: api/src/tickets/tickets.controller.ts
 *   POST /v1/tickets/:id/messages  (support:write — CLIENT_ADMIN has this permission)
 *   GET  /v1/tickets/:id           (support:read — WHOLESALER sees tickets they created)
 * FE proxy: /api/tickets/* → /v1/tickets/*
 *
 * Seed dependency: ticket seed-ticket-1 (DEO-0001) created by seed-deoleo-partner
 *   (the partner role, WHOLESALER). The partner's storageState must exist.
 *
 * Idempotent: each run adds another message — uniqueMarker ensures the specific
 *   message from this run can be identified by message text. The ticket accumulates
 *   messages across runs, which is fine.
 */

const TICKET_ID = 'seed-ticket-1';

test.describe('@clientAdmin ticket reply write-persistence, cross-session (W13)', () => {
  test('admin posts a reply → PARTNER fresh read sees the message in the thread', async ({ page }) => {
    await page.goto('/admin/tickets');

    const adminToken = await cookieToken(page);
    expect(adminToken, 'CLIENT_ADMIN must be logged in (storageState)').toBeTruthy();

    // The unique reply text — this run's marker.
    const replyText = uniqueMarker('E2E-AdminReply');

    // ── Step 1: ADMIN POSTS A REPLY ─────────────────────────────────────────────
    const replyResult = await page.evaluate(
      async ({ tok, ticketId, message }) => {
        const res = await fetch(`/api/tickets/${ticketId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
          body: JSON.stringify({ message, isInternal: false }),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
      },
      { tok: adminToken!, ticketId: TICKET_ID, message: replyText },
    );

    expect(
      [200, 201],
      `POST /api/tickets/${TICKET_ID}/messages returned ${replyResult.status}: ${JSON.stringify(replyResult.body)}`,
    ).toContain(replyResult.status);

    const replyData = (replyResult.body?.data ?? replyResult.body) as
      | { message?: { id: string } }
      | undefined;
    const newMsgId = replyData?.message?.id;
    expect(newMsgId, 'POST must return the created message with an id').toBeTruthy();

    // ── Step 2: PERSISTENCE — PARTNER reads the ticket and sees the admin reply ──
    // The ticket was created BY the partner, so loadAccessible allows them to GET it. AF-6: the proxy
    // authenticates from the request's session COOKIE and ignores any Authorization header, so
    // page.request would read as the CLIENT_ADMIN page session — use a real PARTNER-cookie request
    // context to genuinely prove the PARTNER sees the admin reply in their own thread.
    const partner = await requestAs('partner');
    try {
      const readTicketAsPartner = async (): Promise<string[]> => {
        const r = await partner.get(`/api/tickets/${TICKET_ID}`);
        expect(r.status(), `GET /api/tickets/${TICKET_ID} as partner must return 200`).toBe(200);
        const j = await r.json();
        const ticket = (j.data?.ticket ?? j.ticket) as
          | { messages?: { id: string; message: string }[] }
          | undefined;
        return (ticket?.messages ?? []).map((m) => m.message);
      };

      // The admin's reply text must appear in the PARTNER's view of the thread.
      await expect
        .poll(readTicketAsPartner, {
          timeout: 10_000,
          message: `Admin reply "${replyText}" must appear in the ticket thread when read by the PARTNER`,
        })
        .toContain(replyText);

      // Final confirmation — the message is real and persisted (not optimistic).
      const partnerMessages = await readTicketAsPartner();
      expect(
        partnerMessages,
        `Partner must see the admin reply "${replyText}" in ticket ${TICKET_ID}`,
      ).toContain(replyText);
    } finally {
      await partner.dispose();
    }
  });
});
