# Phase 3 — §06 Per-Tenant Configurability Matrix

Every knob that varies by tenant. **Current home** legend: `CODE` = `CLIENT_REGISTRY`
(`lib/platform/`); `BLOB` = `ProgramSetting` JSON; `REL` = relational table; `FLAG` =
`ClientConfig.features`; `—` = not built. Target is the intended management surface.

> **Meta-gap (→ Gap #22, High):** the bulk of tenant config lives in **`CODE`** — onboarding a
> tenant or changing a flag is a **code change + redeploy**, not an admin action. Target: a DB-
> backed `Client` config managed by Gifsy/Client Admin. (Ties to Gaps #2, #18.)

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
