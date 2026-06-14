# Phase 0 — Foundation

## §1 Vision & Problem Statement

**Loyaltybase** is a multi-tenant SaaS platform, operated by **Gifsy** (the company),
that lets consumer brands run digital trade-loyalty and channel-incentive programs for
their distribution partners (retailers, wholesalers, sub-stockists). Served on
`<tenant>.gifsy.in`. Anchor tenant: **Deoleo India** (brands Bertolli, Figaro).

**Problem.** Brands run trade loyalty through spreadsheets, WhatsApp, and manual
payouts. There is no auditable system to enroll/KYC partners, set targets, validate
achievement, credit points or INR, process payouts with UTR proof, run visibility
programs with auto-invoicing, or give partners and field sales a live view. It does not
scale across brands or geographies.

**Solution.** One tenant-isolated platform with four portals — **Gifsy** (operator),
**Client Admin**, **Sales** (multi-tier hierarchy), and **Partner** — covering
enrollment→KYC→credentialing, target config & achievement upload, wallet/points, gift
redemption or INR payouts, visibility-based payouts with automated invoices, support
tickets, and dashboards. Every capability is per-tenant configurable.

**Success metrics** *(to confirm — not yet instrumented):* partner activation rate, KYC
approval cycle time, % payouts with UTR, monthly active partners/sales, redemption rate.

## §2 Personas & Roles

Fixed **portals**, but roles *within* a portal are intended to be **tenant-defined and
feature-tagged** (see Gap #2). The current `UserRole` enum has 11 coarse roles:

### Operator portal — `gifsy/`
- **GIFSY_ADMIN** — Gifsy staff; super-admin across *all* tenants. Scheme/activation
  creation, offline payout processing + UTR, final KYC validation, gift-catalogue
  management, cross-tenant tickets, visibility auto-invoicing.

### Client portal — `admin/` (single tenant)
- **CLIENT_ADMIN** — brand program owner. Employee hierarchy, outlet master, target
  config + achievement upload, banners/HO notifications, payout uploads, dashboards.
- **MIS_USER** — currently undifferentiated. **Target:** configurable admin sub-roles
  (Reporting, Finance, HR…) with features tagged per role (Gap #2).

### Sales portal — `sales/` (configurable reporting tree)
- **Tenant-configurable hierarchy** — number of levels and naming are tenant-driven.
  Industry reference ladder (low→high): **ISR** (In-Store Rep, leaf) < **SO** (Sales Officer)
  < **ASM** (Area Sales Mgr) < **RSM** (Regional Sales Mgr) < **ZNM** (Zonal Mgr) <
  **NSM** (National Sales Mgr).
- **ISR** is the leaf: enrolls outlets, initiates KYC, mapped to outlets. Managers see
  subordinate + team performance. KYC approval follows the reporting tree (Gap #9).
- Current `UserRole` enum encodes only a 5-level subset
  (`SALES_HO`/`SALES_STATE_HEAD`/`SALES_ASM`/`SALES_SO`/`SALES_ISR`) — no Zonal rung; see Gap #11.

### Partner portal — `partner/` (3 classes)
- **SSS, WHOLESALER, SUB_STOCKIST** — trade partners. See targets + achievement, wallet,
  redeem gifts/INR, raise tickets, manage profile. Carry a loyalty Tier.

## §3 Glossary (Ubiquitous Language)

### Identity, tenancy, distribution
- **Gifsy** — platform operator (company); super-admin tenant.
- **Tenant / Client** — a brand running programs; keyed by `clientId` slug; served on
  `<slug>.gifsy.in`.
- **Channel Partner ("Partner")** — trade business account holding a login (1:1 `User`);
  carries a Partner Class and a Tier.
- **Outlet** — a physical store under a Partner. **Operated 1:1 with Partner today**
  (Gap #4); two-level model reserved for future multi-outlet partners. Login + wallet
  bind at Partner level; KYC + visibility often at Outlet level.
- **Partner Class** — segmentation (`CP_01/02/03`) → retailer / wholesaler / sub-stockist.
- **Tier** — loyalty standing (Platinum→Standard) from points; drives multipliers/benefits.
- **Sales User** — brand field employee in a configurable reporting tree (HO→ISR leaf),
  assigned to Partners/Outlets.

### Program & value mechanics
- **Loyalty Program** — *ongoing* rewards for **top / KYC'd** partners.
- **Scheme / Activation** *(synonyms; "Scheme" canonical)* — a **time-bound** incentive
  campaign that can target **all outlets, incl. non-KYC**, with a configurable enrollment
  form (variable fields), per-activation enrollment mode (self vs sales-only), and
  conditional pre-fill from the loyalty profile (Gap #6).
- **KYC** — enrollment: collect documents → validate → multi-level approval → credentials.
- **Target** — period-based goal for an outlet; own status lifecycle.
- **Achievement** — actual performance uploaded and measured against a Target.
- **Wallet** — a Partner's store of value: **Points** and/or **INR**.
- **Points** — loyalty currency; ledgered, expirable, redeemable.
- **Redemption** — exchange points for **Gifts** (Gifsy **Reward Catalogue**) or INR.
- **Payout** — monetary disbursement (target-based or visibility-based); offline batches
  with a **UTR**; **TDS** deducted; may generate an **Auto-Invoice**.
- **UTR (Unique Transaction Reference)** — the reference ID of an **executed bank transfer**,
  recorded against payout entries as proof of payment. One UTR may cover several **clubbed**
  parameters; **Visibility always gets its own UTR**.
- **Credit** — crediting points/amounts to outlets via bulk upload ("Credits & Payouts").
- **Visibility** — in-store branding program: submit photos → approval → payout + invoice.

#### Financial relationship types (canonical)
- **Direct (Client → Outlet)** — incentive parameters (monthly target, focus-product
  target, …). Rewards from brand to partner. **Clubbable** into one payout + one UTR.
- **Indirect (Client → Gifsy → Outlet)** — **visibility only**. Outlet renders a
  visibility *service* to Gifsy; outlet raises a **GST tax invoice to Gifsy** (auto, logic
  from the outlet's GST registration). **Always a separate UTR; never clubbed.** Modeled
  today via `CreditField.isSeparatePayout`. Gifsy→Client billing side: see Gap #8.
- **Ticket / Banner / HO Notification / Consent / Data Request** — support, partner-app
  merchandising, and DPDP-style privacy artifacts.
