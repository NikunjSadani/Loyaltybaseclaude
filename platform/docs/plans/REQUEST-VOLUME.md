# Request volume (edge quota)

**Status:** `feat/request-volume` **in build, LOCAL ONLY** (not pushed). ⚠️ PLATFORM-WIDE — owner-approved 2026-11-21.
**The owner wants measured request numbers and trade-offs before it ships** (`RESUME.md` §4 item 10).

## Outage evidence (2026-11-20)

- 16:20–16:27 UTC every `*.gifsy.in` tenant returned Cloudflare **Error 1027**: the Workers FREE plan cap
  (100k requests/day) was hit. Every page view, RSC prefetch and API call passes the `gifsy-proxy` Worker.
- Owner upgraded to **Workers Paid** ($5/mo, 10M requests/month). TODO: confirm the monthly budget against the peak.
- Cloud Run logs: normal ~1–2k req/h jumped to **~30k req/h** from ~17:30 IST with **87 concurrent Bajaj sales users**.
- **~42%** of frontend requests were Next.js RSC fetches — prefetch of every visible outlet-detail link on
  `/sales/kyc` and of the bottom-nav pages.
- Plus a per-screen refetch of `/sales/me`, `/auth/me`, `/settings`, `/settings/outlet-types`, `/partner/banners`,
  `/notifications/unread-count`.

## Plan (what the branch does)

1. No prefetch on list links (e.g. the outlet links on `/sales/kyc`).
2. Bottom-nav prefetch once per session.
3. Session cache for me / settings / outlet-types / banners.
4. Dashboard data reused for 2 minutes.
5. Invalidation after a submit, so a user sees their own change at once.

## Trade-offs (expected, NOT yet measured — to be measured before ship)

- Without prefetch, the first open of an outlet page / nav tab can feel slower (fetched on tap instead of in advance).
- Session-cached data (settings, outlet types, banners) can be stale within a session until a reload or an
  invalidating submit — e.g. a flag the Gifsy console changes mid-session.
- Dashboard reuse: numbers can be up to 2 minutes old.
- TODO: measured numbers — requests per screen / per user-hour before vs after, and page-open timings.

## Related trap

`RESUME.md` §8 "Cloudflare Workers request quota": any change that adds per-screen fetches, polling or `<Link>`
prefetch on long lists multiplies edge requests — count them.
