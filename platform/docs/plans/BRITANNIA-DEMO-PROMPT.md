# Britannia Sales-Rewards — Demo Prototype Prompt

> **Status: PITCH ASSET (disposable). Created 2026-07-18.**
> This is the finalized prompt for a **throwaway, front-end-only clickable demo** of a Britannia
> field-sales-rep rewards app. It is a *pitch artifact*, NOT the product. Build it in a **separate,
> fresh session + its own repo** (e.g. `britannia-rewards-demo/`), fully decoupled from this
> production monorepo. If Britannia converts, the product is built for real on the existing engine
> (see "Transport / reuse" at the bottom, and [EMPLOYEE-REWARDS-PROPOSAL.md](./EMPLOYEE-REWARDS-PROPOSAL.md)).
>
> **Framing note:** the owner treats "employee rewards" and "Britannia sales-rep rewards" as the
> same product — identical mechanics (points → wallet → catalog → campaigns → celebratory). The only
> difference is *who the user is / why points arrive*: internal staff (recognition) vs the field
> sales force (performance). This demo uses the **sales-rep** flavor with a **credited + campaigns**
> earn model (Britannia computes performance offline and credits points; campaigns add bonus).

---

## The prompt (paste into a fresh session / v0 / Cursor)

```
You are an award-winning Product Designer and Senior Frontend Engineer.

Build a premium, high-fidelity, MOBILE-FIRST clickable prototype: a Sales Rewards app for
BRITANNIA field sales representatives.

This is a SALES DEMO, not a production app. Front-end only. Mock data only. No backend, no auth,
no APIs, no database. Optimise for one flawless scripted click-through (the "golden path" below),
not for breadth.

TECH
- Next.js (App Router) + React
- Tailwind CSS
- shadcn/ui
- Framer Motion
- lucide-react for icons

STEP 0 — DEFINE A DESIGN TOKEN SYSTEM FIRST, THEN APPLY IT EVERYWHERE
Before building screens, define tokens in one place (Tailwind theme + CSS variables) and reuse them.
Do NOT hardcode colours/spacing in components.
- Brand: Britannia red as the ACCENT only (approx #D6001C), used sparingly on a clean neutral canvas
  (premium = restraint; never a red-flooded UI). Primary surface is near-white / soft neutral.
- Neutrals: a 6–8 step warm-grey ramp for text, borders, surfaces.
- Support both LIGHT and a considered DARK mode.
- Type scale: one display size (hero numbers), then a clear 5-step ramp; a single premium sans
  (Inter or similar). Generous line-height.
- Spacing: 8pt grid. Generous whitespace is the default, not the exception.
- Radius: soft, generous (cards ~16–20px, pill buttons). Shadows: soft, low-opacity, layered.
- Motion tokens: standard easing + durations; respect prefers-reduced-motion (disable non-essential
  motion when set).

DESIGN PHILOSOPHY
Feel like Apple, Linear, and Stripe. Minimal, elegant, aspirational — NOT operational.
- One clear purpose per screen. Lots of whitespace.
- Every card must justify its existence. If data is unavailable, HIDE the card — never show
  placeholders or empty states dressed as content.
- No dashboard clutter, no analytics/ERP/reporting screens, no widget soup.

DEVICE
Mobile-first (this is how field reps actually use it). Design the phone layout first and best; then
provide a clean, balanced desktop layout (centered max-width, no stretched full-bleed tables).
Bottom tab bar on mobile.

PRODUCT STORY (earn model — read carefully)
Britannia calculates each rep's sales performance and CREDITS reward points to them; CAMPAIGNS add
bonus points on top. The app is NOT a calculator — it is where a rep sees their points, chases a
"Dream Reward", and redeems. Points are redeemed for rewards. The app should continuously motivate
the rep to perform better.
THE HERO CONCEPT is the "DREAM REWARD": one aspirational reward the rep optionally picks and chases.
- If chosen: the app continuously shows progress toward it.
- If not chosen: the app still feels premium and motivating (a beautiful CTA to choose one).

MOCK PERSONA + DATA (make it feel unmistakably Britannia, not generic)
- Rep: "Arjun Mehta", Sales Officer, West Delhi beat.
- Product context in copy/campaigns: Good Day, Bourbon, Marie Gold, NutriChoice, Milk Bikis, Treat.
- Performance snapshot: monthly target vs achievement in CASES (e.g. 820 / 1,000 cases, 82%).
- Points balance: a realistic five-figure number (e.g. 47,250 pts).
- Dream Reward preselected for the demo: an Apple Watch (so progress shows immediately); alt examples
  Sony headphones, a bike down-payment voucher, a family holiday voucher, an iPhone.
- Campaigns: 2–3 realistic ones (e.g. "Bourbon Blitz — sell 50 extra cases", "Range Rockstar —
  stock all 6 lines"), each with progress, days remaining, bonus points.

PRIMARY NAVIGATION (bottom tab bar): Dashboard · Rewards · Wallet · Campaigns · Profile
(Support lives in Profile / a header icon — keep the tab bar to 5.)

DASHBOARD (the strongest screen — but resolve density with a clear hierarchy)
Mobile scrolls naturally; do NOT cram. Priority order (top → bottom):
1. DREAM REWARD (the hero): product image, an animated circular progress ring, % complete, points
   remaining, estimated completion date. This is the emotional centre of the screen.
2. POINTS BALANCE: one large animated hero number (counts up on load).
3. LIVE CAMPAIGNS: show ONE campaign card at a time in a horizontal swipeable carousel (name, short
   description, progress, days remaining, potential bonus points, "View Campaign"). Only render if
   campaigns exist. Never show a stacked list.
4. PERFORMANCE SNAPSHOT (compact, secondary): target vs achievement (cases) + achievement % — small
   stat tile, NOT a big chart. It explains WHY points arrive; it is not the star.
5. ONE latest insight (single line, positive, contextual — e.g. "Your Dream Reward is now 82%
   complete." / "You earned 850 points."). Never a notification list.
No other cards. If Dream Reward isn't selected, replace card 1 with a beautiful "Choose your Dream
Reward" CTA and keep the rest.

DREAM REWARD PAGE (the signature feature)
Large product image, current progress, points remaining, estimated completion date, and an
INTERACTIVE FORECAST:
- A slider to explore different monthly earning rates. As it moves, the projected completion date
  updates in REAL TIME. This is a planning tool only — it modifies no data.
- Let the user pick a personal target date and show whether they're ahead/behind pace.
- Let the user change their Dream Reward (opens the rewards grid).

REWARDS
Premium responsive grid. Each card: image, points required, a subtle progress bar vs the rep's
balance, and a "Dream" badge on the selected one. Tapping a card opens a detail sheet with a Redeem
action (enabled only if balance ≥ cost).

WALLET (deliberately NOT motivational — it should read like a bank statement)
A clean ledger: Date · Activity · Points (+/-) · Running Balance. Calm, monochrome, no confetti, no
hype. This restraint is intentional and premium.

CAMPAIGNS
List → detail. Detail page: campaign banner, goal, current progress, remaining target, potential
bonus points, days remaining, and "Impact on your Dream Reward" (e.g. "Completing this moves your
Apple Watch 6 days closer") when a Dream Reward is selected.

PROFILE
Rep identity (name, role, beat, employee code), notification preferences, and a Support entry
(simple contact / raise-a-query — a single form, not a ticketing console).

NOTIFICATIONS
Short, positive, contextual, never generic. Examples: "You earned 850 points." · "Your Dream Reward
is now 82% complete." · "Your estimated reward date moved 8 days earlier." · "Only 2,500 points
remain." On the dashboard show only the single latest one.

ANIMATIONS (tasteful, not a toy)
Framer Motion: animated hero counters, animated progress ring/bars, smooth page/sheet transitions,
subtle card hover/press. Confetti ONLY after a successful redemption. Honour prefers-reduced-motion.

THE GOLDEN DEMO PATH (build these interactions so a presenter can click straight through)
1. Land on Dashboard (no login — a one-tap "Enter demo" splash is fine). Hero counter + ring animate
   in.
2. Tap Dream Reward → drag the forecast slider → watch the completion date move in real time.
3. Back → swipe the campaigns carousel → open one campaign → see its Dream-Reward impact line.
4. Go to Rewards → open a reward the rep can afford → Redeem → confetti → success sheet.
5. Go to Wallet → the redemption appears as the latest debit with the new running balance.
Every step above must actually work with mock state (redeeming debits the mock balance and adds a
wallet row).

DO NOT
- Do not build a backend, auth, or APIs.
- Do not add analytics dashboards, ERP screens, or admin/management views (this is the REP app only).
- Do not over-design or add unnecessary widgets. Do not flood the UI with red.
- Do not show placeholder/empty cards — hide instead.

DELIVER
A runnable Next.js app with all rep-facing screens above, seeded with the Britannia mock data, the
golden path fully clickable, light + dark mode, and mobile-first responsive layout.
```

---

## Where to build it
- **Separate fresh session, its own repo** (`britannia-rewards-demo/`), decoupled from this monorepo.
- Fastest polished visual first-pass: **v0.dev**. Best control + working golden-path interactions:
  a **fresh Claude Code session** with the demo folder as the working dir.
- The demo stays throwaway; do NOT commit it into `Loyaltybaseclaude`.

## Transport / reuse when built for real

The real platform already uses the **same foundation** the demo will — Next.js + React + Tailwind +
`@radix-ui/*` + `class-variance-authority` + `tailwind-merge` (= the shadcn/ui stack) + a
`@/components/ui` layer. The **only** new dependency the demo introduces is **Framer Motion**
(trivial to add).

- **Transports easily (the high-value part):** design tokens, screen layouts, the premium look, the
  Framer Motion polish, the Dream Reward treatment, celebratory UX, information architecture. Because
  the demo is built in the same component idiom, lifting the *visual layer* is low-friction — not a
  rewrite.
- **Does NOT transport (by design):** mock data + mock state. Real screens bind to the backend
  `/api/*` → `/v1/*` proxy, with real auth, multi-tenant scoping, and money-path rigor. That wiring
  is the actual engineering; the demo fakes it deliberately.
- **Favorable reality:** Britannia sales-rewards ≈ the **existing sales-rep app** (already wired to
  real targets/points/wallet/rewards/schemes) **+ this demo's premium reskin + the one new Dream
  Reward feature.** "Build it for real" ≈ reskin an already-working app in a matching idiom + add one
  signature feature — not greenfield.
- **Mental model:** treat the demo as a *high-fidelity, interactive design spec*, not a head start on
  production code. The look comes over easily; the plumbing gets rebuilt properly.
