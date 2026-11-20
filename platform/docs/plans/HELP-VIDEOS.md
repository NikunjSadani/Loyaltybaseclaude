# Help & videos — design note + seed content

Owner-approved 2026-11-19 (Bajaj). **TENANT-SCOPED**: everything is behind the console flag `helpVideos`
(default OFF; Deoleo stays OFF and byte-identical). ✅ LIVE on prod `1fa2305c` (2026-11-19 night), DORMANT until the
owner switches `helpVideos` ON for Bajaj prod and OKs loading the content (3 sales training videos recorded). UX fixes
on `fix/help-videos-ux` (`8f4d3800`) — next release.

## 1. What it is

Short how-to guides inside the apps. Each guide has a title, a short description, an optional video (MP4,
≤ 50 MB), an optional poster image, and 3–6 numbered written steps.

- **Sales app:** Profile (top-bar avatar) → **Help & videos** → list → guide. Audience `SALES`.
- **Partner app:** Profile (top-bar avatar / "My Account") → **Help & videos** → list → guide. Audience `PARTNER`.
- **Gifsy console:** Clients → *client* → **Help & videos** (link next to the status pill), at
  `/gifsy/clients/<slug>/help-videos`. This is where guides are created, edited, reordered, published or
  unpublished, deleted, and where the video and poster are uploaded.

## 2. Design

### Data model (table `help_topics`, migration `20261120100000_add_help_topics`)

Additive only: one new enum `HelpTopicAudience (SALES | PARTNER)`, one new table and one index. No existing
table is touched. The migration is idempotent and uses `SET lock_timeout='5s'` / `RESET lock_timeout`.

| column | meaning |
|---|---|
| `clientId` | tenant |
| `audience` | `SALES` or `PARTNER` |
| `roles text[]` | optional role filter. Empty = everyone in the audience. **SALES:** a login role (`SALES_SO`…) or the tenant's hierarchy-level code (`SO`, `ASM`…). **PARTNER:** a login role (`WHOLESALER`…) or one of the partner's outlet-type codes (`RETAILER`…). |
| `title`, `description` | ≤ 80 / ≤ 200 characters |
| `sortOrder` | order within the audience |
| `isPublished` | members see only published guides. Publishing needs 3–6 steps. |
| `videoKey`, `videoBytes`, `posterKey` | object keys in OUR uploads bucket, under `help-videos/<slug>/<topicId>/…` |
| `steps text[]` | ordered steps, ≤ 6, each ≤ 200 characters |
| `createdById`, `updatedById`, `deletedAt` | soft delete: the row is kept for the audit trail; its video + poster objects are deleted from the bucket |

A table, not the tenant config: guides are content with media, ordering and an audit trail, not a flag.

### API (`api/src/help/`)

| route | who | what |
|---|---|---|
| `GET /v1/gifsy/clients/:slug/help-topics` | GIFSY_ADMIN + `tenancy:read` | every guide for the client (preview media URLs) + `flagOn` |
| `GET …/help-topics/role-options` | `tenancy:read` | role choices: login roles + the tenant's hierarchy levels / outlet types |
| `POST …/help-topics` · `PATCH …/:id` · `DELETE …/:id` | `tenancy:write` | create (always a draft) / edit + publish / soft delete |
| `POST …/help-topics/reorder` `{audience, ids}` | `tenancy:write` | must list exactly the current guides of that audience |
| `POST …/:id/poster` (multipart `file`) · `DELETE …/:id/poster` | `tenancy:write` | PNG / JPG / WEBP ≤ 5 MB, checked by its actual bytes (not the file name or the browser's type) |
| `POST …/:id/video-uploads?bytes=` → `{uploadId, partBytes}` | `tenancy:write` | starts a chunked upload |
| `POST …/:id/video-uploads/:uploadId/parts/:n` (multipart `file`) | `tenancy:write` | ≤ 8 MiB per part. Part 0 must be an MP4 (`ftyp` box). QuickTime and HEIF are refused. |
| `POST …/:id/video-uploads/:uploadId/complete` | `tenancy:write` | checks the parts are contiguous and total ≤ 50 MB, joins them in GCS, sets `video/mp4`, swaps the video in ONLY if it is still the one read before (else 409 "changed by someone else — reload" and the new object is deleted; same for the poster) |
| `DELETE …/:id/video` | `tenancy:write` | removes the video; the steps stay |
| `GET /v1/sales/help-topics[/:id]` | SALES_* roles | published SALES guides for the caller's tenant and role |
| `GET /v1/partner/help-topics[/:id]` | SSS / WHOLESALER / SUB_STOCKIST | published PARTNER guides for the caller's tenant, login role and outlet types |
| `GET` / `HEAD /v1/help/media?token=` | public; the token is the only authority | streams the video or poster, with Range / 206 support (an inverted range is ignored → 200). HEAD returns the headers without opening the object. Limited per token (600/min, 4 concurrent streams) plus a per-IP backstop (6000/min — behind the Next rewrite `req.ip` is the frontend, so this is a per-instance cap) → 429 + Retry-After |

**Why the video goes up in parts.** The Next `/api` proxy truncates request bodies over 15 MB
(`proxyClientMaxBodySize`), and multer buffers every part in API memory. So the console sends the file as
8 MiB parts and GCS joins them on the server. No byte is held over 8 MiB, and no shared setting changes.
Parts go under `help-uploads/<client>/<topic>/<uploadId>/` and are deleted on complete or failure; an abandoned
upload is swept by a 1-day GCS lifecycle Delete rule on `help-uploads/` (**added to `terraform/gcs-memorystore.tf`,
NOT applied** — apply it with the next terraform run).

**Signed URL.** A member or console response carries
`/api/help/media?token=<HS256 JWT, 60 min, {typ:'helpmedia', sub: topicId, c: clientId, k: video|poster, h: fingerprint of the object key, p?: preview}>`.
On every request the server checks:

- the token's signature, type and expiry;
- the topic belongs to the token's tenant and is not deleted;
- for a member token, the topic is published and the tenant flag is ON (a console preview token skips these two);
- the topic's CURRENT object key still matches the token's fingerprint — replacing a video ends old streams with 404 instead of serving the new file's bytes mid-playback;
- the object exists and is within the size cap.

The object key itself is never in the token (only its fingerprint). Any failure returns a bare 404. GCS V4 signed URLs were not used because
blob-signing on Cloud Run is unreliable here: the KYC dump links already fail that way. This is the same
tokenized-stream pattern as KYC `docview` and scheme `schememedia`. The video bytes pass through the API as a
stream, never buffered.

**Flag OFF** (Deoleo, or Bajaj before go-live):
- `/v1/sales|partner/help-topics*` return 404 "Help & videos is not available".
- Member media tokens return 404.
- The FE renders no entry point.
- Authoring still works, so guides can be prepared before go-live, and the console shows a loud "feature is OFF" banner.

**Audit.** Every write adds an `AuditLog` row (`entityType 'HelpTopic'`, op = create / edit / publish /
unpublish / reorder / delete / poster-upload / poster-remove / video-upload / video-remove) in the **same
transaction** as the change.

### FE

- **Flag** `helpVideos` added exactly like `wholesalerPayoutInclActivation`:
  - `client-config.ts`
  - `default-client-config.ts`
  - `tenant-features.ts`
  - the console `[slug]` and `new` pages (FEATURE_META / defaults)
  - api `consoleFeatures` + `BOOLEAN_FEATURE_KEYS`
- **No new request on any existing page:**
  - The partner Profile reads `usePartnerIdentity().features` (it already loads this).
  - The sales Profile reads `SalesFeaturesContext`, which the sales layout fills from the `/api/sales/me` call it already made. Flag OFF or not yet loaded → the entry is not rendered.
- **Member screens** (`components/help/help-topics.tsx`, routes `/sales/help`, `/sales/help/[id]`, `/partner/help`, `/partner/help/[id]`):
  - The list, with an empty state ("No guides yet").
  - The detail: `<video controls playsinline preload="metadata">`, never autoplay, with the poster when there is one, and the numbered steps.
  - If the video errors, the guide is first re-read SILENTLY once (fresh token — the usual cause is a token that expired during a long pause) and playback resumes where it stopped. A second failure within a minute shows an amber note ("The video could not be loaded. Follow the steps below.") with a **Retry** button (re-reads the guide with a fresh token). The steps stay on screen throughout.
- **Console entry** ("Help & videos" link on the client page) is shown only to a GIFSY_ADMIN — the API is GIFSY_ADMIN-only, so GIFSY_STAFF never lands on a page that can only 403 (the page itself says "Only Gifsy admins can manage Help & videos." on a 403).
- **Roles must match the audience:** saving a guide whose role filter contains a role of the other app (e.g. after changing "Shown in") is refused with a message naming the role.

### Not done / follow-ups

- Cost item: the bucket-wide NEARLINE@90d lifecycle rule also applies to `help-videos/` (GCS conditions can only include prefixes, so it cannot be excluded without rewriting that rule for every prefix). NEARLINE reads cost ~$0.01/GB — negligible at the expected volume; noted in the terraform file.
- Video transcoding / compression is not done. Upload a phone-friendly H.264 MP4, 720p, ideally < 20 MB.
- Usage analytics (who watched what) are not recorded.

## 3. Seed content (enter via the console after deploy — NOT seeded into the DB)

Steps follow the real screens as of `f5abb310`. Bajaj-only screens are noted. Keep each step to one line.
Video ideas: a 30–90 s screen recording on a real phone, in portrait.

### SALES (Sales app)

**1. Install the app**
*Add the app to your home screen so it opens like a normal app.*
1. Open the app link in Chrome (Android) or Safari (iPhone) and log in with your mobile number and OTP.
2. Tap your avatar (top right) to open Profile.
3. Under "App & Notifications", tap "Install app" (Android).
4. On iPhone: tap Share, then "Add to Home Screen".
5. Open the app from the new icon on your home screen from now on.

**2. Allow location**
*KYC and visibility photos need your location.*
1. When the phone asks to allow location for this site, tap "Allow".
2. If you see "Location is blocked…", follow the numbered steps shown on that screen.
3. On Android Chrome: tap the icon left of the address bar → Permissions → turn Location on.
4. Make sure phone Location is on (pull down from the top of the screen).
5. If it says "Your phone's date and time are wrong", turn on automatic date & time in Settings.
6. Tap "Test again".

**3. Turn on notifications**
*Get alerts for KYC approvals, rejections and reminders.*
1. Tap your avatar (top right) to open Profile.
2. In "App & Notifications", tap "Enable notifications".
3. Tap "Allow" when the phone asks.
4. You should now see "Notifications: On".
5. If it says "Notifications are blocked", allow notifications for this site in your browser settings.

**4. Complete a KYC (UPI)**
*Enroll an outlet and capture its UPI ID.*
1. Go to "KYC" → "New Enrollment" and search the outlet under "Outlet Name / ID", then tap "Continue →".
2. Fill "Partner Information" (owner name, mobile, GST/PAN) and take the "Owner Photo".
3. Fill the "Shop Address", add the "Address Proof" and take the "Store Board Photo".
4. On "Bank Details", choose "UPI ID" and enter the UPI ID (only if your programme allows typing it; otherwise scan the QR, see the next guide).
5. Tick the consent boxes, get the owner's signature, and tap "Send OTP to Outlet Owner".
6. Enter the owner's 6-digit OTP and tap "Verify" — you'll see "KYC Submitted!".

**5. Complete a KYC (scan UPI QR)**
*Capture the UPI ID by scanning the shop's payment QR.*
1. Fill the Outlet, Details and Address steps as usual.
2. On "Bank Details", choose "UPI ID" and tap "Scan QR Code".
3. Point the camera at the shop's UPI QR; check the "UPI ID Scanned" box shows the right ID.
4. Wrong ID? Tap the X and "Re-scan QR Code".
5. Tick consent, get the signature, tap "Send OTP to Outlet Owner".
6. Enter the owner's OTP and tap "Verify".

**6. Visibility capture** *(Bajaj)*
*Send POSM photos for your outlets.*
1. On the Dashboard, open the "Visibility" card ("View visibility").
2. Find the outlet (search or filters); rows marked "Due" need a capture.
3. Tap "Capture" and take each photo with "Capture photo" ("Retake" to redo).
4. Allow location if asked — photos need it.
5. Tap "Submit capture" — you'll see "Capture submitted".
6. If a capture is "Rejected" or "Changes requested", tap "Recapture" and submit again.

**7. Check outlets & targets**
*See your outlets and how they are doing against target.*
1. On the Dashboard, check "Target Achievement" and "Target vs. Achievement".
2. Tap "View full outlet KPIs" (managers: "View team").
3. In "Outlets", switch between "Table" and "Cards".
4. Use the period, "All Beats", "All Types" and "All Programs" filters.
5. Tap an outlet to see its KYC status and details.

**8. Re-KYC (fix flagged details)**
*Fix the details the reviewer flagged.*
1. Go to "KYC" and filter by "Re-KYC Required" (or "Rejected").
2. Open the outlet and read the amber banner — it lists the fields to re-capture.
3. Tap "Edit & Resubmit KYC".
4. Only the fields highlighted in amber can be edited — fix or re-upload them.
5. Send the OTP to the owner, enter it and tap "Verify" — you'll see "Re-KYC Submitted!".

**9. Raise a support ticket**
*Report a problem for an outlet or yourself.*
1. Tap "Support" in the bottom bar, then "New Ticket".
2. Choose "For an Outlet" (search the outlet) or "My Own Issue".
3. Pick the "Issue Type" and "Priority".
4. Add a short "Subject" and the "Details".
5. Tap "Submit Ticket" and track it under "Active Tickets".

### PARTNER (Partner app)

**1. Install the app**
*Add the app to your home screen.*
1. Open the app link in Chrome (Android) or Safari (iPhone) and log in with your mobile number and OTP.
2. Tap the profile icon (top right) to open your account.
3. Under "App & Notifications", tap "Install app" (Android).
4. On iPhone: tap Share, then "Add to Home Screen".
5. Open the app from the new icon from now on.

**2. Turn on notifications**
*Get alerts for points, payouts and orders.*
1. Tap the profile icon (top right).
2. In "App & Notifications", tap "Enable notifications".
3. Tap "Allow" when the phone asks.
4. You should see "Notifications: On".

**3. Your wallet**
*See what you have earned and been paid.*
1. Tap "Wallet" in the bottom bar.
2. The top card shows your points ("Available to Redeem") and/or "Lifetime Payout".
3. Scroll to the "Statement"; use "All", "Earn", "Burn" to filter.
4. Tap the period to pick "From" / "To" months, then "Apply".
5. Tap "Download" for an Excel or PDF copy.

**4. Catalogue & wishlist**
*Browse rewards and save the ones you want.*
1. Tap "Redeem" in the bottom bar to open the "Rewards Catalogue".
2. Switch between "Physical", "Vouchers" and "Cash Payout"; use search or "Within my points".
3. Tap any item to see its details.
4. Tap the ♥ heart to add it to your wishlist.
5. Tap "Wishlist" next to your balance to see saved items.

**5. Redeem a voucher**
*Turn your points into a gift voucher.*
1. In "Redeem", open the "Vouchers" tab and tap a voucher.
2. Choose an amount and check "Points required" against "Your balance".
3. Tap "Send OTP" and enter the 6-digit OTP sent to your mobile.
4. Tap "Confirm" — you'll see "Voucher ready" or "Voucher confirmed".
5. Open "Orders" on the Rewards page to see and "Copy" your voucher code.
