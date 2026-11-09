import type { Guide } from './index';

/**
 * "This month's offers" guide — SINGLE SOURCE of the guide text (rendered at /admin/guides/offers).
 * Audience: the Gifsy ops team. Keep it plain and concise. See platform/docs/plans/OFFER-TILES-PLAN.md.
 */
export const offersGuide: Guide = {
  slug: 'offers',
  title: "This Month's Offers — How It Works",
  summary:
    'Offer tiles on the partner dashboard: what they are (display-only), how to switch the feature on, targeting, KPI progress, publish/draft, and copying last month.',
  updated: '2026-11-09',
  markdown: `# This Month's Offers — How It Works

*A plain-English guide to offer tiles: the "This month's offers" section on the partner (outlet) dashboard.*

## What a tile is

A tile is a short piece of **content** shown to partners, for example **+35 pts · per case · ADHO 50 ml · Earn on every case**.

- Tiles are **display-only**. They never credit, compute or reserve points or money. Rewards are still credited only through the normal programme flows (uploads, payouts, the points engine).
- Each tile belongs to one of two groups: **Earn on your targets** or **Extra schemes this month**.
- The big value can be **Points** (+35 pts), **Percent** (+2.5%, up to 100), **Rupees** (₹1,500 or ₹1,500.50) or short **Text** (up to 12 characters, e.g. "Free kit"). Numbers must be greater than 0. The unit label (e.g. "per case") shows on its own line under the value.
- Partners tap a tile to see its details and terms in a bottom sheet. The sheet always ends with "Offer details are shared by [tenant name]. Terms apply."

## Switching it on for a tenant

The feature is **off by default** for every tenant. One switch, **This month's offers** in the Gifsy console for the client, controls the **whole** feature:

- **On:** the **This Month's Offers** page appears in that tenant's admin menu for Gifsy admins (while assumed into the tenant) and the tenant's client admins, **and** partners of that tenant can see the "This month's offers" section on their dashboard.
- **Off:** neither the admin page nor the partner section appears. The partner dashboard looks exactly as before, even if tiles were created earlier.

With the switch on, the partner section shows only when at least one **published**, **currently valid** tile matches that outlet. With no such tile, the dashboard looks exactly as before.

## Creating a tile

1. Open **This Month's Offers** and pick the month and year.
2. Click **New tile**, then fill in the value, unit label, product, headline and details.
3. Set **Valid from / Valid to**. These are calendar days in India time, both inclusive. They default to the selected month.
4. Choose the **audience** (below) and, optionally, a KPI for progress.
5. The **Partner preview** on the right shows exactly what partners will see.

## Targeting (audience)

You can narrow a tile by **Program**, **Outlet type**, **Zone** and **State**, which come from the outlet master.

- Leaving a list empty means **all**. A tile with nothing ticked goes to every outlet of the tenant.
- When several lists are used, an outlet must match **every** list that has something ticked.
- A partner with several outlets sees the tile if **any** of their active outlets match.

## KPI progress

Under **Show this outlet's progress on** you can link a tile to one of the tenant's KPIs. The partner then sees a progress bar with their own achieved-vs-target for the current month, and **Unlocked** once they reach 100%.

- Progress uses the same target and sales data as the Target Achievement card, added up over the partner's outlets that match the tile's audience.
- If the outlet has no target for that KPI this month, the tile still shows, just without a bar.
- "Unlocked" is information only. It does not credit anything.

## Publish / Draft

Each tile has a **Published / Draft** toggle. Partners see only published tiles that are valid today. Use Draft to prepare tiles ahead of time.

## Copy last month

**Copy last month** copies every tile that started in the previous month into the selected month:

- Copies get the full selected month as their validity.
- Copies always land as **Drafts**. Review the values, then publish them.
- Running it again does not create duplicates. Tiles already copied are skipped, and the result tells you how many were created and skipped.

## Deleting

Delete removes the tile from the partner dashboard straight away. Every create, change and delete is recorded in the audit log.
`,
};
