# Payouts Guide — canonical source pointer

The **Payouts — How It Works** guide is a live, in-portal resource. To avoid two copies
drifting apart, the single source of the guide text now lives in the frontend:

- **Content (single source):** `platform/src/content/guides/payouts.ts`
- **Screenshots:** `platform/public/guides/payouts/*.png` — regenerate with
  `node platform/scripts/capture-payout-screens.mjs` (drives the staging operator console).
- **On the portal:** log in as a Gifsy operator → **Work in brand** → left menu **Help & Guides**
  → *Payouts — How It Works*. There's a **Print / Save PDF** button for a takeaway copy.
- **Audience:** GIFSY_ADMIN + GIFSY_STAFF only (nav hidden + pages guarded for tenant admins).

To edit the guide, change `payouts.ts` (plain markdown). To add another guide, add a module and
register it in `platform/src/content/guides/index.ts`.
