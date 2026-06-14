const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, HeadingLevel, BorderStyle, WidthType,
  ShadingType, VerticalAlign, PageNumber, PageBreak, TabStopType,
  TabStopPosition, TableOfContents, LevelFormat
} = require('docx');
const fs = require('fs');

// ─── Colors ───────────────────────────────────────────────────────────────────
const HEADER_FILL = "D5E8F0";
const ALT_ROW_FILL = "F5F5F5";
const WHITE = "FFFFFF";
const NAVY = "1A1A2E";
const DARK_NAVY = "16213E";

// ─── Border helper ────────────────────────────────────────────────────────────
const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };
const noBorder = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const noBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };

// ─── Text helpers ─────────────────────────────────────────────────────────────
function t(text, opts = {}) {
  return new TextRun({ text: String(text), font: "Arial", ...opts });
}
function code(text) {
  return new TextRun({ text: String(text), font: "Courier New", bold: true, size: 18 });
}
function para(children, opts = {}) {
  if (typeof children === 'string') children = [t(children)];
  return new Paragraph({ children, spacing: { after: 80 }, ...opts });
}
function h1(text, pageBreak = true) {
  const children = pageBreak
    ? [new PageBreak(), t(text, { bold: true, size: 36, color: NAVY })]
    : [t(text, { bold: true, size: 36, color: NAVY })];
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children,
    spacing: { before: 360, after: 200 },
  });
}
function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    children: [t(text, { bold: true, size: 28, color: DARK_NAVY })],
    spacing: { before: 240, after: 120 },
  });
}
function h3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    children: [t(text, { bold: true, size: 24, color: DARK_NAVY })],
    spacing: { before: 160, after: 80 },
  });
}
function bullet(children, level = 0) {
  if (typeof children === 'string') children = [t(children)];
  return new Paragraph({
    numbering: { reference: "bullets", level },
    children,
    spacing: { after: 60 },
  });
}
function numbered(children, level = 0) {
  if (typeof children === 'string') children = [t(children)];
  return new Paragraph({
    numbering: { reference: "numbers", level },
    children,
    spacing: { after: 60 },
  });
}
function emptyPara() {
  return new Paragraph({ children: [t("")], spacing: { after: 80 } });
}

// ─── Table helpers ────────────────────────────────────────────────────────────
const TABLE_WIDTH = 9360; // US Letter with 1" margins

function cell(children, fill, widthDxa, opts = {}) {
  if (typeof children === 'string') children = [para([t(children, { size: 18 })], { spacing: { after: 0 } })];
  else if (!Array.isArray(children)) children = [children];
  return new TableCell({
    borders,
    width: { size: widthDxa, type: WidthType.DXA },
    shading: fill ? { fill, type: ShadingType.CLEAR } : undefined,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    verticalAlign: VerticalAlign.TOP,
    children,
    ...opts,
  });
}
function headerCell(text, widthDxa) {
  return cell(
    [para([t(text, { bold: true, size: 18, color: "000000" })], { spacing: { after: 0 } })],
    HEADER_FILL, widthDxa
  );
}
function makeTable(headers, rows, columnWidths) {
  const total = columnWidths.reduce((a, b) => a + b, 0);
  return new Table({
    width: { size: total, type: WidthType.DXA },
    columnWidths,
    rows: [
      new TableRow({
        tableHeader: true,
        children: headers.map((h, i) => headerCell(h, columnWidths[i])),
      }),
      ...rows.map((row, ri) =>
        new TableRow({
          children: row.map((cellContent, ci) => {
            const fill = ri % 2 === 0 ? ALT_ROW_FILL : WHITE;
            if (Array.isArray(cellContent) && cellContent[0] instanceof Paragraph) {
              return cell(cellContent, fill, columnWidths[ci]);
            }
            return cell(cellContent, fill, columnWidths[ci]);
          }),
        })
      ),
    ],
  });
}

// ─── Code-block paragraph ─────────────────────────────────────────────────────
function codeBlock(lines) {
  return lines.map(line =>
    new Paragraph({
      children: [new TextRun({ text: line, font: "Courier New", size: 18, color: "333333" })],
      spacing: { after: 0 },
      indent: { left: 360 },
    })
  );
}

// ─── Mixed inline helpers ─────────────────────────────────────────────────────
function mixedPara(parts) {
  // parts: array of { text, code, bold } objects or strings
  const runs = parts.map(p => {
    if (typeof p === 'string') return t(p);
    if (p.code) return code(p.code);
    return t(p.text || '', { bold: p.bold });
  });
  return para(runs);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION BUILDERS
// ═══════════════════════════════════════════════════════════════════════════════

function buildTitlePage() {
  return [
    emptyPara(), emptyPara(), emptyPara(),
    new Paragraph({
      children: [t("LoyaltyBase Platform", { bold: true, size: 72, color: NAVY })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 160 },
    }),
    new Paragraph({
      children: [t("Developer Codebase Guide", { bold: true, size: 48, color: DARK_NAVY })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 160 },
    }),
    new Paragraph({
      children: [t("Confidential — Internal Use Only", { size: 24, color: "666666", italics: true })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
    }),
    new Paragraph({
      children: [t("Generated: June 2025", { size: 24, color: "666666" })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
    }),
    emptyPara(), emptyPara(),
  ];
}

function buildTOC() {
  return [
    new Paragraph({ children: [new PageBreak()] }),
    new TableOfContents("Table of Contents", {
      hyperlink: true,
      headingStyleRange: "1-3",
    }),
  ];
}

// ─── SECTION 1 ────────────────────────────────────────────────────────────────
function buildSection1() {
  return [
    h1("Section 1 — Platform Overview"),
    h2("What is LoyaltyBase?"),
    para([
      t("LoyaltyBase is a "), t("multi-tenant B2B loyalty platform SaaS", { bold: true }),
      t(". The platform operator is "), code("Gifsy"), t(" (running as "), code("GIFSY_ADMIN"), t("). Each "),
      t("client", { italics: true }), t(" (e.g., "), t("Deoleo India", { bold: true }),
      t(") runs their own branded loyalty program for their trade partners — retailers, wholesalers, and sub-stockists."),
    ]),
    para([
      t("The primary use case: a B2B manufacturer (client) incentivises their trade channel to buy and sell more of their products. Partners earn points or cashback, redeem gifts, and track their performance — all within a white-labeled portal themed for that client."),
    ]),
    emptyPara(),
    h2("Three Portals, Four User Types"),
    makeTable(
      ["Portal Prefix", "User Type", "Description"],
      [
        ["/partner/*", "Trade Partners (Retailers, Wholesalers, Sub-stockists)", "Track points, wallet, schemes, and visibility submissions"],
        ["/admin/*", "Client Admin (e.g., Deoleo's internal team)", "Manage schemes, KYC approvals, payouts, banners, reports"],
        ["/sales/*", "Sales Field Team (ISR, SO, ASM, State Head)", "Onboard partners, submit KYC, manage outlets, track territory"],
        ["/gifsy/*", "Platform Super-Admin (Gifsy team only)", "Manage all clients, feature flags, platform configuration"],
      ],
      [2000, 3000, 4360]
    ),
    emptyPara(),
    h2("Tech Stack"),
    makeTable(
      ["Technology", "Version / Details", "Purpose"],
      [
        ["Next.js", "16.2.6 — App Router + Turbopack", "Full-stack framework; all pages and API routes"],
        ["TypeScript", "Latest", "Type safety across the entire codebase"],
        ["Tailwind CSS", "Latest", "Utility-first styling; brand color via --brand-primary CSS var"],
        ["Prisma ORM", "Latest", "Database access layer with PostgreSQL"],
        ["PostgreSQL", "Latest", "Primary relational database"],
        ["JWT (jose)", "Latest", "Authentication tokens; verified in proxy.ts"],
        ["MSG91", "India SMS OTP provider", "OTP delivery for login; auth key is server-side only"],
        ["AWS S3", "ap-south-1", "File storage for KYC documents, visibility photos, invoices"],
        ["Zod", "Latest", "Schema validation for all API request bodies"],
        ["Vitest", "Latest", "Unit and component testing framework"],
      ],
      [2000, 3000, 4360]
    ),
    emptyPara(),
    h2("Key Architectural Rules"),
    para([t("Every developer must understand these five non-negotiable rules:")]),
    numbered([
      t("Multi-tenancy: "), code("x-tenant-slug"),
      t(" header is set by the proxy on every request. All DB queries MUST be scoped by "), code("clientId"), t("."),
    ]),
    numbered([
      t("Feature flags: set by GIFSY_ADMIN only. "), code("CLIENT_ADMIN"),
      t(" cannot change feature flags. Always use "), code("applyFeatureFlagUpdate()"), t(" with role check."),
    ]),
    numbered([
      t("194C TDS: calculated internally only. "), t("Never shown in partner-facing UI or on invoices", { bold: true }),
      t(". Partner invoices display gross amount only."),
    ]),
    numbered([
      t("Seller on all invoices: "), code("Tech Gifsy Solutions Limited"),
      t(" — fixed, not configurable by any client."),
    ]),
    numbered([
      t("MSG91 auth key: server-side env var only. "), t("Never sent to the browser", { bold: true }),
      t(" or included in ClientConfig API responses."),
    ]),
    emptyPara(),
  ];
}

// ─── SECTION 2 ────────────────────────────────────────────────────────────────
function buildSection2() {
  return [
    h1("Section 2 — Project Root Files"),
    para([t("Files in the project root ("), code("C:\\...\\platform\\"), t(") that configure the application at a global level:")]),
    emptyPara(),
    makeTable(
      ["File", "Purpose", "When to Change"],
      [
        [
          [para([code("src/proxy.ts")], { spacing: { after: 0 } })],
          "Edge proxy: tenant resolution from hostname, JWT auth verification, role-based route protection, and DEMO_MODE injection. This is the ONLY middleware file — middleware.ts was intentionally removed.",
          "Add new protected route prefixes to ROLE_ROUTES inside this file. Change DEMO_MODE demo user injection. Modify JWT verification logic.",
        ],
        [
          [para([code("prisma/schema.prisma")], { spacing: { after: 0 } })],
          "Complete database schema. Every root model has clientId String @default(\"deoleo\") for multi-tenancy. Defines all models, relations, and indexes.",
          "Adding a new model: include clientId field + @@index([clientId]). Modify when adding new DB entities or relationships.",
        ],
        [
          [para([code(".env")], { spacing: { after: 0 } })],
          "Environment variables: DATABASE_URL, JWT_SECRET, MSG91 credentials, S3 credentials, DEMO_MODE flag.",
          "Add new env vars for new integrations. Never commit to git.",
        ],
        [
          [para([code("next.config.ts")], { spacing: { after: 0 } })],
          "Next.js configuration: build settings, image domains, environment variable exposure.",
          "Adding new allowed image domains, adjusting build config, enabling new Next.js features.",
        ],
        [
          [para([code("tailwind.config.ts")], { spacing: { after: 0 } })],
          "Tailwind CSS configuration with CSS custom property --brand-primary for per-client theming.",
          "Adding new design tokens, configuring content paths, adding Tailwind plugins.",
        ],
        [
          [para([code("vitest.config.ts")], { spacing: { after: 0 } })],
          "Test runner configuration: test file patterns, setup files, environment settings.",
          "Adding new test directories or changing test environment settings.",
        ],
        [
          [para([code("prisma.config.ts")], { spacing: { after: 0 } })],
          "Prisma configuration file for migrations and client generation settings.",
          "Changing migration output path or generator settings.",
        ],
      ],
      [2200, 4000, 3160]
    ),
    emptyPara(),
  ];
}

// ─── SECTION 3 ────────────────────────────────────────────────────────────────
function buildSection3() {
  const rows = [];

  function libEntry(file, purpose, keyExports, whenToEdit) {
    return [
      [para([code(file)], { spacing: { after: 0 } })],
      purpose,
      keyExports,
      whenToEdit,
    ];
  }

  return [
    h1("Section 3 — src/lib — Core Business Logic"),
    para([t("All shared business logic lives in "), code("src/lib/"), t(". These modules are imported by API routes, server components, and (for client-side hooks) by React components. Never put business logic in page files — always extract to lib.")]),
    emptyPara(),

    h2("src/lib/tenant.ts"),
    makeTable(
      ["Attribute", "Detail"],
      [
        ["Purpose", "Tenant resolution from incoming request headers"],
        [para([code("DEFAULT_CLIENT_ID")], { spacing: { after: 0 } }), [para([t("Value: "), code("'deoleo'"), t(" — fallback used when x-tenant-slug is missing (localhost / dev environment)")])," "].filter(Boolean).slice(0,1)],
        [para([code("getClientIdFromRequest(req)")], { spacing: { after: 0 } }), "Reads x-tenant-slug header, lowercases and trims the value. Used in EVERY API route handler immediately after auth check."],
        ["When to edit", "Changing tenant resolution logic, adding new header sources, or modifying the default fallback."],
      ],
      [2800, 6560]
    ),
    emptyPara(),

    h2("src/lib/auth.ts"),
    makeTable(
      ["Attribute", "Detail"],
      [
        ["Purpose", "Extract authenticated user from proxy-injected request headers"],
        [para([code("getAuthUser(req)")], { spacing: { after: 0 } }), "Reads x-user-id, x-user-role, x-partner-id headers (set by proxy.ts after JWT verification). Returns { userId, role, partnerId } or null if headers are missing."],
        ["When to edit", "Adding new fields to the auth token/headers, changing how user context is extracted."],
      ],
      [2800, 6560]
    ),
    emptyPara(),

    h2("src/lib/prisma.ts"),
    makeTable(
      ["Attribute", "Detail"],
      [
        ["Purpose", "Singleton Prisma client to prevent connection pool exhaustion in Next.js hot-reload dev mode"],
        ["Export", "Default export: prisma (PrismaClient instance)"],
        ["When to edit", "Adding Prisma middleware for logging, soft-delete, or audit trails. Adding query events."],
      ],
      [2800, 6560]
    ),
    emptyPara(),

    h2("src/lib/platform/ — Platform Sub-Directory"),
    para([t("The "), code("platform/"), t(" subdirectory contains all multi-tenancy and client configuration logic. These are the most critical files in the codebase.")]),
    emptyPara(),

    h3("client-config.ts"),
    makeTable(
      ["Export", "Description"],
      [
        [para([code("ClientConfig")], { spacing: { after: 0 } }), "TypeScript type — the single source of truth for per-client configuration. Contains branding, featureFlags, and operational settings."],
        [para([code("FeatureFlags")], { spacing: { after: 0 } }), "Interface defining all 9+ boolean feature flags plus partnerApp visibility flags. Each flag controls whether a feature is available for a given client."],
        [para([code("applyFeatureFlagUpdate(config, key, value, callerRole)")], { spacing: { after: 0 } }), "CRITICAL: Throws an error if callerRole !== 'GIFSY_ADMIN'. Use this for ALL feature flag mutations — never update flags directly."],
        [para([code("isFeatureEnabled(config, key)")], { spacing: { after: 0 } }), "Safe feature flag check with null-safe access. Returns boolean."],
        ["When to edit", "Adding a new feature flag: add to FeatureFlags interface + set default value in CLIENT_REGISTRY default config."],
      ],
      [3000, 6360]
    ),
    emptyPara(),

    h3("client-registry.ts"),
    makeTable(
      ["Export", "Description"],
      [
        [para([code("CLIENT_REGISTRY")], { spacing: { after: 0 } }), "In-memory map of all active clients. Key = slug (e.g. 'deoleo'). Each entry is a full ClientConfig. Dev/demo uses this directly; production Phase 3 will replace with DB lookup."],
        ["When to edit", "Adding a new demo/dev client, changing Deoleo's default feature flags or branding, adding new clients for staging."],
      ],
      [3000, 6360]
    ),
    emptyPara(),

    h3("tenant-resolution.ts"),
    makeTable(
      ["Export", "Description"],
      [
        [para([code("resolveSlugFromHostname(hostname)")], { spacing: { after: 0 } }), "Maps deoleo.loyaltybase.in → 'deoleo', localhost → 'deoleo'. Handles subdomain extraction for all configured clients."],
        [para([code("resolveClientConfig(slug)")], { spacing: { after: 0 } }), "Looks up CLIENT_REGISTRY by slug. Returns ClientConfig or throws if slug not found."],
        ["When to edit", "Adding a new domain mapping, adding a new subdomain pattern, or onboarding a new client with a custom domain."],
      ],
      [3000, 6360]
    ),
    emptyPara(),

    h3("client-config-context.tsx"),
    makeTable(
      ["Export", "Description"],
      [
        [para([code("ClientConfigProvider")], { spacing: { after: 0 } }), "React context provider. Wraps all portals in the root layout (src/app/layout.tsx). Provides client config to all client components."],
        [para([code("useClientConfig()")], { spacing: { after: 0 } }), "Hook to access full client config, branding, and feature flags in any client component. Use this in portal layouts and feature-gated UI."],
        [para([code("useFeatureFlag(key)")], { spacing: { after: 0 } }), "Returns boolean for a specific feature flag. Preferred over useClientConfig() when only checking one flag."],
        ["When to edit", "Adding new config fields that need to be accessible in React components, or adding new hooks."],
      ],
      [3000, 6360]
    ),
    emptyPara(),

    h3("platform-admin.ts"),
    makeTable(
      ["Export", "Description"],
      [
        [para([code("buildClientSummary(config)")], { spacing: { after: 0 } }), "Aggregates client statistics for the GIFSY overview dashboard — active features count, branding status, etc."],
        [para([code("validateNewClientSlug(slug, registry)")], { spacing: { after: 0 } }), "Validates slug uniqueness and format when creating a new client in the GIFSY wizard."],
        ["When to edit", "Adding new summary fields to the GIFSY overview, or changing slug validation rules."],
      ],
      [3000, 6360]
    ),
    emptyPara(),

    h3("server.ts"),
    makeTable(
      ["Export", "Description"],
      [
        [para([code("getClientConfigFromRequest(req)")], { spacing: { after: 0 } }), "Server-side client config lookup. Reads x-tenant-slug header and returns full ClientConfig. Use this in Server Components and API routes. Do NOT use useClientConfig() on the server."],
        ["When to edit", "Needing to add more fields from ClientConfig in server context, or changing server-side config resolution."],
      ],
      [3000, 6360]
    ),
    emptyPara(),

    h2("Other src/lib Files"),
    makeTable(
      ["File", "Purpose", "Key Note / When to Edit"],
      [
        [para([code("kyc-approval.ts")], { spacing: { after: 0 } }), "KYC multi-level approval state machine. initialKycStatus(role, rolePhones) determines first approval level. nextKycStatus(current, action) handles transitions: SUBMITTED → PENDING_SO → PENDING_ASM → PENDING_GIFSY → APPROVED.", "Edit when changing the KYC approval chain or adding new approval levels."],
        [para([code("sales-role.ts")], { spacing: { after: 0 } }), "ROLE_PHONES static map (sales role → demo phone), getSalesRoleLabel(role) for display names.", "Edit when changing sales hierarchy structure."],
        [para([code("msg91.ts")], { spacing: { after: 0 } }), "sendOtp(phone, otp) — sends OTP via MSG91 API using server-side MSG91_AUTH_KEY env var. Auth key is NEVER returned to the browser.", "Edit when switching SMS provider or adding notification templates. Per-client MSG91 key = Phase 3."],
        [para([code("partner-session.ts")], { spacing: { after: 0 } }), "usePartnerSession() hook returns current partner session data (firmName, partnerName, tier, outletType, track: POINTS | INR). Also contains OUTLET_TYPE_LABELS, OUTLET_TYPE_COLORS, and setDemoOutletType() for dev.", "Edit when adding new session fields or outlet types."],
        [para([code("schemes.ts")], { spacing: { after: 0 } }), "Scheme eligibility rules and enrollment logic — which partners qualify for which schemes.", "Edit when changing scheme eligibility criteria or enrollment rules."],
        [para([code("wallet.ts")], { spacing: { after: 0 } }), "Wallet balance calculation, points-to-INR conversion, and holding period logic.", "Edit when changing conversion rates, holding periods, or balance calculation rules."],
        [para([code("tds.ts")], { spacing: { after: 0 } }), "194C TDS calculation logic. INTERNAL ONLY — never expose these values in API responses returned to partners or sales users.", "Edit only for tax rate changes. NEVER add TDS fields to partner-facing responses."],
        [para([code("invoice.ts")], { spacing: { after: 0 } }), "Invoice generation logic. Seller is always 'Tech Gifsy Solutions Limited' — hardcoded.", "Edit for invoice format changes. Never make seller name configurable."],
        [para([code("incentive.ts")], { spacing: { after: 0 } }), "Points and cashback incentive calculation engine for scheme payouts.", "Edit when changing incentive calculation formulas."],
        [para([code("campaign.ts")], { spacing: { after: 0 } }), "Campaign eligibility checking and enrollment form logic.", "Edit when adding new campaign types or eligibility rules."],
        [para([code("notifications.ts")], { spacing: { after: 0 } }), "Notification dispatch — SMS via MSG91 and in-app notifications.", "Edit when adding new notification types or channels."],
        [para([code("bulk-upload-validator.ts")], { spacing: { after: 0 } }), "Excel bulk-upload parsing and validation for outlets and partners. Row-level error collection.", "Edit when changing expected Excel column formats or adding new validation rules."],
        [para([code("s3.ts")], { spacing: { after: 0 } }), "S3 file upload helpers: uploadFile(buffer, key, contentType) and generateKey(prefix, filename).", "Edit when adding new S3 buckets or changing upload logic."],
        [para([code("visibility.ts")], { spacing: { after: 0 } }), "Visibility submission fraud detection helpers — duplicate GPS, time-based fraud signals.", "Edit when adding new fraud detection heuristics."],
        [para([code("gifts.ts")], { spacing: { after: 0 } }), "Reward catalog logic and gift redemption rules.", "Edit when changing redemption rules or catalog management logic."],
        [para([code("redemption-store.ts")], { spacing: { after: 0 } }), "In-memory redemption state store (Phase 1). Phase 2 will replace with DB-backed persistence.", "Replace with DB implementation in Phase 2."],
        [para([code("targets.ts")], { spacing: { after: 0 } }), "Target/KPI calculation and achievement tracking for partners and sales team.", "Edit when changing target calculation formulas."],
        [para([code("tickets.ts")], { spacing: { after: 0 } }), "Support ticket status transition logic and escalation rules.", "Edit when changing ticket workflow states."],
        [para([code("utils.ts")], { spacing: { after: 0 } }), "Shared utilities: formatCurrency(amount, currency), formatDate(date), cn(...classes) class name merger.", "Add new utility functions that are reused across 3+ files."],
        [para([code("banner.ts")], { spacing: { after: 0 } }), "Banner scheduling and audience targeting logic.", "Edit when adding new banner targeting criteria."],
        [para([code("gifsy-settings.ts")], { spacing: { after: 0 } }), "Platform-level settings accessible to GIFSY_ADMIN only.", "Edit when adding new platform-wide configuration options."],
        [para([code("task-config.ts")], { spacing: { after: 0 } }), "Sales task configuration and daily task definitions.", "Edit when adding new task types for the sales team."],
      ],
      [2400, 3800, 3160]
    ),
    emptyPara(),
  ];
}

// ─── SECTION 4 ────────────────────────────────────────────────────────────────
function buildSection4() {
  return [
    h1("Section 4 — src/proxy.ts — Request Lifecycle"),
    para([t("Every single request to LoyaltyBase goes through "), code("src/proxy.ts"), t(" before reaching any page or API route. This is the ONLY middleware — "), code("middleware.ts"), t(" was intentionally removed and replaced with this custom edge proxy.")]),
    emptyPara(),
    h2("Step 1: Tenant Resolution"),
    numbered([t("Reads "), code("req.nextUrl.hostname"), t(" from the incoming request.")]),
    numbered([t("Calls "), code("resolveSlugFromHostname(hostname)"), t(" → returns client slug (e.g. "), code("'deoleo'"), t(")")]),
    numbered([t("Calls "), code("resolveClientConfig(slug)"), t(" → returns full "), code("ClientConfig"), t(" from "), code("CLIENT_REGISTRY"), t(".")]),
    numbered([t("Sets response headers: "), code("x-tenant-slug"), t(", "), code("x-tenant-valid"), t(", "), code("x-tenant-color"), t(", "), code("x-tenant-name"), t(".")]),
    numbered([t("These headers are then read by "), code("getClientIdFromRequest(req)"), t(" in every API route and "), code("getClientConfigFromRequest(req)"), t(" in server components.")]),
    emptyPara(),
    h2("Step 2: Authentication"),
    numbered([t("Checks if the path matches the public paths list (e.g., "), code("/api/auth/*"), t(", "), code("/auth/*"), t("). If public → passes through without JWT check.")]),
    numbered([t("If "), code("DEMO_MODE=true"), t(" in environment: injects demo user headers ("), code("x-user-id"), t(", "), code("x-user-role"), t(", "), code("x-partner-id"), t(") directly, bypassing JWT. "), t("Never use DEMO_MODE in production.", { bold: true })]),
    numbered([t("Reads "), code("Authorization: Bearer <token>"), t(" header.")]),
    numbered([t("Verifies JWT using "), code("jose"), t(" with "), code("JWT_SECRET"), t(" from environment.")]),
    numbered([t("Extracts "), code("userId"), t(", "), code("role"), t(", "), code("partnerId"), t(" from JWT payload.")]),
    numbered([t("Checks "), code("ROLE_ROUTES"), t(" map — if the request path starts with a role-gated prefix, verifies the user's role matches. Returns 403 if not authorized.")]),
    numbered([t("Sets "), code("x-user-id"), t(", "), code("x-user-role"), t(", "), code("x-partner-id"), t(" headers for downstream consumption.")]),
    emptyPara(),
    h2("How to Add a New Protected Route"),
    makeTable(
      ["Step", "Action"],
      [
        ["1", [para([t("Open "), code("src/proxy.ts"), t(" and find the "), code("ROLE_ROUTES"), t(" constant.")])]],
        ["2", [para([t("Add an entry: "), code("{ prefix: '/your-path', roles: ['ROLE_A', 'ROLE_B'] }"), t(" where roles is the array of roles that may access this prefix.")])]],
        ["3", [para([t("If multiple roles share a prefix, list all allowed roles in the array. The proxy checks that the user's role is "), t("in", { italics: true }), t(" the allowed list.")])]],
        ["4", [para([t("For public routes that need no auth: add the path to the "), code("PUBLIC_PATHS"), t(" array instead.")])]],
        ["5", [para([t("Test by hitting the route with a JWT of each role — verify 200 for allowed roles and 403 for disallowed roles.")])]],
      ],
      [800, 8560]
    ),
    emptyPara(),
  ];
}

// ─── SECTION 5 ────────────────────────────────────────────────────────────────
function buildSection5() {
  return [
    h1("Section 5 — Portal Layouts (src/app/*/layout.tsx)"),
    para([t("Each portal has a layout file that wraps all pages within that portal. Layouts handle navigation, authentication context, and feature flag gating of nav items.")]),
    emptyPara(),
    makeTable(
      ["Layout File", "Portal", "What It Does", "Feature Flag Gates"],
      [
        [
          para([code("src/app/layout.tsx")], { spacing: { after: 0 } }),
          "Root (all portals)",
          "Wraps the entire application in ClientConfigProvider. Loads --brand-primary CSS variable from client branding config. This is the entry point for React context.",
          "None — always renders",
        ],
        [
          para([code("src/app/admin/layout.tsx")], { spacing: { after: 0 } }),
          "Admin Portal",
          "Renders admin sidebar navigation. Nav items filtered by feature flags via useMemo. Dynamic client name from clientConfig.branding.displayName.",
          "KYC Management (kycApprovalFlow), Visibility Invoices (visibilityInvoiceModule), Payout Management + Gift Catalogue (walletModule)",
        ],
        [
          para([code("src/app/partner/layout.tsx")], { spacing: { after: 0 } }),
          "Partner Portal",
          "Mobile-first layout with bottom navigation bar and sidebar. Wallet and Redeem tabs gated by feature flags. DemoSwitcher visible in dev mode.",
          "Wallet tab (walletModule), Redeem tab (walletModule + POINTS track)",
        ],
        [
          para([code("src/app/sales/layout.tsx")], { spacing: { after: 0 } }),
          "Sales Portal",
          "Sales team layout with role-aware navigation. ISR sees different nav items than ASM or State Head. Hierarchy-based access control.",
          "Role-based items (no single feature flag gate — uses user role)",
        ],
        [
          para([code("src/app/gifsy/layout.tsx")], { spacing: { after: 0 } }),
          "GIFSY Super-Admin",
          "Dark sidebar layout. Static nav: Overview, Clients, Platform Users, Settings. Only accessible with GIFSY_ADMIN role.",
          "None — role-gated at proxy level",
        ],
        [
          para([code("src/app/auth/layout.tsx")], { spacing: { after: 0 } }),
          "Authentication",
          "Minimal unauthenticated layout for the login screen. No navigation, no sidebar.",
          "None — public route",
        ],
      ],
      [2200, 1400, 3400, 2360]
    ),
    emptyPara(),
  ];
}

// ─── SECTION 6 ────────────────────────────────────────────────────────────────
function buildSection6() {
  return [
    h1("Section 6 — Admin Portal Pages (src/app/admin/*)"),
    para([t("The admin portal is used by the client's internal team (e.g., Deoleo's marketing/ops team) to manage the loyalty program. Many pages are feature-flag-gated.")]),
    emptyPara(),
    makeTable(
      ["Route", "Page File", "Purpose", "API Called", "Feature Flag"],
      [
        ["/admin/dashboard", "dashboard/page.tsx", "KPI overview, alerts, key metrics for the program", "—", "—"],
        ["/admin/dashboards/kyc", "dashboards/kyc/page.tsx", "KYC funnel visualization and SLA tracking", "/api/kyc/sla-metrics", "kycApprovalFlow"],
        ["/admin/dashboards/payments", "dashboards/payments/page.tsx", "Payout volume, status distribution, trend charts", "/api/payouts/*", "walletModule"],
        ["/admin/dashboards/redemptions", "dashboards/redemptions/page.tsx", "Gift redemption tracking and catalog analytics", "/api/rewards/*", "walletModule"],
        ["/admin/dashboards/engagement", "dashboards/engagement/page.tsx", "Partner engagement metrics and activity heatmaps", "/api/reports/engagement", "—"],
        ["/admin/kyc", "kyc/page.tsx", "Full list of KYC submissions with status filters", "/api/kyc", "kycApprovalFlow"],
        ["/admin/kyc/[id]", "kyc/[id]/page.tsx", "KYC submission detail with approve/reject actions", "/api/kyc/[id]/*", "kycApprovalFlow"],
        ["/admin/approvals", "approvals/page.tsx", "Pending approvals queue — items needing action", "/api/kyc", "kycApprovalFlow"],
        ["/admin/outlets", "outlets/page.tsx", "Outlet master list with search and bulk operations", "/api/admin/channel-partners", "—"],
        ["/admin/users", "users/page.tsx", "User management — create, edit, deactivate users", "/api/admin/users", "—"],
        ["/admin/schemes", "schemes/page.tsx", "Scheme list and creation via scheme builder wizard", "/api/schemes", "—"],
        ["/admin/schemes/[id]", "schemes/[id]/page.tsx", "Scheme detail page with edit and status controls", "/api/schemes/[id]", "—"],
        ["/admin/schemes/[id]/enrollments", "enrollments/page.tsx", "List of partners enrolled in a specific scheme", "/api/admin/schemes/[id]/enrollments", "—"],
        ["/admin/visibility", "visibility/page.tsx", "Visibility photo submission approval queue", "/api/visibility/submissions", "—"],
        ["/admin/invoices", "invoices/page.tsx", "Visibility invoice list for all partners", "/api/sales/invoices", "visibilityInvoiceModule"],
        ["/admin/invoices/upload", "invoices/upload/page.tsx", "Upload invoice payouts CSV for bulk processing", "/api/admin/bulk-upload/*", "visibilityInvoiceModule"],
        ["/admin/payouts", "payouts/page.tsx", "Payout batch management — create, review, process", "/api/payouts/batches", "walletModule"],
        ["/admin/payouts/fund", "payouts/fund/page.tsx", "Fund account balance and receipt management", "/api/payouts/fund", "walletModule"],
        ["/admin/gifts", "gifts/page.tsx", "Gift reward catalogue admin — add/edit/remove items", "/api/rewards/catalog", "walletModule"],
        ["/admin/targets", "targets/page.tsx", "Partner target configuration and assignment", "/api/schemes/targets", "—"],
        ["/admin/tickets", "tickets/page.tsx", "Support ticket queue with priority and status filters", "/api/tickets", "—"],
        ["/admin/banners", "banners/page.tsx", "Banner creation and scheduling management", "/api/admin/banners", "—"],
        ["/admin/reports", "reports/page.tsx", "All reports: billing trends, TDS, scheme performance, visibility, payout liability", "/api/reports/*", "—"],
        ["/admin/settings", "settings/page.tsx", "Admin portal settings — program configuration", "/api/admin/settings", "—"],
      ],
      [1800, 2000, 2400, 1700, 1460]
    ),
    emptyPara(),
  ];
}

// ─── SECTION 7 ────────────────────────────────────────────────────────────────
function buildSection7() {
  return [
    h1("Section 7 — Partner Portal Pages (src/app/partner/*)"),
    para([t("The partner portal is a mobile-first interface for trade partners (retailers, wholesalers, sub-stockists) to interact with the loyalty program.")]),
    emptyPara(),
    makeTable(
      ["Route", "Purpose", "Feature Flag"],
      [
        ["/partner/dashboard", "Main dashboard: volume metrics, target progress, new scheme alerts", "—"],
        ["/partner/wallet", "Wallet balance display, transaction history, payout request initiation", "walletModule"],
        ["/partner/targets", "KPI targets and achievement progress against current period goals", "—"],
        ["/partner/schemes", "Active schemes list and enrollment for eligible schemes", "—"],
        ["/partner/rewards", "Gift catalog browser and redemption initiation (POINTS track only)", "walletModule + POINTS track"],
        ["/partner/rewards/orders", "Past gift redemption orders and delivery status tracking", "walletModule + POINTS track"],
        ["/partner/invoices", "Visibility invoices list — gross amounts only", "visibilityInvoiceModule"],
        ["/partner/invoices/[id]", "Invoice detail page — displays gross amount only. 194C TDS is NEVER shown here.", "visibilityInvoiceModule"],
        ["/partner/visibility", "Visibility photo submission — upload store display photos with GPS", "—"],
        ["/partner/payouts", "Payout history and status tracking (INR track partners only)", "walletModule"],
        ["/partner/leaderboard", "Partner ranking among peers in the same tier/region", "—"],
        ["/partner/support", "Raise new support tickets and view existing ticket status", "—"],
        ["/partner/profile", "Account settings, KYC status view, contact information update", "—"],
      ],
      [2200, 5000, 2160]
    ),
    emptyPara(),
    para([t("Important: Partner portal always shows "), t("gross amounts only", { bold: true }), t(" — 194C TDS is calculated server-side and stored internally, but never rendered in any partner-facing page or API response.")]),
    emptyPara(),
  ];
}

// ─── SECTION 8 ────────────────────────────────────────────────────────────────
function buildSection8() {
  return [
    h1("Section 8 — Sales Portal Pages (src/app/sales/*)"),
    para([t("The sales portal is used by the field sales team (ISR, SO, ASM, State Head) to onboard partners, approve KYC, manage their territory, and track their own incentives.")]),
    emptyPara(),
    makeTable(
      ["Route", "Purpose"],
      [
        ["/sales/dashboard", "Sales dashboard: territory volume metrics, KPI scorecard, achievement chart vs target"],
        ["/sales/kyc", "KYC submissions list — filtered to submissions this sales user initiated or can approve"],
        ["/sales/kyc/new", "New KYC form — 4-step wizard: Outlet Info → Partner Details → Address → Bank + Signature"],
        ["/sales/kyc/[id]", "KYC submission detail view for a specific partner"],
        ["/sales/kyc/[id]/edit", "Edit a draft KYC submission before final submission"],
        ["/sales/kyc/[id]/ledger", "Full KYC approval audit trail — who approved/rejected at each level and when"],
        ["/sales/outlets", "Outlet list in this sales user's territory with search and filter"],
        ["/sales/team", "Team members list — visible to ASM and above, shows their direct reports"],
        ["/sales/team/[memberId]", "Individual team member detail, performance metrics, KYC stats"],
        ["/sales/team/[memberId]/outlets", "Outlets managed by a specific team member"],
        ["/sales/catalogue", "Product catalogue (SKUs) for this client — used during partner visits"],
        ["/sales/leaderboard", "Sales team leaderboard — ranking among peers in the same role level"],
        ["/sales/visibility", "Visibility submission page — log store display compliance"],
        ["/sales/wallet", "Sales incentive wallet — own earnings and payout history"],
        ["/sales/tasks", "Daily tasks list — configured via task-config.ts"],
        ["/sales/profile", "Profile settings and account information"],
      ],
      [2400, 7000]
    ),
    emptyPara(),
    h2("KYC Form — 4-Step Flow"),
    para([t("The "), code("/sales/kyc/new"), t(" page uses a multi-step wizard managed by "), code("kyc-form.tsx"), t(". Steps:")]),
    numbered([t("Outlet Info: outlet name, type (RETAILER / WHOLESALER / SUB_STOCKIST / MT), beat/route")]),
    numbered([t("Partner Details: owner name, phone, email, GST number, PAN")]),
    numbered([t("Address: full address with pin code and state selection")]),
    numbered([t("Bank + Signature: bank account, IFSC, cancelled cheque upload, digital signature pad")]),
    para([t("After submission: OTP is sent to the partner's phone for verification before the KYC enters the approval chain. OTP flow happens post-submission, not inline.")]),
    emptyPara(),
  ];
}

// ─── SECTION 9 ────────────────────────────────────────────────────────────────
function buildSection9() {
  return [
    h1("Section 9 — GIFSY Super-Admin Pages (src/app/gifsy/*)"),
    para([t("The GIFSY portal is accessible only to users with "), code("GIFSY_ADMIN"), t(" role. It provides platform-level control across all clients.")]),
    emptyPara(),
    makeTable(
      ["Route", "Purpose"],
      [
        ["/gifsy", "Platform overview: total clients, active clients count, feature distribution, recent platform activity log"],
        ["/gifsy/clients", "All clients list showing status, enabled features count, client slug, and last modified date"],
        ["/gifsy/clients/new", "4-step new client creation wizard: Identity (slug, name) → Branding (colors, logo) → Features (feature flags) → Review & Create"],
        ["/gifsy/clients/[slug]", "Full client config editor. All sections editable. Feature flags updated via applyFeatureFlagUpdate(). MSG91 key shown masked as ••••••••. sellerLegalName field is locked to 'Tech Gifsy Solutions Limited' and cannot be edited."],
        ["/gifsy/users", "Platform users management — GIFSY_ADMIN, CLIENT_ADMIN, and MIS_USER accounts"],
        ["/gifsy/settings", "Platform-level settings: JWT expiry, OTP retry limits, data retention policies"],
      ],
      [2400, 6960]
    ),
    emptyPara(),
    h2("Security Notes for GIFSY Portal"),
    bullet([t("The "), code("sellerLegalName"), t(" field in the client config editor is "), t("read-only", { bold: true }), t(" — it always shows "), code("Tech Gifsy Solutions Limited"), t(" and cannot be changed via UI or API.")]),
    bullet([t("MSG91 key is displayed as "), code("••••••••"), t(" in the config editor. It can be updated (write-only) but never read back.")]),
    bullet([t("Feature flag changes call "), code("applyFeatureFlagUpdate(config, key, value, 'GIFSY_ADMIN')"), t(" — this function throws if callerRole is not GIFSY_ADMIN.")]),
    emptyPara(),
  ];
}

// ─── SECTION 10 ────────────────────────────────────────────────────────────────
function buildSection10() {
  return [
    h1("Section 10 — API Routes (src/app/api/*)"),
    para([t("All API routes follow the same pattern: (1) call "), code("getAuthUser(req)"), t(", (2) call "), code("getClientIdFromRequest(req)"), t(", (3) scope all Prisma queries with "), code("clientId"), t(". Never skip step 3.")]),
    emptyPara(),
    h2("Auth Routes"),
    makeTable(
      ["Method + Path", "Purpose", "Auth Required", "clientId Scope", "Notes"],
      [
        ["POST /api/auth/send-otp", "Send OTP to phone number", "Public", "Finds user by { phone, clientId }", "Rate-limited; uses MSG91"],
        ["POST /api/auth/verify-otp", "Verify OTP and return signed JWT", "Public", "User looked up by clientId", "JWT contains userId, role, partnerId"],
        ["GET /api/auth/me", "Current authenticated user profile", "Yes", "Scoped by clientId header", "Returns user without sensitive fields"],
      ],
      [2400, 2200, 1400, 1800, 1560]
    ),
    emptyPara(),
    h2("Admin Routes"),
    makeTable(
      ["Method + Path", "Purpose", "Auth Required", "clientId Scope", "Notes"],
      [
        ["GET/POST /api/admin/users", "List or create users", "CLIENT_ADMIN+", "Direct clientId filter", ""],
        ["GET/PUT/DELETE /api/admin/users/[id]", "Single user CRUD", "CLIENT_ADMIN+", "Verified user.clientId === clientId", ""],
        ["POST /api/admin/users/bulk-edit", "Bulk role or status change", "CLIENT_ADMIN+", "Direct clientId filter", ""],
        ["GET /api/admin/channel-partners", "Partner list with filters", "CLIENT_ADMIN+", "via user.clientId", ""],
        ["GET/PATCH /api/admin/channel-partners/[id]", "Single partner read or update", "CLIENT_ADMIN+", "Verified partner.user.clientId", ""],
        ["GET/POST /api/admin/banners", "Banner CRUD", "CLIENT_ADMIN+", "Direct clientId filter", ""],
        ["GET/PUT /api/admin/settings", "Program settings key-value store", "CLIENT_ADMIN+", "Direct clientId filter", ""],
        ["GET/POST /api/admin/skus", "SKU catalogue management", "CLIENT_ADMIN+", "Direct clientId filter", ""],
        ["GET/POST /api/admin/tiers", "Tier configuration", "CLIENT_ADMIN+", "via partnerClass.clientId", ""],
        ["POST /api/admin/bulk-upload/validate", "Validate Excel upload before processing", "CLIENT_ADMIN+", "clientId for duplicate check", ""],
        ["POST /api/admin/bulk-upload/process", "Process validated Excel and create outlet records", "CLIENT_ADMIN+", "Direct clientId on created records", ""],
        ["GET /api/admin/bulk-upload/template", "Download Excel template for bulk upload", "CLIENT_ADMIN+", "None needed", ""],
        ["POST /api/admin/outlets/bulk-delete", "Bulk delete outlets", "CLIENT_ADMIN+", "Verified outlet.partner.user.clientId", ""],
        ["GET /api/admin/schemes/[id]/enrollments/export", "Export enrollment CSV for a scheme", "CLIENT_ADMIN+", "Verified scheme.clientId", ""],
      ],
      [2600, 1800, 1400, 1700, 1260]
    ),
    emptyPara(),
    h2("KYC Routes"),
    makeTable(
      ["Method + Path", "Purpose", "Auth Required", "clientId Scope", "Notes"],
      [
        ["GET/POST /api/kyc", "List submissions or create new KYC", "Sales/Admin+", "via user.clientId", ""],
        ["GET /api/kyc/[id]", "Submission detail with all documents", "Sales/Admin+", "Verified submission.user.clientId", ""],
        ["POST /api/kyc/[id]/first-approve", "First-level approval (SO or ASM)", "SALES_SO/ASM+", "Verified", "Calls nextKycStatus()"],
        ["POST /api/kyc/[id]/approve", "Final approval (GIFSY_ADMIN)", "GIFSY_ADMIN", "Verified", "Sets APPROVED status"],
        ["POST /api/kyc/[id]/reject", "Reject with reason text", "Sales/Admin+", "Verified", ""],
        ["GET /api/kyc/sla-metrics", "SLA tracking dashboard data", "CLIENT_ADMIN+", "Direct clientId filter", ""],
      ],
      [2600, 1800, 1400, 1700, 1260]
    ),
    emptyPara(),
    h2("Scheme Routes"),
    makeTable(
      ["Method + Path", "Purpose", "Auth Required", "clientId Scope", "Notes"],
      [
        ["GET/POST /api/schemes", "List or create schemes", "CLIENT_ADMIN+", "Direct clientId filter", ""],
        ["GET/PUT/DELETE /api/schemes/[id]", "Single scheme CRUD", "CLIENT_ADMIN+", "Verified scheme.clientId", ""],
        ["GET/POST /api/schemes/[id]/targets", "Partner targets for a specific scheme", "CLIENT_ADMIN+", "via scheme.clientId", ""],
        ["GET/POST /api/schemes/targets", "All targets across schemes", "CLIENT_ADMIN+", "Direct clientId filter", ""],
        ["POST /api/schemes/calculate", "Calculate scheme payout for a given purchase", "Any auth", "Verified", "Used in real-time incentive display"],
      ],
      [2600, 1800, 1400, 1700, 1260]
    ),
    emptyPara(),
    h2("Payout Routes"),
    makeTable(
      ["Method + Path", "Purpose", "Auth Required", "clientId Scope", "Notes"],
      [
        ["GET/POST /api/payouts/batches", "Payout batch list or create new batch", "CLIENT_ADMIN+", "Direct clientId filter", ""],
        ["GET/POST /api/payouts/batches/[id]", "Single batch detail", "CLIENT_ADMIN+", "Verified batch.clientId", ""],
        ["POST /api/payouts/batches/[id]/process", "Execute all payouts in a batch", "CLIENT_ADMIN+", "Verified batch.clientId", "Irreversible — use with caution"],
        ["GET /api/payouts/fund", "Fund account balance", "CLIENT_ADMIN+", "Direct clientId filter", ""],
        ["POST /api/payouts/fund/receive", "Record fund receipt into account", "CLIENT_ADMIN+", "Direct clientId on record", ""],
        ["GET /api/payouts/transactions", "Transaction list", "CLIENT_ADMIN+", "via batch.clientId", ""],
        ["GET /api/payouts/reconciliation", "Reconciliation report", "CLIENT_ADMIN+", "Direct clientId filter", ""],
      ],
      [2600, 1800, 1400, 1700, 1260]
    ),
    emptyPara(),
    h2("Rewards / Gifts Routes"),
    makeTable(
      ["Method + Path", "Purpose", "Auth Required", "clientId Scope", "Notes"],
      [
        ["GET /api/rewards/catalog", "Gift catalog list", "Any auth", "Direct clientId filter", "walletModule must be enabled"],
        ["GET/PUT/DELETE /api/rewards/catalog/[id]", "Single catalog item management", "CLIENT_ADMIN+", "Verified item.clientId", ""],
        ["GET/POST /api/rewards/orders", "Redemption orders list or create", "Any auth", "via user.clientId", ""],
        ["GET /api/rewards/orders/[id]", "Single order detail", "Any auth", "Verified order.user.clientId", ""],
        ["POST /api/rewards/redeem", "Initiate gift redemption (sends OTP)", "PARTNER", "via user.clientId", ""],
        ["POST /api/rewards/redeem/confirm", "Confirm OTP-verified redemption", "PARTNER", "via user.clientId", "Deducts from wallet"],
      ],
      [2600, 1800, 1400, 1700, 1260]
    ),
    emptyPara(),
    h2("Sales Routes"),
    makeTable(
      ["Method + Path", "Purpose", "Auth Required", "clientId Scope", "Notes"],
      [
        ["GET /api/sales/invoices", "Invoice list", "CLIENT_ADMIN+", "via salesUpload.clientId", ""],
        ["GET /api/sales/invoices/[id]", "Invoice detail", "CLIENT_ADMIN+", "Verified", ""],
        ["POST /api/sales/upload", "Upload sales Excel file", "CLIENT_ADMIN+", "Direct clientId on created record", ""],
        ["POST /api/sales/returns", "Record a sales return", "Sales/Admin+", "Verified", ""],
      ],
      [2600, 1800, 1400, 1700, 1260]
    ),
    emptyPara(),
    h2("Visibility Routes"),
    makeTable(
      ["Method + Path", "Purpose", "Auth Required", "clientId Scope", "Notes"],
      [
        ["GET/POST /api/visibility/submissions", "Submission list or query", "Any auth", "via program.clientId", ""],
        ["POST /api/visibility/submit", "Submit photo with GPS coordinates", "PARTNER/SALES", "Validates programId belongs to clientId", "Fraud checks run here"],
        ["POST /api/visibility/submissions/[id]/approve", "Approve a visibility submission", "CLIENT_ADMIN+", "Verified", ""],
        ["POST /api/visibility/submissions/[id]/reject", "Reject with reason", "CLIENT_ADMIN+", "Verified", ""],
        ["GET /api/visibility/fraud-log", "Fraud detection log for admin review", "CLIENT_ADMIN+", "Direct clientId filter", ""],
      ],
      [2600, 1800, 1400, 1700, 1260]
    ),
    emptyPara(),
    h2("Tickets, Wallet, Reports, Leaderboard"),
    makeTable(
      ["Method + Path", "Purpose", "Auth Required", "clientId Scope", "Notes"],
      [
        ["GET/POST /api/tickets", "Ticket list or create", "Any auth", "Direct clientId filter", ""],
        ["GET/PATCH /api/tickets/[id]", "Single ticket detail or update", "Any auth", "Verified ticket.clientId", ""],
        ["POST /api/tickets/[id]/messages", "Add message to ticket thread", "Any auth", "Verified", ""],
        ["POST /api/tickets/[id]/escalate", "Escalate ticket priority", "Any auth", "Verified", ""],
        ["GET /api/wallet", "Partner wallet balance", "PARTNER", "via partner.user.clientId", ""],
        ["GET /api/wallet/transactions", "Wallet transaction history", "PARTNER", "via partner.user.clientId", ""],
        ["POST /api/wallet/adjust", "Admin manual wallet adjustment", "CLIENT_ADMIN+", "Verified via partner", "Logged to audit trail"],
        ["GET /api/reports/billing-trends", "Billing trend chart data", "CLIENT_ADMIN+", "Direct clientId filter", ""],
        ["GET /api/reports/engagement", "Partner engagement metrics", "CLIENT_ADMIN+", "Direct clientId filter", ""],
        ["GET /api/reports/kyc-status", "KYC funnel report", "CLIENT_ADMIN+", "Direct clientId filter", ""],
        ["GET /api/reports/payout-liability", "Payout liability report", "CLIENT_ADMIN+", "Direct clientId filter", ""],
        ["GET /api/reports/scheme-performance", "Scheme performance metrics", "CLIENT_ADMIN+", "Direct clientId filter", ""],
        ["GET /api/reports/tds", "TDS report — INTERNAL ONLY. Never expose to partners.", "CLIENT_ADMIN+ / GIFSY_ADMIN", "Direct clientId filter", "194C TDS — admin and GIFSY only"],
        ["GET /api/reports/visibility-status", "Visibility approval stats", "CLIENT_ADMIN+", "Direct clientId filter", ""],
        ["GET /api/leaderboard", "Partner rankings", "Any auth", "Direct clientId filter", ""],
        ["GET /api/partner/invoices/[id]", "Invoice detail for partner (gross amount only, no TDS)", "PARTNER", "Verified via partner", "TDS never included in response"],
      ],
      [2600, 1800, 1400, 1700, 1260]
    ),
    emptyPara(),
  ];
}

// ─── SECTION 11 ────────────────────────────────────────────────────────────────
function buildSection11() {
  return [
    h1("Section 11 — Components (src/components/*)"),
    para([t("Shared React components organized by domain. Always use these before creating new components with similar functionality.")]),
    emptyPara(),
    h2("UI Primitives (src/components/ui/)"),
    makeTable(
      ["Component", "File", "Purpose", "Used In"],
      [
        ["Badge", "badge.tsx", "Status label with color variants (success, warning, error, info)", "KYC status, scheme status, ticket priority"],
        ["Button", "button.tsx", "Primary/secondary/ghost button with loading state", "Throughout all portals"],
        ["Card", "card.tsx", "Content container with shadow and border", "Dashboard widgets, form sections"],
        ["DataTable", "data-table.tsx", "Sortable, filterable table with pagination", "All list pages across portals"],
        ["EmptyState", "empty-state.tsx", "Illustrated empty state for lists with zero items", "All data tables when empty"],
        ["Input", "input.tsx", "Styled text input with label, error state, help text", "All forms"],
        ["Modal", "modal.tsx", "Accessible dialog/modal overlay", "Confirm dialogs, quick-edit forms"],
        ["ProgressBar", "progress-bar.tsx", "Horizontal progress indicator with percentage", "Target achievement, scheme progress"],
        ["Select", "select.tsx", "Dropdown select with search capability", "Filters, form selects"],
        ["Spinner", "spinner.tsx", "Loading spinner for async states", "Page loading, button loading"],
        ["StatsCard", "stats-card.tsx", "KPI card with value, label, trend indicator", "Dashboard pages"],
        ["Table", "table.tsx", "Base table primitives (thead, tbody, tr, td, th)", "Used by DataTable"],
        ["Tabs", "tabs.tsx", "Tab navigation with content panels", "Portal layouts, detail pages"],
        ["Toast", "toast.tsx", "Notification toast for success/error/info messages", "After form submissions, API calls"],
      ],
      [1600, 1800, 3000, 2960]
    ),
    emptyPara(),
    h2("Layout Components (src/components/layout/)"),
    makeTable(
      ["Component", "File", "Purpose", "Used In"],
      [
        ["BottomNav", "nav-bottom.tsx", "Mobile bottom navigation bar with 5 tab items and active state indicators", "partner/layout.tsx"],
        ["Sidebar", "sidebar.tsx", "Desktop sidebar with logo, nav items, and user info footer", "partner/layout.tsx"],
      ],
      [1600, 1800, 3500, 2460]
    ),
    emptyPara(),
    h2("Scheme Components (src/components/schemes/)"),
    makeTable(
      ["Component", "File", "Purpose", "Used In"],
      [
        ["SchemeCard", "scheme-card.tsx", "Scheme display card showing scheme name, type, eligibility status, progress bar, and CTA", "partner/schemes, admin/schemes"],
        ["ProgressRing", "progress-ring.tsx", "SVG circular progress indicator for compact target display", "SchemeCard, partner dashboard"],
      ],
      [1600, 1800, 3500, 2460]
    ),
    emptyPara(),
    h2("KYC Components (src/components/kyc/)"),
    makeTable(
      ["Component", "File", "Purpose", "Used In"],
      [
        ["KYCForm", "kyc-form.tsx", "Multi-step KYC form component. 4 steps: Outlet, Details, Address, Bank+Signature. Includes signature pad and file upload.", "sales/kyc/new"],
        ["KYCStatusBadge", "kyc-status-badge.tsx", "Status badge with per-state colors: DRAFT (grey), SUBMITTED (blue), PENDING_SO/ASM (orange), PENDING_GIFSY (purple), APPROVED (green), REJECTED (red)", "KYC list pages, detail pages"],
      ],
      [1600, 1800, 3500, 2460]
    ),
    emptyPara(),
    h2("Wallet Components (src/components/wallet/)"),
    makeTable(
      ["Component", "File", "Purpose", "Used In"],
      [
        ["BalanceCard", "balance-card.tsx", "Wallet balance display showing available balance, pending balance, and track type (POINTS/INR)", "partner/wallet"],
        ["TransactionItem", "transaction-item.tsx", "Single transaction row with type icon, amount (color-coded credit/debit), date, and description", "partner/wallet, partner/payouts"],
      ],
      [1600, 1800, 3500, 2460]
    ),
    emptyPara(),
    h2("Chart Components (src/components/charts/)"),
    makeTable(
      ["Component", "File", "Purpose", "Used In"],
      [
        ["AchievementChart", "achievement-chart.tsx", "Partner achievement vs target bar/line combination chart using Recharts", "partner/dashboard, partner/targets"],
        ["BillingTrend", "billing-trend.tsx", "Billing trend line chart over time periods for admin analytics", "admin/dashboards/payments, admin/reports"],
        ["SalesAchievementChart", "sales-achievement-chart.tsx", "Sales team achievement chart with role-level breakdowns", "sales/dashboard"],
      ],
      [1800, 2000, 3000, 2560]
    ),
    emptyPara(),
    h2("Admin Components (src/components/admin/)"),
    makeTable(
      ["Component", "File", "Purpose", "Used In"],
      [
        ["SchemeBuilder", "scheme-builder.tsx", "Full scheme creation wizard with drag-and-drop rule configuration. Handles slab rules, flat rates, eligibility criteria.", "admin/schemes, admin/schemes/new"],
        ["SchemeBuilderHelpers", "scheme-builder-helpers.ts", "Scheme rule parsing utilities and parseEnhancedOutletExcel() for Excel-based outlet enrollment.", "SchemeBuilder, admin/schemes"],
        ["EnrollmentFormBuilder", "EnrollmentFormBuilder.tsx", "Dynamic enrollment form builder for campaigns — add/remove/reorder form fields.", "admin/schemes, campaign management"],
        ["KYCReviewer", "kyc-reviewer.tsx", "KYC detail view component with document viewer, approve and reject action buttons, and comment field.", "admin/kyc/[id]"],
        ["FilterBar", "filter-bar.tsx", "Reusable filter and search bar component with configurable filter fields.", "Most admin list pages"],
      ],
      [1800, 2000, 3000, 2560]
    ),
    emptyPara(),
    h2("Invoice Components (src/components/invoice/)"),
    makeTable(
      ["Component", "File", "Purpose", "Used In"],
      [
        ["VisibilityInvoicePDF", "VisibilityInvoicePDF.ts", "PDF generation for visibility invoices. Seller name is hardcoded as 'Tech Gifsy Solutions Limited'. 194C TDS is never shown on the invoice — gross amounts only.", "admin/invoices, partner/invoices/[id]"],
      ],
      [1800, 2000, 3700, 1860]
    ),
    emptyPara(),
  ];
}

// ─── SECTION 12 ────────────────────────────────────────────────────────────────
function buildSection12() {
  return [
    h1("Section 12 — Database Schema (prisma/schema.prisma)"),
    para([t("The full schema is at "), code("platform/prisma/schema.prisma"), t(". This section documents the multi-tenancy design and key relationships.")]),
    emptyPara(),
    h2("Multi-Tenancy Design"),
    para([t("All models fall into two categories:")]),
    bullet([t("Root models — have a direct "), code("clientId"), t(" field + "), code("@@index([clientId])"), t(" for query performance.")]),
    bullet([t("Inherited models — no direct clientId, but reach it through a relation chain (e.g., "), code("ChannelPartner.user.clientId"), t(").")]),
    emptyPara(),
    h2("Root Models (Direct clientId)"),
    makeTable(
      ["Model", "Default clientId", "Notes"],
      [
        ["User", "@default(\"deoleo\")", "All platform users — partners, sales, admins"],
        ["Scheme", "@default(\"deoleo\")", "Loyalty program schemes"],
        ["Sku", "@default(\"deoleo\")", "Product SKU catalogue"],
        ["PayoutBatch", "@default(\"deoleo\")", "Payout batch records"],
        ["FundLedger", "@default(\"deoleo\")", "Fund account ledger entries"],
        ["FundReceipt", "@default(\"deoleo\")", "Fund receipt records"],
        ["Ticket", "@default(\"deoleo\")", "Support tickets"],
        ["BannerManagement", "@default(\"deoleo\")", "Banner scheduling and targeting"],
        ["ProgramSetting", "@default(\"deoleo\")", "Key-value program settings"],
        ["RewardCatalog", "@default(\"deoleo\")", "Gift reward catalog items"],
        ["VisibilityProgram", "@default(\"deoleo\")", "Visibility submission programs"],
        ["LeaderboardConfig", "@default(\"deoleo\")", "Leaderboard configuration"],
        ["SalesUpload", "@default(\"deoleo\")", "Sales Excel upload records"],
        ["AutoInvoice", "@default(\"deoleo\")", "Auto-generated invoices"],
        ["NotificationTemplate", "@default(\"deoleo\")", "SMS/in-app notification templates"],
        ["AdminConfig", "@default(\"deoleo\")", "Admin configuration settings"],
        ["ScheduledReport", "@default(\"deoleo\")", "Scheduled report definitions"],
        ["PartnerClassConfig", "@default(\"deoleo\")", "Partner class/tier configuration"],
        ["SalesHierarchyLevel", "@default(\"deoleo\")", "Sales hierarchy role definitions"],
        ["PointExpiryConfig", "@default(\"deoleo\")", "Points expiry policy configuration"],
        ["RewardCategory", "@default(\"deoleo\")", "Reward catalog category definitions"],
      ],
      [2400, 2400, 4560]
    ),
    emptyPara(),
    h2("Inherited Models (clientId via Relation)"),
    makeTable(
      ["Model", "clientId Path", "Notes"],
      [
        ["ChannelPartner", "via user.clientId", "Trade partner profile — linked to User"],
        ["KycSubmission", "via user.clientId", "KYC form submission — linked to User"],
        ["Outlet", "via partner.user.clientId", "Physical outlet — linked to ChannelPartner → User"],
        ["Wallet", "via partner.user.clientId", "Partner wallet — linked to ChannelPartner → User"],
        ["PayoutTransaction", "via batch.clientId", "Individual payout — linked to PayoutBatch"],
        ["SalesInvoice", "via salesUpload.clientId", "Sales invoice — linked to SalesUpload"],
      ],
      [2400, 2400, 4560]
    ),
    emptyPara(),
    h2("Core Model Relationships"),
    makeTable(
      ["Relationship", "Description"],
      [
        ["User → ChannelPartner → Wallet → WalletTransaction", "Every trade partner has a wallet with a transaction ledger"],
        ["User → KycSubmission → KycDocument", "KYC submission contains multiple uploaded documents"],
        ["Scheme → SchemeRule → SchemeEligibility", "Schemes have rules that define eligibility criteria"],
        ["PayoutBatch → PayoutTransaction", "A payout batch contains multiple individual transactions"],
        ["VisibilityProgram → VisibilitySubmission", "A visibility program collects photo submissions"],
        ["Ticket → TicketMessage", "Support tickets have a message thread"],
      ],
      [3800, 5560]
    ),
    emptyPara(),
    h2("Migration Note"),
    para([
      t("The command "), code("prisma migrate dev --name add_client_id"),
      t(" has not yet run against the live production database. The schema is validated and Prisma Client has been generated. Run this migration when the production DB is available."),
    ]),
    para([t("For development, run: "), code("npx prisma migrate dev"), t(" from the "), code("platform/"), t(" directory.")]),
    emptyPara(),
  ];
}

// ─── SECTION 13 ────────────────────────────────────────────────────────────────
function buildSection13() {
  return [
    h1("Section 13 — Tests"),
    para([t("All tests are written with Vitest and live in "), code("src/lib/__tests__/"), t(", "), code("src/lib/platform/__tests__/"), t(", "), code("src/components/admin/__tests__/"), t(", and "), code("src/app/sales/kyc/new/__tests__/"), t(".")]),
    emptyPara(),
    makeTable(
      ["Test File", "What It Tests", "How to Run"],
      [
        [
          para([code("src/lib/__tests__/tenant.test.ts")], { spacing: { after: 0 } }),
          "getClientIdFromRequest: header present, missing, empty, uppercase, whitespace variants (8 test cases total)",
          para([code("npx vitest run src/lib/__tests__/tenant.test.ts")], { spacing: { after: 0 } }),
        ],
        [
          para([code("src/lib/__tests__/kyc-approval.test.ts")], { spacing: { after: 0 } }),
          "KYC state machine: initialKycStatus() role dispatch, nextKycStatus() all transitions, escalation detection when manager is inactive",
          para([code("npx vitest run src/lib/__tests__/kyc-approval.test.ts")], { spacing: { after: 0 } }),
        ],
        [
          para([code("src/lib/__tests__/bulk-upload-validator.test.ts")], { spacing: { after: 0 } }),
          "Excel row parsing, error message collection, duplicate outlet detection across rows",
          para([code("npx vitest run src/lib/__tests__/bulk-upload-validator.test.ts")], { spacing: { after: 0 } }),
        ],
        [
          para([code("src/lib/__tests__/campaign.test.ts")], { spacing: { after: 0 } }),
          "Campaign eligibility checking, enrollment form field validation",
          para([code("npx vitest run src/lib/__tests__/campaign.test.ts")], { spacing: { after: 0 } }),
        ],
        [
          para([code("src/lib/__tests__/msg91.test.ts")], { spacing: { after: 0 } }),
          "OTP sending mock — verifies MSG91 is called with correct params and that the auth key never appears in any outgoing response",
          para([code("npx vitest run src/lib/__tests__/msg91.test.ts")], { spacing: { after: 0 } }),
        ],
        [
          para([code("src/lib/__tests__/resolve-approver.test.ts")], { spacing: { after: 0 } }),
          "Manager phone resolution logic — resignation fallback when a role's phone is inactive",
          para([code("npx vitest run src/lib/__tests__/resolve-approver.test.ts")], { spacing: { after: 0 } }),
        ],
        [
          para([code("src/lib/__tests__/schemes-enrollment.test.ts")], { spacing: { after: 0 } }),
          "Scheme enrollment eligibility checks — partner type, tier, and date range validation",
          para([code("npx vitest run src/lib/__tests__/schemes-enrollment.test.ts")], { spacing: { after: 0 } }),
        ],
        [
          para([code("src/components/admin/__tests__/scheme-builder-campaign.test.ts")], { spacing: { after: 0 } }),
          "Outlet Excel parsing via parseEnhancedOutletExcel(), notification config validation",
          para([code("npx vitest run src/components/admin/__tests__/")], { spacing: { after: 0 } }),
        ],
        [
          para([code("src/lib/platform/__tests__/client-config.test.ts")], { spacing: { after: 0 } }),
          "Feature flag enforcement: CLIENT_ADMIN cannot change flags, GIFSY_ADMIN can, applyFeatureFlagUpdate() throws on wrong role",
          para([code("npx vitest run src/lib/platform/__tests__/client-config.test.ts")], { spacing: { after: 0 } }),
        ],
        [
          para([code("src/lib/platform/__tests__/platform-admin.test.ts")], { spacing: { after: 0 } }),
          "buildClientSummary() output shape, validateNewClientSlug() uniqueness and format rules",
          para([code("npx vitest run src/lib/platform/__tests__/platform-admin.test.ts")], { spacing: { after: 0 } }),
        ],
        [
          para([code("src/lib/platform/__tests__/tenant-resolution.test.ts")], { spacing: { after: 0 } }),
          "Hostname → slug mapping: known subdomains, localhost fallback, unknown hostname handling",
          para([code("npx vitest run src/lib/platform/__tests__/tenant-resolution.test.ts")], { spacing: { after: 0 } }),
        ],
        [
          para([code("src/app/sales/kyc/new/__tests__/new-kyc.test.tsx")], { spacing: { after: 0 } }),
          "KYC form UI: no inline OTP during form fill, checkbox blocking submission, signature pad interaction, post-submit OTP flow triggers correctly",
          para([code("npx vitest run src/app/sales/kyc/new/__tests__/")], { spacing: { after: 0 } }),
        ],
      ],
      [3000, 3600, 2760]
    ),
    emptyPara(),
    para([t("Run all tests at once (from the "), code("platform/"), t(" directory):")]),
    ...codeBlock(["npx vitest run"]),
    emptyPara(),
    para([t("Run in watch mode during development:")]),
    ...codeBlock(["npx vitest"]),
    emptyPara(),
  ];
}

// ─── SECTION 14 ────────────────────────────────────────────────────────────────
function buildSection14() {
  return [
    h1("Section 14 — Multi-Tenancy Implementation Guide"),
    h2("How to Add a New Client"),
    numbered([
      t("Open "), code("src/lib/platform/client-registry.ts"),
      t(" and add a new entry to "), code("CLIENT_REGISTRY"), t(":"),
    ]),
    ...codeBlock([
      "CLIENT_REGISTRY['newclient'] = {",
      "  slug: 'newclient',",
      "  branding: { displayName: 'New Client Ltd', primaryColor: '#1A73E8', ... },",
      "  featureFlags: { kycApprovalFlow: true, walletModule: false, ... },",
      "  ...",
      "};",
    ]),
    numbered([
      t("Open "), code("src/lib/platform/tenant-resolution.ts"),
      t(" and add the hostname mapping:"),
    ]),
    ...codeBlock([
      "const HOSTNAME_MAP: Record<string, string> = {",
      "  'newclient.loyaltybase.in': 'newclient',",
      "  // ... existing entries",
      "};",
    ]),
    numbered([
      t("Feature flags must be set via "), code("applyFeatureFlagUpdate()"),
      t(" with "), code("GIFSY_ADMIN"), t(" role — never mutate directly."),
    ]),
    numbered([t("Run a DB migration to create seed rows with the new clientId. All root model records need "), code("clientId = 'newclient'"), t(".")]),
    numbered([t("(Phase 3) Add entry to the DB "), code("ClientConfig"), t(" table to replace the in-memory registry.")]),
    emptyPara(),

    h2("How to Add a New Feature Flag"),
    numbered([
      t("In "), code("src/lib/platform/client-config.ts"), t(", add the new flag to the "), code("FeatureFlags"), t(" interface:"),
    ]),
    ...codeBlock([
      "export interface FeatureFlags {",
      "  kycApprovalFlow: boolean;",
      "  walletModule: boolean;",
      "  myNewFeature: boolean; // <-- add here",
      "  // ...",
      "}",
    ]),
    numbered([t("Set a default value in "), code("CLIENT_REGISTRY"), t("'s default config in "), code("client-registry.ts"), t(".")]),
    numbered([
      t("If this flag gates an admin navigation item: add it to "), code("ALL_NAV_ITEMS"),
      t(" in "), code("src/app/admin/layout.tsx"), t(":"),
    ]),
    ...codeBlock([
      "{ label: 'My Feature', href: '/admin/my-feature',",
      "  featureFlag: 'myNewFeature' },",
    ]),
    numbered([t("If it gates a partner navigation item: add the "), code("useFeatureFlag('myNewFeature')"), t(" check in "), code("src/app/partner/layout.tsx"), t(".")]),
    numbered([
      t("Gate the UI in the page component:"),
    ]),
    ...codeBlock([
      "const isEnabled = useFeatureFlag('myNewFeature');",
      "if (!isEnabled) return <FeatureDisabledPlaceholder />;",
    ]),
    emptyPara(),

    h2("Adding a New API Route — Checklist"),
    numbered([
      t("Create file at "), code("src/app/api/[domain]/route.ts"), t("."),
    ]),
    numbered([
      t("Import auth utilities:"),
    ]),
    ...codeBlock([
      "import { getAuthUser } from '@/lib/auth';",
      "import { getClientIdFromRequest } from '@/lib/tenant';",
    ]),
    numbered([
      t("At the top of every handler, get auth and clientId:"),
    ]),
    ...codeBlock([
      "export async function GET(req: NextRequest) {",
      "  const user = getAuthUser(req);",
      "  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });",
      "",
      "  const clientId = getClientIdFromRequest(req);",
      "",
      "  // All Prisma queries MUST include clientId",
      "  const records = await prisma.myModel.findMany({",
      "    where: { clientId },",
      "  });",
      "}",
    ]),
    numbered([t("Never include TDS-related data in responses to partner-facing or sales-facing routes.")]),
    numbered([t("Add the route to Section 10 of this document when documenting it.")]),
    emptyPara(),
  ];
}

// ─── SECTION 15 ────────────────────────────────────────────────────────────────
function buildSection15() {
  return [
    h1("Section 15 — Security Rules (Non-Negotiable)"),
    para([t("These rules are architectural guardrails. Violating any of them is a "), t("critical security or legal defect", { bold: true }), t(".")]),
    emptyPara(),
    h2("Rule 1 — 194C TDS: Internal Only"),
    bullet([t("Calculated in "), code("src/lib/tds.ts"), t(".")]),
    bullet([t("Used ONLY in reports visible to "), code("GIFSY_ADMIN"), t(" and "), code("CLIENT_ADMIN"), t(".")]),
    bullet([t("NEVER included in API responses to "), code("PARTNER"), t(" or "), code("SALES"), t(" users.")]),
    bullet([t("Partner invoices and "), code("/api/partner/invoices/[id]"), t(" show "), t("gross amount only", { bold: true }), t(" — TDS line never rendered.")]),
    bullet([t("The "), code("/api/reports/tds"), t(" endpoint is gated to "), code("CLIENT_ADMIN+"), t(" and "), code("GIFSY_ADMIN"), t(" only — verify this auth check exists in the route handler.")]),
    emptyPara(),
    h2("Rule 2 — Seller Name Fixed"),
    bullet([t("Seller name on all invoices is always "), code("Tech Gifsy Solutions Limited"), t(".")]),
    bullet([t("Hardcoded in "), code("src/components/invoice/VisibilityInvoicePDF.ts"), t(".")]),
    bullet([t("The "), code("sellerLegalName"), t(" field in the GIFSY client config editor is locked (read-only) in the UI.")]),
    bullet([t("Never add a form field or API param that allows changing the seller name.")]),
    emptyPara(),
    h2("Rule 3 — MSG91 Auth Key: Server-Side Only"),
    bullet([t("Read from "), code("process.env.MSG91_AUTH_KEY"), t(" in "), code("src/lib/msg91.ts"), t(" only.")]),
    bullet([t("Never included in "), code("ClientConfig"), t(" fields returned to the browser.")]),
    bullet([t("GIFSY admin UI masks the key as "), code("••••••••"), t(" — it is write-only from the UI perspective.")]),
    bullet([t("Verify: no "), code("MSG91_AUTH_KEY"), t(" values appear in any "), code("NEXT_PUBLIC_"), t(" env var.")]),
    emptyPara(),
    h2("Rule 4 — Feature Flags via applyFeatureFlagUpdate() Only"),
    bullet([t("All feature flag mutations must call "), code("applyFeatureFlagUpdate(config, key, value, callerRole)"), t(".")]),
    bullet([t("This function throws if "), code("callerRole !== 'GIFSY_ADMIN'"), t(".")]),
    bullet([t("Never directly mutate "), code("clientConfig.featureFlags"), t(" without going through this function.")]),
    bullet([code("CLIENT_ADMIN"), t(" users cannot change any feature flags — this is enforced by the function, not just by UI.")]),
    emptyPara(),
    h2("Rule 5 — Cross-Tenant Data Access"),
    bullet([t("Every API route must scope Prisma queries with "), code("clientId"), t(" obtained from "), code("getClientIdFromRequest(req)"), t(".")]),
    bullet([t("For inherited models (no direct clientId), verify the relation chain leads to the same clientId before returning data.")]),
    bullet([t("Never trust client-supplied clientId in request body — always derive it from the proxy-injected "), code("x-tenant-slug"), t(" header.")]),
    emptyPara(),
  ];
}

// ─── SECTION 16 ────────────────────────────────────────────────────────────────
function buildSection16() {
  return [
    h1("Section 16 — Environment Variables"),
    para([t("All environment variables are configured in "), code(".env"), t(" (never committed to git). Use "), code(".env.example"), t(" as a template for new environments.")]),
    emptyPara(),
    makeTable(
      ["Variable", "Used In", "Required", "Notes"],
      [
        [para([code("DATABASE_URL")], { spacing: { after: 0 } }), para([code("prisma.ts")], { spacing: { after: 0 } }), "Yes", "PostgreSQL connection string. Format: postgresql://user:pass@host:5432/dbname"],
        [para([code("JWT_SECRET")], { spacing: { after: 0 } }), para([code("proxy.ts"), t(", auth routes")], { spacing: { after: 0 } }), "Yes", "Minimum 32 characters in production. Used to sign and verify JWTs."],
        [para([code("MSG91_AUTH_KEY")], { spacing: { after: 0 } }), para([code("msg91.ts")], { spacing: { after: 0 } }), "Yes", "India SMS OTP provider auth key. Server-side only. Never expose to browser."],
        [para([code("MSG91_TEMPLATE_ID")], { spacing: { after: 0 } }), para([code("msg91.ts")], { spacing: { after: 0 } }), "Yes", "MSG91 OTP message template ID configured in MSG91 dashboard."],
        [para([code("AWS_ACCESS_KEY_ID")], { spacing: { after: 0 } }), para([code("s3.ts")], { spacing: { after: 0 } }), "Yes", "AWS IAM access key with S3 put/get/delete permissions."],
        [para([code("AWS_SECRET_ACCESS_KEY")], { spacing: { after: 0 } }), para([code("s3.ts")], { spacing: { after: 0 } }), "Yes", "AWS IAM secret key corresponding to the access key."],
        [para([code("AWS_S3_BUCKET")], { spacing: { after: 0 } }), para([code("s3.ts")], { spacing: { after: 0 } }), "Yes", "S3 bucket name for file storage (KYC docs, visibility photos, invoices)."],
        [para([code("AWS_REGION")], { spacing: { after: 0 } }), para([code("s3.ts")], { spacing: { after: 0 } }), "Yes", "AWS region. Default: ap-south-1 (Mumbai) for India deployments."],
        [para([code("NEXT_PUBLIC_APP_URL")], { spacing: { after: 0 } }), "Various client-side uses", "No", "Base URL for callbacks and absolute links. e.g., https://deoleo.loyaltybase.in"],
        [para([code("DEMO_MODE")], { spacing: { after: 0 } }), para([code("proxy.ts")], { spacing: { after: 0 } }), "No", "Set to 'true' to bypass JWT auth and inject demo user headers. NEVER set in production."],
      ],
      [2400, 2000, 1000, 4160]
    ),
    emptyPara(),
    h2("Environment Setup Checklist for New Developers"),
    numbered([t("Copy "), code(".env.example"), t(" to "), code(".env"), t(".")]),
    numbered([t("Set "), code("DATABASE_URL"), t(" to your local PostgreSQL instance.")]),
    numbered([t("Set "), code("JWT_SECRET"), t(" to any 32+ character string for local dev.")]),
    numbered([t("Set "), code("DEMO_MODE=true"), t(" for local development to bypass SMS OTP.")]),
    numbered([t("For S3: either use a dev bucket or mock S3 with localstack.")]),
    numbered([t("Run "), code("npx prisma migrate dev"), t(" to apply all migrations.")]),
    numbered([t("Run "), code("npx prisma db seed"), t(" if a seed file exists to populate dev data.")]),
    numbered([t("Start the dev server: "), code("npm run dev"), t(".")]),
    emptyPara(),
  ];
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOCUMENT ASSEMBLY
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const children = [
    ...buildTitlePage(),
    ...buildTOC(),
    ...buildSection1(),
    ...buildSection2(),
    ...buildSection3(),
    ...buildSection4(),
    ...buildSection5(),
    ...buildSection6(),
    ...buildSection7(),
    ...buildSection8(),
    ...buildSection9(),
    ...buildSection10(),
    ...buildSection11(),
    ...buildSection12(),
    ...buildSection13(),
    ...buildSection14(),
    ...buildSection15(),
    ...buildSection16(),
  ];

  const doc = new Document({
    numbering: {
      config: [
        {
          reference: "bullets",
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "•",
              alignment: AlignmentType.LEFT,
              style: {
                paragraph: { indent: { left: 720, hanging: 360 } },
                run: { font: "Arial" },
              },
            },
            {
              level: 1,
              format: LevelFormat.BULLET,
              text: "◦",
              alignment: AlignmentType.LEFT,
              style: {
                paragraph: { indent: { left: 1080, hanging: 360 } },
                run: { font: "Arial" },
              },
            },
          ],
        },
        {
          reference: "numbers",
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.LEFT,
              style: {
                paragraph: { indent: { left: 720, hanging: 360 } },
                run: { font: "Arial" },
              },
            },
          ],
        },
      ],
    },
    styles: {
      default: {
        document: {
          run: { font: "Arial", size: 22 },
        },
      },
      paragraphStyles: [
        {
          id: "Heading1",
          name: "Heading 1",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { size: 36, bold: true, font: "Arial", color: NAVY },
          paragraph: {
            spacing: { before: 360, after: 200 },
            outlineLevel: 0,
          },
        },
        {
          id: "Heading2",
          name: "Heading 2",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { size: 28, bold: true, font: "Arial", color: DARK_NAVY },
          paragraph: {
            spacing: { before: 240, after: 120 },
            outlineLevel: 1,
          },
        },
        {
          id: "Heading3",
          name: "Heading 3",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { size: 24, bold: true, font: "Arial", color: DARK_NAVY },
          paragraph: {
            spacing: { before: 160, after: 80 },
            outlineLevel: 2,
          },
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 12240, height: 15840 },
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                children: [
                  t("LoyaltyBase Platform — Developer Guide", { bold: true, size: 18 }),
                  new TextRun({
                    children: ["\t", "June 2025"],
                    font: "Arial",
                    size: 18,
                    color: "666666",
                  }),
                ],
                tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
                border: {
                  bottom: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC", space: 1 },
                },
                spacing: { after: 80 },
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                children: [
                  t("Confidential — Internal Use Only", { size: 18, color: "666666" }),
                  new TextRun({
                    children: ["\tPage ", PageNumber.CURRENT, " of ", PageNumber.TOTAL_PAGES],
                    font: "Arial",
                    size: 18,
                    color: "666666",
                  }),
                ],
                tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
                border: {
                  top: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC", space: 1 },
                },
                spacing: { before: 80 },
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  const outPath = "C:\\Users\\nikun\\Loyaltybaseclaude\\LoyaltyBase_Codebase_Guide.docx";
  fs.writeFileSync(outPath, buffer);
  const stats = fs.statSync(outPath);
  console.log(`Document written to: ${outPath}`);
  console.log(`File size: ${(stats.size / 1024).toFixed(1)} KB`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
