# Support tickets — assign, escalate, client remarks, raised-by / outlet

Status: ✅ LIVE on prod `4a48dc0d` (2026-11-20 night release; migrations `20261120110000/110100/110200` applied).
Built on `feat/ticket-assign-escalate` (2026-11-19). **PLATFORM-WIDE** (all programmes,
Deoleo included) — owner-approved 2026-11-19.

Code: `api/src/tickets/*` (service, controller, `ticket-submitter.ts`, `ticket-link.ts`) ·
`platform/src/app/admin/tickets/page.tsx` · `platform/src/lib/return-to.ts`.
Migrations: `20261120110000_ticket_waiting_on_client_status` (TicketStatus += WAITING_ON_CLIENT) ·
`20261120110100_ticket_note_visibility` (enum `TicketNoteVisibility` + nullable `ticket_messages.internalVisibility`) ·
`20261120110200_ticket_message_client_remarks_flag` (`ticket_messages.isClientRemarks BOOLEAN NOT NULL DEFAULT false`).
All additive + idempotent, no backfill. **Read "Cutover & rollback" below before deploying or rolling back.**

## Readers (who sees what)

| Reader | Roles | Sees |
|---|---|---|
| GIFSY | GIFSY_ADMIN, GIFSY_STAFF (while assumed into the tenant) | everything |
| CLIENT desk | CLIENT_ADMIN, MIS_USER | all tenant tickets; non-internal messages + internal notes that are `SHARED_WITH_CLIENT` or legacy (`NULL`) — never `GIFSY_ONLY` |
| FIELD | outlet owner (SSS/WHOLESALER/SUB_STOCKIST), SALES_* | own tickets only, via an allow-listed projection: **no** assignee, priority, metadata or reference; WAITING_ON_CLIENT **and ESCALATED** shown as IN_PROGRESS (a field `IN_PROGRESS` filter matches all three; filtering on the masked states matches nothing); non-internal messages only |

Internal-note visibility: `GIFSY_ONLY` = assign / escalation / email-outcome notes AND a Gifsy operator's own
internal note by default (the composer offers "Gifsy only" (default) / "Share with client admin");
`SHARED_WITH_CLIENT` = the remarks request, the client's reply, cancellations, and any internal note the client desk
writes (no choice for them). Old notes (`NULL`) are untouched and shown to admins with the "Shared with client" badge
(client admins could always read them). Thread badges: "Gifsy only" / "Shared with client" / "Client remarks"
(the last ONLY on an actual reply to a request — `isClientRemarks` — never on a client admin's ordinary note).

## Endpoints

| Action | Endpoint | Who |
|---|---|---|
| Picker options | `GET /v1/tickets/:id/assignees` | Gifsy (`@Roles('GIFSY_ADMIN')` + `support:write`; staff via GifsyRole) |
| Assign / unassign | `POST /v1/tickets/:id/assign {assigneeId \| null}` | Gifsy |
| Escalate (internal) | `POST /v1/tickets/:id/escalate {escalateTo, reason, priority?}` | Gifsy (`support:escalate`) |
| Ask client for remarks | `POST /v1/tickets/:id/request-client-remarks {clientAdminId, note}` | Gifsy (`support:escalate`) |
| Reply with remarks | `POST /v1/tickets/:id/client-remarks {message}` | CLIENT_ADMIN of the ticket's tenant (role re-checked in the service) |
| List "awaiting me" | `GET /v1/tickets?awaitingMine=true` | CLIENT_ADMIN |
| Cancel request & resume | `POST /v1/tickets/:id/cancel-client-remarks {reason?}` | Gifsy (`support:escalate`) |
| Admin list filters | `GET /v1/tickets?status=&priorities=HIGH,CRITICAL&category=&source=outlet\|sales&q=` + `summary` counts | support admins |

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
   - Different client admin → replaces; the old one gets a "withdrawn" SHARED note + bell.
2. Email (MSG91 SMTP, the scheduled-reports sender) is sent **after commit, inside the request** (bounded by the
   relay's 10 s connect / 20 s socket caps — a background send could be lost when Cloud Run throttles CPU after the
   response). The response says `emailSent` + `emailError`; the outcome is also a GIFSY_ONLY thread note. A retried
   click hits the "already pending" guard, so it never re-sends.
   Link host comes from **server config** (`ticket-link.ts`): `TENANT_LINK_ENV` → Cloud Run `K_SERVICE`
   (`*staging*` → staging) → DB name (`gifsy_staging` / `gifsy_prod`) → `NODE_ENV`. Staging always links
   `uat-<tenant host>`; prod the tenant's primary domain / `<slug>.gifsy.in`; never derived from the caller's host.
   Domain pick is STRICT: only the row flagged `isPrimary`, and in prod never a staging-looking host (`uat-` /
   `uat.` / `staging`). No usable primary → `<slug>.gifsy.in`, and the outcome note says why. Every failure is
   reported with its real reason (no address / recipient lookup error / domain lookup error / SMTP not configured /
   relay refused or timed out).
3. Client admin replies → SHARED internal message flagged `isClientRemarks`; marker cleared; bell to the requester
   (+ a Gifsy assignee). Status per the **resume rule** below.

   **Resume rule (one rule for a client reply AND for Gifsy's "Cancel request & resume")** —
   `resumeStatusAfterRemarks(fromStatus)`: ESCALATED stays ESCALATED and PENDING_USER (waiting on the outlet) stays
   PENDING_USER — the request didn't change what those states are about; everything else (OPEN, IN_PROGRESS,
   unknown) resumes as IN_PROGRESS — asking the client was already support work, so the ticket is not "untouched"
   any more. (Earlier builds restored OPEN on cancel but IN_PROGRESS on reply; that inconsistency is gone.)
4. While waiting, the client desk (CLIENT_ADMIN/MIS) **cannot** resolve / close / reopen (409 "send your remarks
   first"; MIS sees "Waiting for <client admin>'s remarks") and the client admin's outlet-reply composer is hidden.
   Gifsy can still do anything: **"Cancel request & resume"** (resume rule), escalating, or resolving / closing.
   The UI asks first ("This cancels the pending request to <name> — they'll be notified") and confirms afterwards.
   The client-visible note + bell are NEUTRAL ("Gifsy support has withdrawn the request for remarks from X" —
   plus "— the ticket was Resolved/Closed" for a status change); internal detail (an escalation, a typed reason)
   is recorded only in a GIFSY_ONLY note.
5. Replies are guarded too: the message and the ticket touch commit together on the status they were based on (a
   transition also on `updatedAt`) — a reply racing a close/escalate is refused (409), never reviving a CLOSED
   ticket or overwriting ESCALATED. On ANY 409 the UI reloads the ticket automatically, says what changed
   (e.g. "status: In Progress → Closed") and keeps the user's typed text.

## The "Remarks needed" email (owner 2026-11-20)

Rendered by `api/src/tickets/remarks-email.ts` (pure; data loaded by `TicketsService.loadRemarksEmailData`).
Designed so the recipient (client admin or the client's ticket-remarks inbox) can act without guessing; single
column, table layout, inline styles (mobile-friendly, no CSS grid). Subject:
`Remarks needed: <TKT> · <Category> · Outlet <code>` (or `· no outlet linked`). Blocks, in order:

1. **The ask** (highlighted): "<Gifsy person> (Gifsy support) needs your remarks:", the note verbatim, "Asked on
   <IST>", and "Asked: <admin>" when sent to the inbox.
2. **Open ticket & reply** button + "Please reply in the portal — replies to this email are not read." (true: the
   MSG91 SMTP sender has no inbound/reply processing anywhere in the codebase).
3. **Ticket**: number · category · priority · status "Awaiting your remarks" · raised on <date> (N days ago).
4. **Issue**: subject + the original description (first message), truncated at 800 chars "(full text in the portal)".
5. **Outlet**: code · name · type · program / sub-program (programName / programCategory) · city, state · KYC status
   (latest submission). None → "Outlet: not linked"; lookup failure → "unavailable".
6. **Raised by**: the same rule as the ticket screen; a salesperson also gets "Reports to <name> · <designation>" =
   the first ACTIVE manager up the chain (`firstActiveApproverId`, vacant levels skipped) or "no active manager on record".
7. **Context** (category, only what is cheaply available): POINTS → wallet balance; KYC → KYC status + submission
   date; REDEMPTION / PAYOUT → an explicit "not linked to a specific order / payout" line (tickets carry no order /
   payout reference). Other categories: no block.
8. **Recent conversation**: last ≤ 3 client-visible messages (the client-desk filter — never GIFSY_ONLY), oldest
   first, "<who> · <IST>: text" truncated at 300; the request note just written is excluded (it is the ask).

Privacy: every value HTML-escaped; free text (note, description, messages) has phone numbers and email addresses
masked ("[phone hidden]" / "[email hidden]"); no internal ids, no bank / KYC document data. All dates IST.

## Ticket remarks email (per client — owner-approved 2026-11-20, TENANT-SCOPED; To + CC lists 2026-11-21, platform-wide approved)

Gifsy console → Clients → <client> → **Support tickets** card (GIFSY_ADMIN only; the card is not rendered for
GIFSY_STAFF and the API refuses them). "Ticket remarks email" with two chip inputs — **To** (0–5) and **CC** (0–10):
Enter / comma / space adds a chip (a pasted list is split), × removes one; each address trimmed, lowercased, deduped;
invalid / over-limit / already-in-the-other-list entries are refused inline under that list; a half-typed address is
folded in on Save (never dropped). Helper text: blank To = the admin chosen on each ticket. A "Currently: …" summary
and "Last changed by X on date" (audit log) sit under Save. Phone-width: chips wrap.

- Stored as one `program_settings` row per tenant (NO migration): key `ticketRemarksEmail`, value
  `{ to: string[], cc: string[], email?: to[0] }` — `email` is written only when To is non-empty, so a rolled-back
  build (which reads only `{ email }`) still mails To[0] and never treats a CC-only config as an inbox. A legacy
  `{ email }` row reads as To = [email], CC = []. Written ONLY by `PUT /v1/gifsy/clients/:slug/ticket-remarks-email
  { to: string[], cc: string[] }` (legacy `{ email | '' | null }` still accepted: sets To, keeps CC) — read: `GET`
  same path → `{ to, cc, email (= To[0]), lastChange }`. `@Roles('GIFSY_ADMIN')`, deliberately no
  `@RequirePermission` (a staff can never pass), role re-checked in the service. The generic `PUT /v1/admin/settings`
  refuses the key. Every change writes an `audit_logs` row (`entityType TICKET_REMARKS_EMAIL`, `entityId` = slug,
  old → new `{ to, cc }`). Both lists empty deletes the row. Server validation: To ≤ 5, CC ≤ 10 (after dedupe), an
  address in both lists → 400 naming it, invalid entry → 400 naming the list + position ("CC address 2: …").
- **To set** → ONE email To every To address with a real `Cc:` header for the CC list (MSG91 SMTP relay via
  nodemailer — multi-recipient + Cc supported). Never to the chosen admin's personal email unless listed. The email
  names the admin who was asked; the chosen admin still gets the in-app bell and replies in the portal. Outcome note:
  "Email sent to <to list> (client's ticket remarks inbox)[, cc <list>] — asked: <name>".
- **To blank, CC set** → To the chosen admin's own email (as before; their address is dropped from CC if listed),
  Cc the CC list; note "Email sent to <name> (<their email>), cc <list>". If the admin has no email (owner decision
  2026-11-21) the CC list receives it AS the To recipients (no Cc), body worded like the inbox case ("Hello," +
  "Asked: <name>"), `emailRecipientKind: 'CC_ONLY'`, note "Email sent to the client's CC list <list> — <name> (the
  admin asked) has no email address on file". No To, no CC, no admin email → NOT sent, as before.
- **Both blank** (default — every tenant today incl. Deoleo) → byte-identical to before: the chosen admin's own email,
  no `cc` key on the send, "Hi <name>" greeting, outcome note "Email sent to <name> (<their email>)".
- **Partial relay rejection**: `Msg91Service.sendEmail` now takes optional `cc` and returns `{ skipped, accepted,
  rejected }` (nodemailer resolves when ≥1 recipient is accepted and throws when all are refused). Rejected
  addresses are appended to the Gifsy-only note ("The mail relay REJECTED x — they did NOT get this email"), returned
  as `emailRejected`, and shown with ⚠ in the Gifsy toast. If the relay refuses EVERY To address but accepts some CC,
  the outcome is NOT sent (`emailSent: false`, `emailCcOnlyDelivered: true`, reason "NOT delivered to anyone in To;
  copied to CC only (…)") — note and toast say exactly that. Relay acceptance ≠ inbox delivery: a later bounce is not
  visible (no DLR for SMTP email).
- **Email copy for shared readers** (inbox / CC / CC-only): "needs remarks from <asked>", "Asked: <asked or 'your
  team'>", "If you received this as a Cc, you're copied for information." (when CC is set), "Ask <asked> (or another
  client admin) to reply in the portal.", button "Open ticket (portal login needed)", status "Awaiting remarks from
  <asked>". The chosen-admin-with-no-CC email (every tenant's default) keeps its personal copy unchanged.
- **PUT semantics**: a key that is absent leaves that list unchanged (`{ to }` alone keeps CC and vice versa); `[]`
  clears it. A `{ cc }` that collides with the stored To → 400 (never silently removed).
- **Console pre-check** uses `platform/src/lib/ticket-remarks-email-rule.ts`, a verbatim copy of the API's
  `EMAIL_RE` / `INVISIBLE_RE` / `MAX_LEN`; `src/lib/__tests__/ticket-remarks-email-rule.test.ts` reads the API source and
  fails if they drift. Pasting past a cap truncates at the cap and names what was not added; an invalid entry stays in
  the (always editable) draft and Save is disabled with "Fix or remove the highlighted address to save."
- **Rollback (to a build before 2026-11-21) — what is lost**: the old reader only knows `{ email }`, so (a) only the
  FIRST To address keeps receiving; extra To addresses and the whole CC list stop receiving immediately; (b) a CC-only
  config (To blank) is ignored → back to the chosen admin only, and the CC-only fallback (admin has no email) stops;
  (c) the old console shows only `email`, and saving from it writes `{ email }` — the stored `to` / `cc` lists are
  dropped for good (re-enter them after rolling forward). Nothing else (tickets, notes, audit) is affected.
- Not shown to client admins (optional read-only display deliberately not added); the tenant settings payload
  (`GET /v1/admin/settings`) never includes the key.
- Validation is strict printable ASCII (letters, digits, `. _ % + ' -` in the local part; dotted labels + a 2+
  letter TLD): spaces, lists (`,` `;`), quotes, backslashes, colons, angle brackets, control characters and
  invisible format characters (e.g. U+200B zero-width space) are refused.
- Where the email went is reported honestly everywhere: the response carries `emailRecipientKind` (`INBOX` |
  `ADMIN`) + `emailRecipient` (To addresses joined ", ") + `emailTo` / `emailCc` lists (+ `emailRejected` when any);
  the Gifsy toast and the Gifsy-only outcome note (sent or NOT sent) name "the
  client's ticket remarks inbox <addr>" or the chosen admin accordingly.
- Like every `/v1/gifsy/clients/:slug/*` route, a GIFSY_ADMIN may edit any client's address regardless of which
  tenant they are currently assumed into (the slug in the URL decides; this is the console's normal model).
- **Prod state 2026-11-21:** Bajaj prod ticket remarks inbox is **still unset** (owner decision pending); Deoleo unset.

### Next: per-client To + CC (owner decision 2026-11-21, ⚠️ platform-wide approved — NOT shipped)

Branch `feat/ticket-remarks-cc` (audited; fix round in progress; ships in the next release). Replaces the single
address with a per-client **To (1–5 addresses) + CC (0–10 addresses)**. **CC-only** (To blank and the chosen admin
has no email) still emails the CC list. The section above describes what is on prod today until this ships.

## Raised by / outlet

`ticket-submitter.ts`: partner raiser → "Outlet owner — <owner name>"; SALES_* → "<name> · <hierarchy level
name>"; staff → "<name> · <role label>". Outlet = `referenceType 'OUTLET'` (stored by the sales "For an Outlet" flow,
validated against the rep's downline; soft-deleted outlets are no longer offered) → else the outlet owner's primary
outlet (flagged when they own several) → else "—". The sales app hides priority (support-internal) and shows the
server's error when a ticket is refused. Sales outlet lists AND counts (dashboard, team roll-up, member detail)
share one `LISTED_OUTLET` filter (not PARKED, not soft-deleted). Thread messages carry the same labels (`senderLabel`).
Ticket Aging Excel: all existing columns unchanged (incl. **Created By**); **Raised by** and **Outlet code** appended
at the end.

## UI

`/admin/tickets`: centred Radix dialog (focus trap, Escape, focus back to the row); keyboard-openable rows;
"Load more" fetches ONLY the next page (counts are computed on page 1 only); search / status / priority / category /
source filters and the stat cards are SERVER-side and exclude soft-deleted tickets; a filter / view change resets to
page 1, shows "Updating tickets…", and drops any in-flight older response (request generation); a load error stays
inline under the filters with **Retry**; staff without `support:escalate` see Escalate disabled with the reason;
an assignee-load failure shows the error + Retry; Reply/Internal toggles carry `aria-pressed` + a check mark; Gifsy: pick-then-**Assign** button, Escalate panel (Gifsy escalation / ask
client), "Awaiting client" card + filter (server-side); client admin: "N awaiting your remarks" banner → **Show**
lists only theirs; remarks box. Admin header renders the shared bell. Sales "New ticket" shows the server error.

Sign-in return-to: the proxy (document navigations only — never RSC fetches / prefetches; `_rsc` stripped, via
`returnToForEdgeRedirect`), `RequireAuth` and `SessionExpiryGuard` send signed-out users to
`/auth/login?next=<path+query>`; the login page honours it only for a same-origin relative path into a portal the
role may open (`/admin`, `/sales`; partners always go through the outlet picker).

## Known limits

- Older sales tickets stored the outlet only in the subject text → "—".
- A bell/email deep link works for Gifsy only once assumed into the ticket's programme (the page says so).
- `platform/src/lib/ticket-aging-export.ts` (legacy FE Excel builder, only its own test imports it) is unchanged.
- The admin header notification bell was added BY THIS BRANCH (`493e97e3`) — it is how a client admin receives the
  "remarks needed" in-app notification. It shows for every admin user (incl. Deoleo); before this branch admins had
  no bell (feed empty unless something notifies an admin user).

## Cutover & rollback

**Deploy order** (per environment): `migrate deploy` (the three additive migrations above) → API → FE. The API
needs the new enum value + columns; the FE tolerates an older API (missing fields are treated as absent).

**Rollback ⚠️** — once ANY ticket is `WAITING_ON_CLIENT`, rolling the API back to a build from before
`20261120110000` breaks that tenant's ticket list: the old Prisma client cannot decode the unknown enum value and the
query fails for every reader of that tenant. Before deploying an older API build, move those tickets back first
(staging and prod share one DB instance — guard on `current_database()`, take a backup, run in a quiet window):

```sql
SELECT current_database();                      -- must be the intended database
SELECT id, "clientId", metadata->'clientRemarks'->>'fromStatus' AS from_status
  FROM tickets WHERE status = 'WAITING_ON_CLIENT';   -- review what will move

BEGIN;
UPDATE tickets
   SET status = CASE WHEN metadata->'clientRemarks'->>'fromStatus' IN ('ESCALATED', 'PENDING_USER')
                     THEN (metadata->'clientRemarks'->>'fromStatus')::"TicketStatus"
                     ELSE 'IN_PROGRESS'::"TicketStatus" END,
       metadata = metadata - 'clientRemarks',
       "updatedAt" = now()
 WHERE status = 'WAITING_ON_CLIENT';
SELECT count(*) FROM tickets WHERE status = 'WAITING_ON_CLIENT';   -- must be 0
COMMIT;
```

(Same resume rule the app uses.) Leave the enum value and the two new columns in place — an older build ignores
them. **Also note:** an older build has no note-visibility filter, so `GIFSY_ONLY` internal notes become readable by
client admins / MIS after a rollback. If that matters, decide before rolling back (there is no way to hide them in
the old build short of deleting the notes).
