# Support tickets — assign, escalate, client remarks, raised-by / outlet

Status: built on `feat/ticket-assign-escalate` (2026-11-19), unmerged. **PLATFORM-WIDE** (all programmes,
Deoleo included) — owner-approved 2026-11-19.

Code: `api/src/tickets/*` (service, controller, `ticket-submitter.ts`, `ticket-link.ts`) ·
`platform/src/app/admin/tickets/page.tsx` · `platform/src/lib/return-to.ts`.
Migrations: `20261120110000_ticket_waiting_on_client_status` (TicketStatus += WAITING_ON_CLIENT) ·
`20261120110100_ticket_note_visibility` (enum `TicketNoteVisibility` + nullable `ticket_messages.internalVisibility`).
Both additive + idempotent, no backfill.

## Readers (who sees what)

| Reader | Roles | Sees |
|---|---|---|
| GIFSY | GIFSY_ADMIN, GIFSY_STAFF (while assumed into the tenant) | everything |
| CLIENT desk | CLIENT_ADMIN, MIS_USER | all tenant tickets; non-internal messages + internal notes that are `SHARED_WITH_CLIENT` or legacy (`NULL`) — never `GIFSY_ONLY` |
| FIELD | outlet owner (SSS/WHOLESALER/SUB_STOCKIST), SALES_* | own tickets only, via an allow-listed projection: **no** assignee, priority, metadata or reference; WAITING_ON_CLIENT **and ESCALATED** shown as IN_PROGRESS (a field `IN_PROGRESS` filter matches all three; filtering on the masked states matches nothing); non-internal messages only |

Internal-note visibility: `GIFSY_ONLY` = assign / escalation / email-outcome notes; `SHARED_WITH_CLIENT` = the
remarks request, the client's reply, cancellations, and any internal note the client desk writes. A Gifsy
generic internal note (the "Internal Note" composer) keeps the legacy `NULL` (visible to all support admins, as
before). Old notes are untouched.

## Endpoints

| Action | Endpoint | Who |
|---|---|---|
| Picker options | `GET /v1/tickets/:id/assignees` | Gifsy (`@Roles('GIFSY_ADMIN')` + `support:write`; staff via GifsyRole) |
| Assign / unassign | `POST /v1/tickets/:id/assign {assigneeId \| null}` | Gifsy |
| Escalate (internal) | `POST /v1/tickets/:id/escalate {escalateTo, reason, priority?}` | Gifsy (`support:escalate`) |
| Ask client for remarks | `POST /v1/tickets/:id/request-client-remarks {clientAdminId, note}` | Gifsy (`support:escalate`) |
| Reply with remarks | `POST /v1/tickets/:id/client-remarks {message}` | CLIENT_ADMIN of the ticket's tenant (role re-checked in the service) |
| List "awaiting me" | `GET /v1/tickets?awaitingMine=true` | CLIENT_ADMIN |

Assignable set: active GIFSY_ADMIN (home `gifsy`) · active GIFSY_STAFF with a grant for the tenant **and** a live
GifsyRole holding `support:read` · active CLIENT_ADMINs of the ticket's tenant. Anything else → 400.
Escalation targets are Gifsy only.

Every state-changing action (assign, escalate, request remarks, set status) is guarded optimistically
(`status` + `updatedAt` unchanged since read) → 409 "reload" instead of resurrecting / clobbering. The client
reply is pinned to the request it read (`metadata.clientRemarks.requestedAt`).

## Ask-for-remarks lifecycle

1. Gifsy asks → `WAITING_ON_CLIENT`; marker `metadata.clientRemarks {requestedFromId/Name, requestedById/Name, note,
   requestedAt, fromStatus}`; SHARED note; audit; bell to the client admin.
   - Same client admin already pending → `alreadyPending`, nothing changed or re-sent (retry-safe).
   - Different client admin → replaces; the old one gets a "cancelled" SHARED note + bell.
2. Email (MSG91 SMTP, the scheduled-reports sender) runs **after commit, fire-and-forget**; the response says
   `emailStatus: SENDING` (outcome then written back as a GIFSY_ONLY note — "Email sent…" / "NOT sent…") or
   `NOT_SENT` + reason when known up front (no address / SMTP not configured).
   Link host comes from **server config** (`ticket-link.ts`): `TENANT_LINK_ENV` → Cloud Run `K_SERVICE`
   (`*staging*` → staging) → DB name (`gifsy_staging` / `gifsy_prod`) → `NODE_ENV`. Staging always links
   `uat-<tenant host>`; prod the tenant's primary domain / `<slug>.gifsy.in`; never derived from the caller's host.
3. Client admin replies → SHARED internal message; status back to **ESCALATED if it was escalated before the
   request, else IN_PROGRESS**; marker cleared; bell to the requester (+ a Gifsy assignee).
4. While waiting, the client desk (CLIENT_ADMIN/MIS) **cannot** resolve / close / reopen (409 "send your remarks
   first") and its outlet-reply composer is hidden. Gifsy can still do anything: escalating or changing status
   cancels the request explicitly (SHARED note "Remarks request to X cancelled — <reason>" + bell to X).

## Raised by / outlet

`ticket-submitter.ts`: partner raiser → "Outlet owner — <owner name>"; SALES_* → "<name> · <hierarchy level
name>"; staff → "<name> · <role label>". Outlet = `referenceType 'OUTLET'` (stored by the sales "For an Outlet" flow,
validated against the rep's downline; soft-deleted outlets are no longer offered) → else the outlet owner's primary
outlet (flagged when they own several) → else "—". Thread messages carry the same labels (`senderLabel`).
Ticket Aging Excel: all existing columns unchanged (incl. **Created By**); **Raised by** and **Outlet code** appended
at the end.

## UI

`/admin/tickets`: centred Radix dialog (focus trap, Escape, focus back to the row); keyboard-openable rows;
"Load more" paging with a total; Gifsy: pick-then-**Assign** button, Escalate panel (Gifsy escalation / ask
client), "Awaiting client" card + filter (server-side); client admin: "N awaiting your remarks" banner → **Show**
lists only theirs; remarks box. Admin header renders the shared bell. Sales "New ticket" shows the server error.

Sign-in return-to: the proxy, `RequireAuth` and `SessionExpiryGuard` send signed-out users to
`/auth/login?next=<path+query>`; the login page honours it only for a same-origin relative path into a portal the
role may open (`/admin`, `/sales`; partners always go through the outlet picker).

## Known limits

- Older sales tickets stored the outlet only in the subject text → "—".
- A bell/email deep link works for Gifsy only once assumed into the ticket's programme (the page says so).
- `platform/src/lib/ticket-aging-export.ts` (legacy FE Excel builder, only its own test imports it) is unchanged.
