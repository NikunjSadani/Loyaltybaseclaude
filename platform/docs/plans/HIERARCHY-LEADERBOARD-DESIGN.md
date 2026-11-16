# Hierarchy-driven leaderboard — design (source of truth)

**Status:** ✅ IN PROD (`9b3d7034` on `main`, early November 2026) · designed 2026-11-03 · **PLATFORM-WIDE** (owner-approved in-session — changes every
tenant's Ranks screen, incl. live Deoleo).

## Problem
The sales Ranks/Leaderboard had three **fixed** tabs — **Reporting Mgr / State / National** — that
widened the same-level peer net by geography. The owner wants the tabs to reflect the individual's
**reporting hierarchy** instead: the (up to) three managers above them, which is more relevant per
person.

## The model (locked with the owner)
- **Tabs = the caller's reporting chain, up to 3 managers up.** Walk `caller.reportingToId` upward,
  collecting each ancestor (immediate manager first). Each ancestor is one tab.
- **Tab 1 = the immediate reporting manager** (≈ today's "rm"); tabs 2–3 widen up the chain.
- **Tab label = the ancestor's name**, falling back to their hierarchy-level name when the name is
  blank (never a blank tab).
- **Cohort per tab = all the caller's SAME-LEVEL peers within that ancestor's sub-tree.** E.g. the
  "ZNM Example" tab ranks every SO under that ZNM (not mixed levels), each scored by their own team's
  achievement — unchanged scoring.
- **Geography is fully removed** — no State/National geography tabs.
- **A national head (nobody above)** → a single `'national'` tab of their own-level peers nationwide.
- Fewer than 3 ancestors ⇒ fewer tabs (an SM near the top sees 2, a ZH sees 1).

## Backend (`api/src/sales/sales.service.ts` `getLeaderboard`)
- Signature `getLeaderboard(user, scope?, period?)`; `scope` is now a **tab id** (an ancestor
  SalesUser id, or `'national'`).
- Returns `{ tabs: {id,name}[], selectedTabId, entries }`.
- Ancestor walk capped at `MAX_LEADERBOARD_LEVELS=3` and at the user count (cyclic-chain defence).
- Level names via `salesHierarchyLevel.findMany` → `levelNameById` (tab-name fallback + national tab).
- **Security:** `selectedTabId` is honored only when it is one of the **caller's own** tab ids;
  otherwise it falls back to `tabs[0]` — a forged/foreign id can never rank outside the caller's
  chain. The cohort uses `descendantSalesUserIds(selectedTabId)` which walks **down** only, so it is
  strictly that ancestor's downline at the caller's level. All queries stay tenant-scoped by clientId.
- The scoring/ranking/delta-vs-last-month logic is unchanged (it maps over the new `population`).

## Frontend (`platform/src/app/sales/leaderboard/page.tsx`)
- Removed the hardcoded `rm|state|national` scopes + `SCOPE_LABELS`.
- First load fetches with no scope → the response gives `tabs` + `selectedTabId` (immediate manager)
  + `entries`. Tabs render dynamically from `tabs` (1–3 of them), labeled by ancestor name; clicking
  one refetches `?scope=<tabId>`. The subtitle shows the selected tab's name.

## Why Deoleo (and every tenant) changes
This is platform-wide by owner decision: all tenants move from geography tabs to hierarchy tabs. No
feature flag. Verified by: the full gates, a dual scoping audit (no cross-chain/cross-tenant leak),
and staging runtime checks across roles (an SO sees up to 3 tabs, an SM 2, a ZH 1).

## Audit hardening (dual audit, 2026-11-03)
Security/scoping audit: **cleared** — no cross-chain or cross-tenant leak (the `tabs.some(id===scope)`
guard + the `'national'` short-circuit mean `descendantSalesUserIds` is only ever called with a
caller-owned ancestor id; every query is clientId-scoped). Applied fixes from the correctness audit:
- **userId key (was a HIGH):** `SalesEntry` now carries an opaque `userId`; the FE keys the rankings
  list on it so identically-named peers in a large cohort can't collide on a React key (wrong "You"
  highlight / dropped rows).
- **Tab-switch race:** the FE fetch effect ignores out-of-order responses (cleanup `cancelled` flag).
- **Cycle-guard:** the ancestor up-walk has a `seen` set (parity with the other hierarchy walks).
- Build-nameability: `LeaderboardTab`/`LeaderboardResult` are exported (the controller's return type).
- Known low-exposure edges (not fixed): an inactive caller can't log in; a soft-deleted-without-reparent
  manager would drop a caller to the national tab; a non-strict tree could pull deeper same-level nodes.

## Tests
- Backend: tabs = ancestor chain + default selectedTabId; cohort narrows/widens per ancestor;
  national-head single tab; forged-scope → tab-1 fallback; no-caller empty; + the retained
  territory/pct/delta/subtree/cross-tenant/inactive cases.
- FE: dynamic tab names render; tab click refetches with that tab id; single-tab (national) renders one.
