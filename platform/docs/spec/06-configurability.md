# Phase 3 — §06 Per-Tenant Configurability Matrix

Every knob that varies by tenant. **Current home** legend: `CODE` = `CLIENT_REGISTRY`
(`lib/platform/`); `BLOB` = `ProgramSetting` JSON; `REL` = relational table; `FLAG` =
`ClientConfig.features`; `—` = not built. Target is the intended management surface.

> **Meta-gap (→ Gap #22, High):** the bulk of tenant config lives in **`CODE`** — onboarding a
> tenant or changing a flag is a **code change + redeploy**, not an admin action. Target: a DB-
> backed `Client` config managed by Gifsy/Client Admin. (Ties to Gaps #2, #18.)

## 0 · Multi-tenancy & customization model (locked with owner, 2026-06-16)
How the platform stays one codebase across many FMCG clients with per-client customization. Built into the
**dedicated backend** (`../plans/BACKEND-SPLIT-PLAN.md`).

1. **Multi-tenancy = config + data, NEVER code branches.** Every row carries `clientId`; behavior varies by
   **reading per-tenant config** (the knobs in §A–H below — `Client`/`ClientConfig`/`ProgramSetting`), not by
   `if (clientId === …)`. **A `clientId` literal in backend logic is a design failure.**
2. **Tenant isolation = one backend-enforced point.** The backend adds a **tenant-scoping guard/interceptor**
   (single chokepoint), replacing per-query `where:{clientId}` discipline; Postgres RLS is a later hardening
   (Gap #23). This is a concrete win the split unlocks.
3. **Customization spectrum — climb only as far as a real requirement forces:**
   - **(a) Config** (default) — a tenant differs by flags/lists/values. Covers branding, module toggles, hierarchy
     labels, programs, KYC fields, value mechanics. **No code.**
   - **(b) Extension seam** — a tenant needs genuinely *different logic* in one domain → add a **strategy interface
     in that one module** (NestJS DI binds a per-tenant implementation). **Deferred (YAGNI):** we do **not** build a
     customization framework now; we add a seam **when a paying client requires it.** The only up-front cost is
     **clean, well-bounded modules**, which is free.
   - **(c) Forking domain code per client — never.**
4. **Effort, now vs later (why this shape is cheap):** the platform is **already multi-tenant** (clientId
   everywhere + `Client` model + isolation), so it ports with the split at **~0 extra cost**. Onboarding the next
   client — expected ~2 months after go-live, **same loyalty model** — is a **config + data-load exercise (days),
   not engineering.** Real per-client logic divergence costs **days, scoped, when it arrives** (option b), vs
   **weeks of speculative framework** if built now. So: spend ~0 now on customization machinery; defer it.
5. **Multi-consumer auth (web + mobile + partner).** One versioned API (`/v1`); **Bearer-JWT in header** (not
   cookies) works identically for web/mobile/PWA. Partner/third-party integrations get **scoped API keys /
   OAuth client-credentials** (added when the first integration is real — option b, deferred).
6. **No compute for the current client.** The backend **ingests/tracks** uploaded target/achievement/wallet
   amounts; it does not compute incentives. A future client needing computation is an option-(b) seam, not core.
   See `../plans/MODEL-ALIGNMENT.md`.

## A · Module toggles (`ClientConfig.features`)
| Setting | Controls | Home | Target |
|---|---|---|---|
| `visibilityInvoiceModule` | Visibility + self-bill invoicing on/off | FLAG/CODE | DB |
| `kycApprovalFlow` / `multiLevelApproval` | KYC multi-level approval on/off | FLAG/CODE | DB |
| `walletModule` | Wallet/points on/off | FLAG/CODE | DB |
| `salesTeamApp` | Sales portal on/off | FLAG/CODE | DB |
| `referralModule` | Referral schemes on/off | FLAG/CODE | DB |
| `campaignEnrollmentForm` | Activation enrollment forms on/off | FLAG/CODE | DB |
| `nonKycOutletCampaigns` | Activations for non-KYC outlets | FLAG/CODE | DB |
| `selfEnrollmentAllowed` | Self vs sales-only enrollment (tenant-wide) | FLAG/CODE | **per-activation** (Gap #6) |

## B · Access & RBAC
| Setting | Controls | Home | Target |
|---|---|---|---|
| Admin roles + section/feature tags | Which admin sections each role sees | — | DB-managed RBAC (Gap #2/#3) |
| Sales data scope | Mapped-outlet scoping + team rollup | REL (hierarchy) | keep; derive from tree |
| Partner scope | Own-data-only | REL | keep |

## C · Organization
| Setting | Controls | Home | Target |
|---|---|---|---|
| Sales hierarchy names + level count | XSR<SO<ASM<RSM<ZNM<NSM (tenant labels) | REL (`SalesHierarchyLevel`) ✅ now single source (P2.1) | done (Gap #18/#11) |
| Approval hierarchy (L1/L2, `requireGifsyFinalApproval`) | KYC approver levels + Gifsy-final | CODE | DB; drive from tree (Gap #9) |
| **Program / Program category** (per-tenant valid-lists) | **The segmentation dimension** (`Outlet.programName/programCategory`, set at outlet upload) — **replaces partner class** | BLOB (`ProgramSetting`) | optionally DB-backed `Program` master (P4) |
| Outlet types | Per-tenant outlet-type configs (SSS/WHOLESALER/SUB_STOCKIST/SSS_TOT) | REL (`OutletTypeClientConfig`) | keep |
| ~~Partner classes / Tiers~~ | ~~`CP_01/02/03`, multipliers~~ | — | **RETIRED → program (P4.0 de-scaffold)** |

## D · Enrollment & KYC
| Setting | Controls | Home | Target |
|---|---|---|---|
| Enrollment mode (self vs sales) | Per **activation** | FLAG (tenant-wide) | per-activation (Gap #6) |
| Enrollment form fields + pre-fill | Variable fields; loyalty pre-fill | — | build (Gap #6) |
| Gifsy final approval | On/off | CODE | DB |
| GST reg type capture | Regular/Composition/Unregistered → invoice GST | partial | first-class outlet attr (Gap #15) |

## E · Value mechanics
| Setting | Controls | Home | Target |
|---|---|---|---|
| Points expiry | Whether/when points expire | REL (`PointExpiryConfig`) | keep; wire to wallet |
| Holding/lock period | When points become redeemable | re-home off `TierConfig` (DROPPED in P4.0) → outlet/program or wallet config | keep config, move home |
| Points → INR conversion | Gifts-only vs gifts+INR | — | tenant flag |
| Credit parameters (`CreditField`) | Headers; `isSeparatePayout`; per-outlet-type award | REL | keep; enforce clubbing (Gap #7) |

## F · Programs / Activations
| Setting | Controls | Home | Target |
|---|---|---|---|
| Visibility capture mode | App photo-capture vs admin upload | — | tenant flag (Gap #17) |
| Loyalty vs Activation audience | Top/KYC ongoing vs all/time-bound | partial | formalize |

## G · Partner app surface (`features.partnerApp`)
| Setting | Controls | Home | Target |
|---|---|---|---|
| `showSchemes` / `showInvoices` / `showWallet` / `showTeam` / `showLeaderboard` | Partner-app sections | FLAG/CODE | DB |

## H · Branding & Notifications
| Setting | Controls | Home | Target |
|---|---|---|---|
| Display name, colors, logo, favicon, product brands | Tenant branding | CODE | DB + asset store |
| Support email/phone | Partner support contacts | CODE | DB |
| MSG91 keys, sender IDs, template IDs | Messaging | CODE/env | Secret Manager + DB |
