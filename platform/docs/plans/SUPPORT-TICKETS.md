# Support tickets — assign, escalate, client remarks, raised-by / outlet

Status: built on `feat/ticket-assign-escalate` (2026-11-19), unmerged. **PLATFORM-WIDE** (all programmes,
Deoleo included) — owner-approved 2026-11-19.

Code: `api/src/tickets/*` (service, controller, `ticket-submitter.ts`, `ticket-link.ts`) ·
`platform/src/app/admin/tickets/page.tsx` · migration `20261120110000_ticket_waiting_on_client_status`.

## Who can do what

| Action | Endpoint | Who |
|---|---|---|
| Picker options | `GET /v1/tickets/:id/assignees` | Gifsy operators (`@Roles('GIFSY_ADMIN')` + `support:write`; GIFSY_STAFF via their GifsyRole) |
| Assign / unassign | `POST /v1/tickets/:id/assign {assigneeId \| null}` | Gifsy operators |
| Escalate (internal) | `POST /v1/tickets/:id/escalate {escalateTo, reason, priority?}` | Gifsy operators (`support:escalate`) |
| Ask client for remarks | `POST /v1/tickets/:id/request-client-remarks {clientAdminId, note}` | Gifsy operators (`support:escalate`) |
| Reply with remarks | `POST /v1/tickets/:id/client-remarks {message}` | CLIENT_ADMIN of the ticket's own tenant only (role re-checked in the service — GIFSY_ADMIN passes every `@Roles`) |

Gifsy works on a ticket only while **assumed** into its tenant (every lookup is pinned to the JWT `clientId`,
same as the rest of the tickets API). CLIENT_ADMIN keeps the read-only "Assigned" field.

**Assignable / escalation set** (`assignableUsers`): active GIFSY_ADMIN (home tenant `gifsy`) · active
GIFSY_STAFF holding a `GifsyStaffTenantGrant` for the ticket's tenant · active CLIENT_ADMINs of the ticket's
tenant (staff must also hold a live GifsyRole with `support:read`, so they can open what they are given).
Anyone else (another tenant's admin, an ungranted/inactive staff, an outlet, MIS) → 400. Escalation
targets are Gifsy users only; involving the client goes through "ask for remarks".

## Escalate vs ask-for-remarks (one "Escalate" control, two modes)

- **Escalate to Gifsy support** — no longer needs a prior assignment (the old button "escalated" to the
  existing assignee and so was permanently disabled). Priority bump (default HIGH) + `ESCALATED` + the picked
  user becomes assignee; internal note, audit, bell to the target.
- **Ask client admin for remarks** — status `WAITING_ON_CLIENT`; marker in `Ticket.metadata.clientRemarks`
  `{requestedFromId, requestedFromName, requestedById, requestedByName, note, requestedAt}`; internal note +
  audit; **bell + email** to that client admin. The email (MSG91 SMTP via `Msg91Service.sendEmail`, same as
  scheduled reports) carries a short subject + a link to `/admin/tickets?ticket=<id>` on the tenant's host
  (primary `ClientDomain`, else `<slug>.gifsy.in`; `uat-` prefixed when the caller is on a `uat-` host). It is
  the ONLY email the tickets module sends. No address on file / relay failure → the request still stands, the
  response says `emailSent:false` + reason, the UI shows a warning, and an internal note records it.
- **Client admin reply** — stored as an INTERNAL message (Gifsy + the tenant's admin desk see it; outlet/sales
  never). Ticket → `IN_PROGRESS`, marker cleared, bell to the requester (+ a Gifsy assignee). Conditional update:
  if Gifsy changed the status meanwhile → 409, nothing resurrected. Any CLIENT_ADMIN of the tenant may answer.
- Gifsy can still reply / change status / close at any time; any status change or escalation clears the marker.
- Concurrency: escalate and ask-for-remarks update only if the ticket is unchanged since it was read (status +
  updatedAt), the client reply only if the marker it read is still the live one — otherwise 409 "reload", never a
  closed ticket resurrected or a newer request wiped.
- While a ticket waits on the client, the client admin's outlet-reply composer is hidden (remarks box only), so
  remarks can't be posted to the outlet by mistake. Email is reported as NOT sent when SMTP isn't configured.

## Visibility rules (security)

Outlet- and sales-facing reads (`GET /tickets`, `GET /tickets/:id` for non-support roles) never return
internal messages (DB filter), the `metadata` blob, or the `WAITING_ON_CLIENT` status (masked as
`IN_PROGRESS`; a field reader's `IN_PROGRESS` filter matches both, `WAITING_ON_CLIENT` matches nothing). No other
API path returns ticket messages. The list returns `awaitingClient {total, mine}` to support admins only.

## Raised by / outlet

Derived from what the model stores (`ticket-submitter.ts`):
- **Raised by** — creator role SSS/WHOLESALER/SUB_STOCKIST → "Outlet owner — <ChannelPartner.ownerName>";
  SALES_* → "<name> · <SalesUser.hierarchyLevel.name>" (the tenant's own level label); others → "<name> · <role>".
- **Outlet** — `referenceType='OUTLET'` + `referenceId` (stored at create when the sales app's "For an Outlet"
  is used, validated against the rep's downline assignments; a partner may name only their own outlet). A
  partner-raised ticket without one shows the owner's primary outlet (flagged when they own several). Sales
  "own issue" tickets — and sales tickets created before this change (outlet only in the subject text) — show "—".
- Shown in the list (outlet name + code, "Raised by") and the ticket dialog header; the Ticket Aging Excel
  replaces "Created By" with **Raised by** and adds **Outlet code**.

## UI

`/admin/tickets` (Gifsy and client admin): ticket opens as a centred Radix dialog (focus trap, Escape, focus
returns to the row; rows are keyboard-openable). Gifsy: "Assign to" picker, "Escalate" panel, "Awaiting client"
count card + filter (fetched server-side). Client admin: "N tickets awaiting your remarks" banner (only when >0),
"Awaiting your remarks" section with the note + reply box. `?ticket=<id>` deep-links (bell / email).
The admin header now renders the shared notification bell.

## Known limits

- The default list is one page (20, newest first) — pre-existing; the "Awaiting client" view is fetched
  server-side (up to 100).
- The bell/email deep link works for a Gifsy operator only once assumed into the ticket's tenant.
- `platform/src/lib/ticket-aging-export.ts` (legacy FE Excel builder, only its own test uses it) is unchanged.
