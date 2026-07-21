/**
 * Seed script — platform bootstrap + deoleo demo dataset.
 *
 * Scope of this seed:
 *   1. GIFSY_ADMIN user  — the platform super-admin account.
 *   2. OutletType rows   — the global master list (Retailer, Wholesaler,
 *                          Sub-Stockist, SSS TOT). Names and codes can be
 *                          updated later via a migration; the @unique code
 *                          is the stable identifier.
 *   3. deoleo DEMO data  — a realistic, idempotent tenant dataset so the app
 *                          is actually usable in dev/demo: a CLIENT_ADMIN, two
 *                          channel partners (each with a Wallet + Outlet), a
 *                          SalesUser (with a hierarchy level + outlet
 *                          assignment), a RewardCategory + 2 RewardCatalog
 *                          items, and pending KYC submissions.
 *
 * Every write is idempotent (upsert / find-then-create) so re-running is safe
 * even against rows left over from manual testing.
 *
 * SAFETY: this seed HARD-REFUSES to run unless current_database() = 'gifsy_dev'.
 *
 * Run:
 *   npx prisma db seed
 *   -- or --
 *   GIFSY_ADMIN_PHONE=9999999999 npx prisma db seed
 */

import 'dotenv/config';
import {
  PrismaClient,
  UserRole,
  UserStatus,
  KycStatus,
  EntityType,
  GstRegistrationType,
  PayoutMode,
  PayoutStatus,
  PayoutBatchStatus,
  FundLedgerType,
  RewardCatalogStatus,
  VisibilityProgramStatus,
  TicketCategory,
} from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as bcrypt from 'bcrypt';

// Construct PrismaClient with the pg driver adapter — required under Prisma 7
// (a bare `new PrismaClient()` throws "must provide a driver adapter").
// Mirrors api/src/prisma/prisma.service.ts.
const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ── Shared provisioning helper ────────────────────────────────────────────────
//
// Mirrors GifsyService.provisionOutletTypeConfigs() exactly. Any change here
// must also be applied there (and vice-versa). Idempotent upsert — safe to
// call repeatedly. Uses the module-level `prisma` client (no tx required for
// seed context, which runs outside a transaction).

const DEFAULT_OUTLET_TYPE_CONFIG_FLAGS = {
  isEnabled: true,
  displayName: null as string | null,
  loyaltyEnabled: true,
  schemesEnabled: true,
  visibilityEnabled: true,
  payoutsEnabled: true,
  leaderboardEnabled: true,
  targetsEnabled: true,
  kycRequired: true,
};

async function provisionOutletTypeConfigs(clientId: string): Promise<void> {
  const allTypes = await prisma.outletType.findMany({
    where: { isActive: true },
    select: { id: true },
  });
  for (const ot of allTypes) {
    await prisma.outletTypeClientConfig.upsert({
      where: { clientId_outletTypeId: { clientId, outletTypeId: ot.id } },
      update: { isEnabled: DEFAULT_OUTLET_TYPE_CONFIG_FLAGS.isEnabled },
      create: { clientId, outletTypeId: ot.id, ...DEFAULT_OUTLET_TYPE_CONFIG_FLAGS },
    });
  }
}

// ── Config ────────────────────────────────────────────────────────────────────

const GIFSY_CLIENT_ID    = 'gifsy';
const GIFSY_ADMIN_PHONE  = process.env['GIFSY_ADMIN_PHONE'] ?? '9830011252';
const GIFSY_ADMIN_NAME   = process.env['GIFSY_ADMIN_NAME']  ?? 'Gifsy Super Admin';

const DEOLEO_CLIENT_ID = 'deoleo';
// A SECOND tenant, so the E2E harness can prove tenant isolation: deoleo users must NEVER see any of
// clientb's data (distinctive names below are the leak markers). See platform/e2e cross-tenant specs.
const CLIENTB_CLIENT_ID = 'clientb';

// OutletType master list. code is the stable key — name is the display label
// and can be changed at any time without touching code or migrations.
const OUTLET_TYPES = [
  { code: 'SSS',          name: 'SSS',          description: 'SSS channel partner' },
  { code: 'WHOLESALER',   name: 'Wholesaler',   description: 'Wholesale channel partner' },
  { code: 'SUB_STOCKIST', name: 'Sub-Stockist', description: 'Sub-stockist channel partner' },
  { code: 'SSS_TOT',      name: 'SSS TOT',      description: 'Super stockist / TOT channel partner' },
] as const;

// ── Safety guard ────────────────────────────────────────────────────────────────

async function assertDevDatabase(): Promise<void> {
  const rows = await prisma.$queryRaw<{ current_database: string }[]>`
    SELECT current_database() AS current_database
  `;
  const dbName = rows[0]?.current_database;
  const allowed = ['gifsy_dev', 'gifsy_staging'];
  if (!allowed.includes(dbName)) {
    throw new Error(
      `🚫  Refusing to seed: connected database is "${dbName}", expected one of: ${allowed.map((d) => `"${d}"`).join(', ')}. ` +
        `This seed only runs against the dev or staging database. Check DATABASE_URL.`,
    );
  }
  console.log(`   ✓ Safety check passed — connected to "${dbName}".`);
}

// ── Seed ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🌱  Starting seed…');

  await assertDevDatabase();

  // 1. GIFSY_ADMIN user ──────────────────────────────────────────────────────
  //
  // GIFSY_ADMIN lives under the "gifsy" clientId — it is the platform itself,
  // not any specific tenant.  upsert on (clientId, phone) so re-running the
  // seed is safe.
  const existingAdmin = await prisma.user.findFirst({
    where: { clientId: GIFSY_CLIENT_ID, role: UserRole.GIFSY_ADMIN },
  });

  if (existingAdmin) {
    console.log(`   ✓ GIFSY_ADMIN already exists (${existingAdmin.phone}) — skipping.`);
  } else {
    // Seed a bcrypt-hashed placeholder password.  The account is intended to
    // use OTP login in production; the password hash is just a safety net.
    const passwordHash = await bcrypt.hash('ChangeMeOnFirstLogin!', 12);

    const admin = await prisma.user.create({
      data: {
        clientId:     GIFSY_CLIENT_ID,
        phone:        GIFSY_ADMIN_PHONE,
        name:         GIFSY_ADMIN_NAME,
        role:         UserRole.GIFSY_ADMIN,
        status:       UserStatus.ACTIVE,
        passwordHash,
      },
    });

    console.log(`   ✓ GIFSY_ADMIN created — id: ${admin.id}, phone: ${admin.phone}`);
  }

  // 2. OutletType master list ────────────────────────────────────────────────
  //
  // OutletType.code is NOT a DB-level @unique, so we can't upsert on it.
  // find-then-create/update keyed on code keeps the master list idempotent.
  for (const ot of OUTLET_TYPES) {
    const existing = await prisma.outletType.findFirst({ where: { code: ot.code } });
    const result = existing
      ? await prisma.outletType.update({
          where: { id: existing.id },
          data: { name: ot.name, description: ot.description },
        })
      : await prisma.outletType.create({
          data: { code: ot.code, name: ot.name, description: ot.description, isActive: true },
        });

    console.log(`   ✓ OutletType [${result.code}] "${result.name}"  — id: ${result.id}`);
  }

  // 3. deoleo DEMO dataset ─────────────────────────────────────────────────────
  await seedDeoleoDemo();

  // 4. clientb cross-tenant dataset (for the E2E tenant-isolation tests) ────────
  await seedClientBDemo();

  // 5. §A-DOMAIN client_domains routing rows (deoleo + clientb) ─────────────────
  await seedClientDomains();

  console.log('\n✅  Seed complete.');
}

// ── deoleo demo data ────────────────────────────────────────────────────────────

async function seedDeoleoDemo() {
  console.log('\n🏷️   Seeding deoleo demo dataset…');

  const demoPasswordHash = await bcrypt.hash('ChangeMeOnFirstLogin!', 12);

  // 3.0 Tenant row — clientId on every model below is just a string tag, but the
  // app reads the Client config, so make sure the tenant exists.
  const emptyJson = {} as const;
  // Deoleo's canonical operator-console config — the gifsy overview/client-detail specs assert these
  // REAL values (they used to pass only against a residue-branded dev DB; the seed now owns them so a
  // fresh gifsy_dev reproduces them). `branding` holds displayName/productBrands/supportEmail; the
  // top-level module flags drive the "N/M modules on" tally (4/5 on: referral off). Set on BOTH
  // create + update so a re-seed over an existing row is deterministic too.
  const deoleoBranding = {
    displayName: 'Deoleo India',
    primaryColor: '#0b5d3b',
    supportEmail: 'support@deoleo.gifsy.in',
    productBrands: ['Bertolli', 'Figaro'],
  } as const;
  const deoleoFeatures = {
    visibilityInvoiceModule: true,
    kycApprovalFlow: true,
    walletModule: true,
    salesTeamApp: true,
    referralModule: false, // 4/5 modules on
  } as const;
  await prisma.client.upsert({
    where: { id: DEOLEO_CLIENT_ID },
    update: { internalName: 'Deoleo India Pvt. Ltd.', branding: deoleoBranding, features: deoleoFeatures },
    create: {
      id: DEOLEO_CLIENT_ID,
      internalName: 'Deoleo India Pvt. Ltd.',
      status: 'ACTIVE',
      onboardedAt: new Date(),
      branding: deoleoBranding,
      features: deoleoFeatures,
      approvalHierarchy: emptyJson,
      notifications: emptyJson,
      invoicing: emptyJson,
      wallet: emptyJson,
    },
  });
  console.log(`   ✓ Client [${DEOLEO_CLIENT_ID}] — branding + 4/5 modules`);

  // NOTE on idempotency strategy: gifsy_dev may already hold rows from manual
  // testing that use FIXED ids (seed-cp-1, seed-w-1, …) with their own natural
  // keys. To be safe against BOTH a fresh DB and those rows, every upsert below
  // is keyed on the fixed `id` and its natural-key values match what already
  // exists. So a re-run takes the update path on the same id rather than
  // attempting a create that would collide on a natural unique.

  // 3.1 CLIENT_ADMIN user (keyed on fixed id seed-deoleo-admin).
  const clientAdmin = await prisma.user.upsert({
    where: { id: 'seed-deoleo-admin' },
    update: { name: 'Deoleo Client Admin' },
    create: {
      id: 'seed-deoleo-admin',
      clientId: DEOLEO_CLIENT_ID,
      phone: '9000000001',
      email: 'admin@deoleo.demo',
      name: 'Deoleo Client Admin',
      role: UserRole.CLIENT_ADMIN,
      status: UserStatus.ACTIVE,
      passwordHash: demoPasswordHash,
    },
  });
  console.log(`   ✓ CLIENT_ADMIN — id: ${clientAdmin.id}, phone: ${clientAdmin.phone}`);

  // 3.1b MIS_USER for deoleo — read-only tenant role (no write controls). Keyed on fixed id.
  const misUser = await prisma.user.upsert({
    where: { id: 'seed-deoleo-mis' },
    update: {},
    create: {
      id: 'seed-deoleo-mis',
      clientId: DEOLEO_CLIENT_ID,
      phone: '9000000004',
      email: 'mis@deoleo.demo',
      name: 'Deoleo MIS User',
      role: UserRole.MIS_USER,
      status: UserStatus.ACTIVE,
      passwordHash: demoPasswordHash,
    },
  });
  console.log(`   ✓ MIS_USER — id: ${misUser.id}, phone: ${misUser.phone}`);

  // 3.2 OutletType lookups (created above).
  const retailerType = await prisma.outletType.findFirstOrThrow({ where: { code: 'SSS' } });
  const wholesalerType = await prisma.outletType.findFirstOrThrow({ where: { code: 'WHOLESALER' } });

  // 3.2b Per-tenant outlet-type configs. The admin outlet-upsert maps an outlet's type CODE → id via
  // OutletTypeClientConfig; without a row per (tenant, type) every upsert fails "Unknown outlet type"
  // and nothing persists. Enable all active types for deoleo via the shared provisioning helper
  // (idempotent upsert, mirrors exactly what createClient() does at runtime).
  await provisionOutletTypeConfigs(DEOLEO_CLIENT_ID);
  console.log(`   ✓ OutletTypeClientConfig (deoleo) — enables outlet upsert`);

  // 3.3 Two channel partners, each: User → ChannelPartner → Wallet → Outlet.
  // Ids + natural keys align with the manual-test rows already in gifsy_dev.
  const partnerSpecs = [
    {
      userId: 'seed-deoleo-partner',
      partnerId: 'seed-cp-1',
      walletId: 'seed-w-1',
      outletId: 'seed-o-1',
      phone: '9000000002',
      role: UserRole.WHOLESALER,
      businessName: 'Deoleo Demo Wholesale Mart',
      ownerName: 'Ravi Kumar',
      partnerCode: 'CP001',
      outletType: wholesalerType,
      outletCode: 'O001',
      gstNumber: '19AAAAA0000A1Z5',
      panNumber: 'AAAAA0000A',
      // Give this partner a redeemable balance so redemption flows are usable.
      redeemablePoints: 50000,
      city: 'Pune',
      state: 'Maharashtra',
    },
    {
      userId: 'seed-cp-user-2',
      partnerId: 'seed-cp-2',
      walletId: 'seed-w-2',
      outletId: 'seed-o-2',
      phone: '9000000005',
      role: UserRole.SUB_STOCKIST,
      businessName: 'Deoleo Demo Retail Store',
      ownerName: 'Sunita Sharma',
      partnerCode: 'CP002',
      outletType: retailerType,
      outletCode: 'O002',
      gstNumber: '29FGHIJ5678K1Z2',
      panNumber: 'FGHIJ5678K',
      redeemablePoints: 0,
      city: 'Bengaluru',
      state: 'Karnataka',
    },
    {
      // CP004 — the APPROVED, funded, SO-assigned partner used by the sales-assisted redemption
      // money-path E2E (platform/e2e/sales/assisted-redemption-write.e2e.ts). Distinct from CP001,
      // which is deliberately KYC-PENDING (it's the KYC-flow fixture). CP004 gets an APPROVED
      // KycSubmission (seed-kyc-5) + a SalesUserAssignment (seed-sa-3) below, and its own partner
      // login (phone 9000000008 → e2e role `partnerApproved`) so the spec can read ITS wallet.
      userId: 'seed-cp-user-4',
      partnerId: 'seed-cp-4',
      walletId: 'seed-w-4',
      outletId: 'seed-o-4',
      phone: '9000000008',
      role: UserRole.WHOLESALER,
      businessName: 'Deoleo Demo Approved Wholesale',
      ownerName: 'Anil Verma',
      partnerCode: 'CP004',
      outletType: wholesalerType,
      outletCode: 'O004',
      gstNumber: '27KLMNO9012P1Z8',
      panNumber: 'KLMNO9012P',
      redeemablePoints: 50000,
      city: 'Nagpur',
      state: 'Maharashtra',
    },
  ];

  const createdPartners: { partnerId: string; outletId: string; userId: string }[] = [];

  for (const p of partnerSpecs) {
    // 3.3a Partner user (keyed on fixed id).
    const user = await prisma.user.upsert({
      where: { id: p.userId },
      // Reset the display name on re-seed so dev DBs left over from older seeds become canonical
      // (stale rows like "Test Wholesaler" otherwise survive an `update: {}` and break name asserts).
      update: { name: p.ownerName },
      create: {
        id: p.userId,
        clientId: DEOLEO_CLIENT_ID,
        phone: p.phone,
        name: p.ownerName,
        role: p.role,
        status: UserStatus.ACTIVE,
        passwordHash: demoPasswordHash,
      },
    });

    // 3.3b ChannelPartner (keyed on fixed id).
    const partner = await prisma.channelPartner.upsert({
      where: { id: p.partnerId },
      update: { businessName: p.businessName, ownerName: p.ownerName, phone: p.phone, gstNumber: p.gstNumber, panNumber: p.panNumber },
      create: {
        id: p.partnerId,
        clientId: DEOLEO_CLIENT_ID,
        userId: user.id,
        partnerCode: p.partnerCode,
        businessName: p.businessName,
        ownerName: p.ownerName,
        phone: p.phone,
        gstNumber: p.gstNumber,
        panNumber: p.panNumber,
        entityType: EntityType.FIRM,
        gstRegistrationType: GstRegistrationType.REGULAR,
        isActive: true,
        onboardedAt: new Date(),
      },
    });

    // 3.3c Wallet (keyed on fixed id). Don't clobber balances on re-run; only
    // set them on create.
    await prisma.wallet.upsert({
      where: { id: p.walletId },
      update: {},
      create: {
        id: p.walletId,
        partnerId: partner.id,
        earnedPoints: p.redeemablePoints,
        redeemablePoints: p.redeemablePoints,
        lifetimeEarned: p.redeemablePoints,
        lastTransactionAt: p.redeemablePoints > 0 ? new Date() : null,
      },
    });

    // 3.3d Outlet (keyed on fixed id).
    const outlet = await prisma.outlet.upsert({
      where: { id: p.outletId },
      update: { name: p.businessName, ownerName: p.ownerName, city: p.city, state: p.state },
      create: {
        id: p.outletId,
        clientId: DEOLEO_CLIENT_ID,
        partnerId: partner.id,
        outletTypeId: p.outletType.id,
        outletCode: p.outletCode,
        name: p.businessName,
        ownerName: p.ownerName,
        phone: p.phone,
        city: p.city,
        state: p.state,
        isActive: true,
        isPrimary: true,
      },
    });

    createdPartners.push({ partnerId: partner.id, outletId: outlet.id, userId: user.id });
    console.log(`   ✓ Partner ${p.partnerCode} (${p.role}) + wallet + outlet ${p.outletCode}`);
  }

  // 3.4 Sales hierarchy levels + SalesUsers with manager→SO downline.

  // Level 1 — SO (front-line sales officer).
  const hierarchyLevel = await prisma.salesHierarchyLevel.upsert({
    where: { id: 'seed-hl-1' },
    update: {},
    create: {
      id: 'seed-hl-1',
      clientId: DEOLEO_CLIENT_ID,
      code: 'SO',
      name: 'Sales Officer',
      level: 1,
      description: 'Front-line sales officer',
    },
  });
  console.log(`   ✓ SalesHierarchyLevel [${hierarchyLevel.code}]`);

  // Level 2 — ASM (area sales manager). The SO reports to this level, giving
  // /sales/team* a real roll-up hierarchy for the salesManager E2E role.
  const hierarchyLevelAsm = await prisma.salesHierarchyLevel.upsert({
    where: { id: 'seed-hl-2' },
    update: {},
    create: {
      id: 'seed-hl-2',
      clientId: DEOLEO_CLIENT_ID,
      code: 'ASM',
      name: 'Area Sales Manager',
      level: 2,
      description: 'Area sales manager',
    },
  });
  console.log(`   ✓ SalesHierarchyLevel [${hierarchyLevelAsm.code}]`);

  // Manager User account (SALES_ASM).
  const salesMgrAccount = await prisma.user.upsert({
    where: { id: 'seed-deoleo-sales-mgr' },
    update: {},
    create: {
      id: 'seed-deoleo-sales-mgr',
      clientId: DEOLEO_CLIENT_ID,
      phone: '9000000006',
      name: 'Demo Area Sales Manager',
      role: UserRole.SALES_ASM,
      status: UserStatus.ACTIVE,
      passwordHash: demoPasswordHash,
    },
  });

  // Manager SalesUser — no reportingToId (top of this demo hierarchy).
  // MUST be created before the SO so the SO's FK reference resolves.
  const salesMgr = await prisma.salesUser.upsert({
    where: { id: 'seed-su-mgr' },
    update: {},
    create: {
      id: 'seed-su-mgr',
      clientId: DEOLEO_CLIENT_ID,
      userId: salesMgrAccount.id,
      hierarchyLevelId: hierarchyLevelAsm.id,
      employeeCode: 'EMPASM1',
      reportingToId: null,
      region: 'West',
      zone: 'Pune',
      isActive: true,
    },
  });
  console.log(`   ✓ SalesUser (ASM) ${salesMgr.employeeCode}`);

  // SO User account.
  const salesUserAccount = await prisma.user.upsert({
    where: { id: 'seed-deoleo-sales' },
    update: { name: 'Demo Sales Officer' },
    create: {
      id: 'seed-deoleo-sales',
      clientId: DEOLEO_CLIENT_ID,
      phone: '9000000003',
      name: 'Demo Sales Officer',
      role: UserRole.SALES_SO,
      status: UserStatus.ACTIVE,
      passwordHash: demoPasswordHash,
    },
  });

  // SO SalesUser — reports to the ASM manager. The update path backfills
  // reportingToId on existing dev DBs so re-runs are idempotent.
  const salesUser = await prisma.salesUser.upsert({
    where: { id: 'seed-su-1' },
    update: { reportingToId: salesMgr.id },
    create: {
      id: 'seed-su-1',
      clientId: DEOLEO_CLIENT_ID,
      userId: salesUserAccount.id,
      hierarchyLevelId: hierarchyLevel.id,
      employeeCode: 'EMP001',
      reportingToId: salesMgr.id,
      region: 'West',
      zone: 'Pune',
      isActive: true,
    },
  });
  console.log(`   ✓ SalesUser (SO) ${salesUser.employeeCode} → reports to ${salesMgr.employeeCode}`);

  // 3.4 (snapshot) — upsert the `employee_hierarchy` ProgramSetting so that
  // GET /v1/admin/hierarchy-config returns employees instead of [].
  // This mirrors EXACTLY what the real PUT saveHierarchyConfig writes:
  // one HierarchyEmployee entry per seeded SalesUser, with the relationships
  // that have just been established above.
  const hierarchySnapshot = [
    {
      id: salesMgr.employeeCode,          // 'EMPASM1'
      tenantId: DEOLEO_CLIENT_ID,
      roleCode: 'ASM',
      roleLabel: 'ASM',
      reportsToId: null,
      name: 'Demo Area Sales Manager',
      mobile: '9000000006',
      status: 'ACTIVE',
      hasOutlets: false,
      hasSubReports: true,
    },
    {
      id: salesUser.employeeCode,         // 'EMP001'
      tenantId: DEOLEO_CLIENT_ID,
      roleCode: 'SO',
      roleLabel: 'SO',
      reportsToId: salesMgr.employeeCode, // 'EMPASM1'
      name: 'Demo Sales Officer',
      mobile: '9000000003',
      status: 'ACTIVE',
      hasOutlets: true,
      hasSubReports: false,
    },
  ];

  await prisma.programSetting.upsert({
    where: { clientId_settingKey: { clientId: DEOLEO_CLIENT_ID, settingKey: 'employee_hierarchy' } },
    update: { settingValue: hierarchySnapshot },
    create: {
      clientId: DEOLEO_CLIENT_ID,
      settingKey: 'employee_hierarchy',
      settingValue: hierarchySnapshot,
    },
  });
  console.log(`   ✓ ProgramSetting [employee_hierarchy] — ${hierarchySnapshot.length} employees (EMPASM1, EMP001)`);

  // Enable the Visibility module for BOTH test tenants so the E2E harness can exercise the visibility
  // flows (admin bulk-upload, partner photo submit, cross-tenant isolation). The gate is
  // TenantSettings.getVisibilityEnabledUncached → programSetting `visibilityEnabled` === true (default
  // OFF; PROD Deoleo launches OFF). This is gifsy_dev TEST DATA only — the seed never runs on
  // staging/prod, so it does not change any real tenant's posture. Without it the visibility specs 403
  // with "Visibility is not enabled for this tenant." See platform/e2e {partner,clientAdmin,clientbAdmin} visibility specs.
  for (const cid of [DEOLEO_CLIENT_ID, CLIENTB_CLIENT_ID]) {
    await prisma.programSetting.upsert({
      where: { clientId_settingKey: { clientId: cid, settingKey: 'visibilityEnabled' } },
      update: { settingValue: true },
      create: { clientId: cid, settingKey: 'visibilityEnabled', settingValue: true },
    });
  }
  console.log('   ✓ ProgramSetting [visibilityEnabled=true] for deoleo + clientb (E2E visibility flows)');

  // 3.4a Assign the SO to the first partner's outlet (CP001 / O001).
  const firstOutletId = createdPartners[0]?.outletId;
  const firstPartnerId = createdPartners[0]?.partnerId;
  if (firstOutletId && firstPartnerId) {
    await prisma.salesUserAssignment.upsert({
      where: { id: 'seed-sa-1' },
      update: {},
      create: {
        id: 'seed-sa-1',
        salesUserId: salesUser.id,
        partnerId: firstPartnerId,
        outletId: firstOutletId,
        notes: 'Demo seed assignment',
      },
    });
    console.log(`   ✓ SalesUserAssignment → outlet ${firstOutletId}`);
  }

  // 3.4b Assign the SO to a SECOND outlet (CP002 / O002) so the downline
  // roll-up on /sales/team* has non-trivial data.
  const secondOutletId = createdPartners[1]?.outletId;
  const secondPartnerId = createdPartners[1]?.partnerId;
  if (secondOutletId && secondPartnerId) {
    await prisma.salesUserAssignment.upsert({
      where: { id: 'seed-sa-2' },
      update: {},
      create: {
        id: 'seed-sa-2',
        salesUserId: salesUser.id,
        partnerId: secondPartnerId,
        outletId: secondOutletId,
        notes: 'Demo seed assignment (2nd outlet)',
      },
    });
    console.log(`   ✓ SalesUserAssignment (2nd) → outlet ${secondOutletId}`);
  }

  // 3.4b-cp4 Assign the SO to CP004 / O004 (the APPROVED, funded outlet) + give it an APPROVED KYC so
  // the sales-assisted redemption money-path E2E has an eligible target (confirm-redeem gates on
  // KYC-APPROVED, owner decision 2026-06-27). CP004 is createdPartners[2] (the 3rd partnerSpecs entry).
  const cp4 = createdPartners[2];
  if (cp4) {
    await prisma.salesUserAssignment.upsert({
      where: { id: 'seed-sa-3' },
      update: {},
      create: {
        id: 'seed-sa-3',
        salesUserId: salesUser.id,
        partnerId: cp4.partnerId,
        outletId: cp4.outletId,
        notes: 'Demo seed assignment (approved outlet for assisted redemption)',
      },
    });
    await prisma.kycSubmission.upsert({
      where: { id: 'seed-kyc-5' },
      update: { status: KycStatus.APPROVED },
      create: {
        id: 'seed-kyc-5',
        userId: cp4.userId,
        partnerId: cp4.partnerId,
        status: KycStatus.APPROVED,
        submittedAt: new Date('2026-05-01'),
      },
    });
    console.log('   ✓ SalesUserAssignment (3rd, CP004/O004) + APPROVED KycSubmission seed-kyc-5');
  }

  // 3.4c Partner-raised support ticket — gives /admin/tickets a real row and
  // provides the target for the W13 admin-reply write-persistence spec.
  await prisma.ticket.upsert({
    where: { id: 'seed-ticket-1' },
    update: {},
    create: {
      id: 'seed-ticket-1',
      clientId: DEOLEO_CLIENT_ID,
      ticketNumber: 'DEO-0001',
      createdById: 'seed-deoleo-partner',
      category: TicketCategory.PAYOUT,
      subject: 'Payout not received for April',
      description: 'Demo seed ticket: partner reports a pending payout for the April cycle.',
    },
  });
  console.log('   ✓ Ticket [DEO-0001] (PAYOUT) — seed-deoleo-partner → admin tickets queue');

  // 3.5 Reward catalog: one category + two reward items.
  // RewardCategory has no natural unique → upsert on a fixed id.
  const rewardCategory = await prisma.rewardCategory.upsert({
    where: { id: 'seed-rcat-1' },
    update: {},
    create: {
      id: 'seed-rcat-1',
      clientId: DEOLEO_CLIENT_ID,
      code: 'VOUCHERS',
      name: 'Gift Vouchers',
      description: 'Demo reward category — gift vouchers',
      sortOrder: 1,
      isActive: true,
    },
  });
  console.log(`   ✓ RewardCategory [${rewardCategory.code}]`);

  const rewardSpecs = [
    {
      id: 'seed-rk-1',
      code: 'RW001',
      name: 'Amazon Voucher ₹500',
      pointsCost: 500,
      mrpPaise: 50000,
      redemptionMode: PayoutMode.GIFT_CARD,
      stockQuantity: 100,
    },
    {
      id: 'seed-rk-2',
      code: 'RW002',
      name: 'UPI Cashback ₹1000',
      pointsCost: 1000,
      mrpPaise: 100000,
      redemptionMode: PayoutMode.UPI,
      stockQuantity: null,
    },
  ];

  for (const r of rewardSpecs) {
    // RewardCatalog has no natural unique → upsert on a fixed id.
    const reward = await prisma.rewardCatalog.upsert({
      where: { id: r.id },
      update: {},
      create: {
        id: r.id,
        clientId: DEOLEO_CLIENT_ID,
        categoryId: rewardCategory.id,
        code: r.code,
        name: r.name,
        description: `Demo reward — ${r.name}`,
        pointsCost: r.pointsCost,
        mrpPaise: r.mrpPaise,
        redemptionMode: r.redemptionMode,
        status: RewardCatalogStatus.ACTIVE,
        stockQuantity: r.stockQuantity,
      },
    });
    console.log(`   ✓ RewardCatalog [${reward.code}] — ${reward.pointsCost} pts`);
  }

  // 3.6 Pending KYC submissions — one per partner, in a pending review state.
  // Keyed on fixed id so re-runs hit the update path.
  const kycSpecs = [
    { id: 'seed-kyc-1', idx: 0, status: KycStatus.PENDING_GIFSY },
    { id: 'seed-kyc-2', idx: 1, status: KycStatus.UNDER_REVIEW },
  ];

  for (const k of kycSpecs) {
    const cp = createdPartners[k.idx];
    if (!cp) continue;
    await prisma.kycSubmission.upsert({
      where: { id: k.id },
      update: {},
      create: {
        id: k.id,
        userId: cp.userId,
        partnerId: cp.partnerId,
        status: k.status,
        submittedAt: new Date(),
      },
    });
    console.log(`   ✓ KycSubmission ${k.id} (${k.status})`);
  }

  // 3.7 Visibility program — one ACTIVE program so the partner photo-submit flow
  // (POST /v1/visibility/submit) has a valid target. Keyed on fixed id seed-vp-1.
  const visibilityProgram = await prisma.visibilityProgram.upsert({
    where: { id: 'seed-vp-1' },
    update: {},
    create: {
      id: 'seed-vp-1',
      clientId: DEOLEO_CLIENT_ID,
      code: 'VP001',
      name: 'Storefront Branding — Q1',
      description: 'Demo visibility program — submit a storefront branding photo.',
      status: VisibilityProgramStatus.ACTIVE,
      startDate: new Date('2026-01-01'),
      endDate: new Date('2026-12-31'),
      pointsPerSubmission: 200,
    },
  });
  console.log(`   ✓ VisibilityProgram [${visibilityProgram.code}] (${visibilityProgram.status})`);

  // 3.8 Populated-path source data (B2 invoices · #53 enrollment). A THIRD partner with
  // APPROVED KYC + PAN + bank (invoice generation requires an approved-KYC partner), a
  // separate-payout CreditField, a CreditBatch + CreditPayoutEntry for 2026-05 (so
  // POST /admin/invoices/generate produces a real invoice), and one ACTIVE scheme (a real
  // sales-assisted enrollment target). All keyed on fixed ids → idempotent on re-run.
  const distUser = await prisma.user.upsert({
    where: { id: 'seed-deoleo-partner-3' },
    update: {},
    create: {
      id: 'seed-deoleo-partner-3',
      clientId: DEOLEO_CLIENT_ID,
      phone: '9000000007',
      name: 'Meena Iyer',
      role: UserRole.WHOLESALER,
      status: UserStatus.ACTIVE,
      passwordHash: demoPasswordHash,
    },
  });
  const distPartner = await prisma.channelPartner.upsert({
    where: { id: 'seed-cp-3' },
    update: {},
    create: {
      id: 'seed-cp-3',
      clientId: DEOLEO_CLIENT_ID,
      userId: distUser.id,
      partnerCode: 'CP003',
      businessName: 'Deoleo Demo Distributor',
      ownerName: 'Meena Iyer',
      phone: '9000000007',
      gstNumber: '27KLMNO9012P1Z3', // Maharashtra (27) ≠ Tech Gifsy WB (19) → IGST invoice
      panNumber: 'KLMNO9012P',
      entityType: EntityType.FIRM,
      gstRegistrationType: GstRegistrationType.REGULAR,
      bankName: 'HDFC Bank',
      bankAccountNumber: '50100123456789',
      bankAccountHolder: 'Deoleo Demo Distributor',
      ifscCode: 'HDFC0000123',
      isActive: true,
      onboardedAt: new Date(),
    },
  });
  await prisma.wallet.upsert({
    where: { id: 'seed-w-3' },
    update: {},
    create: { id: 'seed-w-3', partnerId: distPartner.id, earnedPoints: 0, redeemablePoints: 0, lifetimeEarned: 0 },
  });
  await prisma.outlet.upsert({
    where: { id: 'seed-o-3' },
    update: {},
    create: {
      id: 'seed-o-3',
      clientId: DEOLEO_CLIENT_ID,
      partnerId: distPartner.id,
      outletTypeId: wholesalerType.id,
      outletCode: 'O003',
      name: 'Deoleo Demo Distributor',
      ownerName: 'Meena Iyer',
      phone: '9000000007',
      city: 'Mumbai',
      state: 'Maharashtra',
      isActive: true,
      isPrimary: true,
    },
  });
  // APPROVED KYC — the only deoleo partner past KYC (so invoice generation has an eligible outlet).
  await prisma.kycSubmission.upsert({
    where: { id: 'seed-kyc-3' },
    update: {},
    create: {
      id: 'seed-kyc-3',
      userId: distUser.id,
      partnerId: distPartner.id,
      status: KycStatus.APPROVED,
      submittedAt: new Date('2026-05-01'),
    },
  });
  // Separate-payout credit field → the source generateForPeriod reads.
  const visField = await prisma.creditField.upsert({
    where: { id: 'seed-cf-vis' },
    update: {},
    create: {
      id: 'seed-cf-vis',
      clientId: DEOLEO_CLIENT_ID,
      name: 'Visibility Spend',
      isActive: true,
      isSeparatePayout: true,
      outletTypeAwards: {},
      order: 1,
    },
  });
  const creditBatch = await prisma.creditBatch.upsert({
    where: { id: 'seed-cb-1' },
    update: {},
    create: {
      id: 'seed-cb-1',
      clientId: DEOLEO_CLIENT_ID,
      batchCode: 'CB-2026-05',
      period: '2026-05',
      status: 'CONFIRMED',
      uploadedBy: clientAdmin.id,
      uploadedAt: new Date('2026-05-31'),
      totalOutlets: 1,
      totalPoints: 0,
      totalPayoutPaise: 500000n,
      rows: [],
    },
  });
  // CreditPayoutEntry — outletId stores the OUTLET CODE (per generateForPeriod). ₹5,000 for O003.
  await prisma.creditPayoutEntry.upsert({
    where: { id: 'seed-cpe-1' },
    update: {},
    create: {
      id: 'seed-cpe-1',
      clientId: DEOLEO_CLIENT_ID,
      batchId: creditBatch.id,
      outletId: 'O003',
      outletName: 'Deoleo Demo Distributor',
      fieldId: visField.id,
      fieldName: visField.name,
      period: '2026-05',
      amountPaise: 500000n,
      narration: 'Visibility payout — May 2026',
      status: 'PENDING',
    },
  });
  console.log('   ✓ Invoice source: CP003 (APPROVED KYC) + Visibility Spend field + CB-2026-05 (₹5,000 / O003)');

  // ACTIVE scheme (wide fixed window → enrollable regardless of server clock) — sales-assisted
  // enrollment (#53) + B1 target.
  await prisma.scheme.upsert({
    where: { id: 'seed-scheme-1' },
    update: {},
    create: {
      id: 'seed-scheme-1',
      clientId: DEOLEO_CLIENT_ID,
      code: 'DEMO-VIS',
      name: 'Demo Visibility Scheme',
      description: 'Demo ACTIVE scheme — sales-assisted enrollment target.',
      schemeType: 'PURCHASE_INCENTIVE',
      status: 'ACTIVE',
      startDate: new Date('2020-01-01'),
      endDate: new Date('2030-12-31'),
      holdingPeriodDays: 0,
      rewardType: 'POINTS',
      spentPaise: 0,
      isStackable: false,
      priority: 1,
    },
  });
  console.log('   ✓ Scheme [DEMO-VIS] (ACTIVE) — sales-assisted enrollment target');

  // 3.9 KYC awaiting SO first-approval (W5 stage-1 E2E target). The SO (seed-su-1) is assigned to
  // CP001's outlet; first-approve gates on role+status, so a deoleo PENDING_SO_APPROVAL row lets the
  // sales first-approve flow run (not just skip). The update path RESETS the status so a re-seed
  // re-arms the test after a prior run advanced it to PENDING_GIFSY.
  const cp1 = createdPartners[0];
  if (cp1) {
    await prisma.kycSubmission.upsert({
      where: { id: 'seed-kyc-4' },
      update: { status: KycStatus.PENDING_SO_APPROVAL },
      create: {
        id: 'seed-kyc-4',
        userId: cp1.userId,
        partnerId: cp1.partnerId,
        status: KycStatus.PENDING_SO_APPROVAL,
        submittedAt: new Date(),
      },
    });
    console.log('   ✓ KycSubmission seed-kyc-4 (PENDING_SO_APPROVAL) — sales first-approve target');
  }

  // 3.10 Payout pipeline (W9 — the REAL INR-disbursement money path, #42). A FundLedger receipt
  // (sufficient balance), a DRAFT PayoutBatch with one PENDING transaction for the APPROVED
  // distributor partner (seed-cp-3) — the GLB-1 eligibility gate (payouts.service processBatch)
  // SKIPS any txn whose partner's effective KYC ≠ APPROVED, so the disbursement fixture MUST use an
  // approved partner (seed-cp-1/2 are intentionally KYC-pending). The txn also carries beneficiary
  // fields (GLM-3). The update paths RESET status (batch→DRAFT, txn→PENDING) AND re-pin partnerId so
  // a re-seed re-arms the process test after a prior run flipped them to SUBMITTED/INITIATED.
  await prisma.fundLedger.upsert({
    where: { id: 'seed-fl-1' },
    update: { balancePaise: 10_000_000n },
    create: {
      id: 'seed-fl-1',
      clientId: DEOLEO_CLIENT_ID,
      ledgerType: FundLedgerType.RECEIPT,
      amountPaise: 10_000_000n,
      balancePaise: 10_000_000n, // ₹1,00,000 — covers the seeded payout
      description: 'Demo seed fund receipt (payout coverage)',
    },
  });
  await prisma.payoutBatch.upsert({
    where: { id: 'seed-pb-1' },
    update: { status: PayoutBatchStatus.DRAFT, processedAt: null },
    create: {
      id: 'seed-pb-1',
      clientId: DEOLEO_CLIENT_ID,
      batchCode: 'PB-2026-05',
      status: PayoutBatchStatus.DRAFT,
      payoutMode: PayoutMode.BANK_TRANSFER,
      totalAmountPaise: 500_000n,
      transactionCount: 1,
    },
  });
  await prisma.payoutTransaction.upsert({
    where: { id: 'seed-pt-1' },
    update: { status: PayoutStatus.PENDING, batchId: 'seed-pb-1', initiatedAt: null, partnerId: distPartner.id },
    create: {
      id: 'seed-pt-1',
      batchId: 'seed-pb-1',
      partnerId: distPartner.id,
      payoutMode: PayoutMode.BANK_TRANSFER,
      status: PayoutStatus.PENDING,
      amountPaise: 500_000n, // ₹5,000
      netAmountPaise: 500_000n,
      beneficiaryName: 'Ravi Kumar',
      bankAccountNumber: '000111222333',
      ifscCode: 'HDFC0000001',
      bankName: 'HDFC Bank',
    },
  });
  await prisma.payoutBatch.upsert({
    where: { id: 'seed-pb-2' },
    update: { status: PayoutBatchStatus.COMPLETED },
    create: {
      id: 'seed-pb-2',
      clientId: DEOLEO_CLIENT_ID,
      batchCode: 'PB-2026-04',
      status: PayoutBatchStatus.COMPLETED, // non-processable → claim-guard rejection target
      payoutMode: PayoutMode.BANK_TRANSFER,
      totalAmountPaise: 0n,
      transactionCount: 0,
    },
  });
  console.log('   ✓ Payout pipeline: FundLedger + DRAFT PayoutBatch PB-2026-05 (1 PENDING txn) + COMPLETED PB-2026-04');

  console.log('   ✅ deoleo demo dataset ready.');
}

// ── clientb cross-tenant data ────────────────────────────────────────────────
// A minimal SECOND tenant with DISTINCTIVE names ("Zenith Trading Co" / "Bharat
// Verma" / CPB001 / OB001). The E2E harness asserts a logged-in deoleo user
// NEVER sees any of these — i.e. the backend's clientId scoping actually holds.
async function seedClientBDemo() {
  console.log('\n🏷️   Seeding clientb cross-tenant dataset…');
  const demoPasswordHash = await bcrypt.hash('ChangeMeOnFirstLogin!', 12);
  const emptyJson = {} as const;

  // §A-DOMAIN P6: clientb is a DB-provisioned SECOND tenant. Give it DISTINCTIVE
  // DB branding (values that differ from the CLIENT_REGISTRY.clientb config) so the
  // `GET /v1/tenants/routing` E2E can prove the branding came from the DB, not the
  // code registry. Set on BOTH create + update so a re-seed against an existing
  // gifsy_dev makes the routing-endpoint precondition deterministic.
  const clientbDbBranding = {
    displayName: 'Zenith Rewards (DB)',
    primaryColor: '#7c3aed',
  } as const;
  // clientb is the SECOND tenant mid-onboarding — status ONBOARDING (login still admits it,
  // configure-before-activate) with 3/5 modules on, so the operator overview shows "1 active, 1
  // onboarding" + a "3/5 modules on" card. Set on create + update for a deterministic re-seed.
  const clientbFeatures = {
    visibilityInvoiceModule: true,
    kycApprovalFlow: true,
    walletModule: true, // 3/5 modules on (salesTeamApp + referralModule off)
  } as const;
  await prisma.client.upsert({
    where: { id: CLIENTB_CLIENT_ID },
    update: { branding: clientbDbBranding, status: 'ONBOARDING', features: clientbFeatures },
    create: {
      id: CLIENTB_CLIENT_ID,
      internalName: 'Client B (Demo)',
      status: 'ONBOARDING',
      onboardedAt: new Date(),
      branding: clientbDbBranding,
      features: clientbFeatures,
      approvalHierarchy: emptyJson,
      notifications: emptyJson,
      invoicing: emptyJson,
      wallet: emptyJson,
    },
  });

  const clientAdmin = await prisma.user.upsert({
    where: { id: 'seed-clientb-admin' },
    update: {},
    create: {
      id: 'seed-clientb-admin',
      clientId: CLIENTB_CLIENT_ID,
      phone: '9000000020',
      email: 'admin@clientb.demo',
      name: 'Client B Admin',
      role: UserRole.CLIENT_ADMIN,
      status: UserStatus.ACTIVE,
      passwordHash: demoPasswordHash,
    },
  });

  const wholesalerType = await prisma.outletType.findFirstOrThrow({ where: { code: 'WHOLESALER' } });

  const user = await prisma.user.upsert({
    where: { id: 'seed-clientb-partner' },
    update: {},
    create: {
      id: 'seed-clientb-partner',
      clientId: CLIENTB_CLIENT_ID,
      phone: '9000000021',
      name: 'Bharat Verma',
      role: UserRole.WHOLESALER,
      status: UserStatus.ACTIVE,
      passwordHash: demoPasswordHash,
    },
  });

  const partner = await prisma.channelPartner.upsert({
    where: { id: 'seed-cpb-1' },
    update: {},
    create: {
      id: 'seed-cpb-1',
      clientId: CLIENTB_CLIENT_ID,
      userId: user.id,
      partnerCode: 'CPB001',
      businessName: 'Zenith Trading Co',
      ownerName: 'Bharat Verma',
      phone: '9000000021',
      gstNumber: '24ZENIT1234Z1Z9',
      panNumber: 'ZENIT1234Z',
      entityType: EntityType.FIRM,
      gstRegistrationType: GstRegistrationType.REGULAR,
      isActive: true,
      onboardedAt: new Date(),
    },
  });

  await prisma.wallet.upsert({
    where: { id: 'seed-wb-1' },
    update: {},
    create: {
      id: 'seed-wb-1',
      partnerId: partner.id,
      earnedPoints: 12345,
      redeemablePoints: 12345,
      lifetimeEarned: 12345,
      lastTransactionAt: new Date(),
    },
  });

  await prisma.outlet.upsert({
    where: { id: 'seed-ob-1' },
    update: {},
    create: {
      id: 'seed-ob-1',
      clientId: CLIENTB_CLIENT_ID,
      partnerId: partner.id,
      outletTypeId: wholesalerType.id,
      outletCode: 'OB001',
      name: 'Zenith Trading Co',
      ownerName: 'Bharat Verma',
      phone: '9000000021',
      city: 'Surat',
      state: 'Gujarat',
      isActive: true,
      isPrimary: true,
    },
  });

  // A PENDING_GIFSY KYC so the Gifsy cross-tenant review queue has >1 brand
  // (proves #38: the operator sees deoleo's seed-kyc-1 AND clientb's seed-kyc-b1).
  await prisma.kycSubmission.upsert({
    where: { id: 'seed-kyc-b1' },
    update: {},
    create: {
      id: 'seed-kyc-b1',
      userId: user.id,
      partnerId: partner.id,
      status: KycStatus.PENDING_GIFSY,
      submittedAt: new Date(),
    },
  });

  // Outlet-type configs for clientb — same provisioning as deoleo so the
  // cross-tenant harness can upsert outlets without "Unknown outlet type".
  await provisionOutletTypeConfigs(CLIENTB_CLIENT_ID);

  console.log(
    `   ✓ clientb: admin ${clientAdmin.phone} + partner CPB001 (Zenith Trading Co) + wallet + outlet OB001 + PENDING_GIFSY KYC`,
  );
  console.log('   ✅ clientb cross-tenant dataset ready.');
}

// ── §A-DOMAIN client_domains routing rows ─────────────────────────────────────
// The `client_domains` table drives the DB-backed domain→slug resolver (P2) and
// is served by `GET /v1/tenants/routing`. The Phase-0 backfill migration inserts
// these on a DB that ALREADY has the tenants; on a fresh local/CI DB, migrations
// run BEFORE this seed (empty `clients` table → backfill inserts nothing), so we
// seed the routing rows explicitly here to make the routing endpoint deterministic
// locally — matching the values staging/prod hold post-backfill.
//
//   deoleo  → deoleoloyalty.gifsy.in (PRIMARY, branded: label ≠ slug), deoleo.gifsy.in
//   clientb → zenithrewards.gifsy.in (PRIMARY, branded: label ≠ slug, NOT in the code
//             registry — proves DB-only routing), clientb.gifsy.in
//
// Idempotent: each row is upserted on a fixed id. LOWER(domain) is globally unique
// (expression index), so the domains never collide across tenants.
async function seedClientDomains() {
  console.log('\n🌐  Seeding §A-DOMAIN client_domains routing rows…');
  const rows: { id: string; clientId: string; domain: string; isPrimary: boolean }[] = [
    { id: 'seed-dom-deoleo-1', clientId: DEOLEO_CLIENT_ID, domain: 'deoleoloyalty.gifsy.in', isPrimary: true },
    { id: 'seed-dom-deoleo-2', clientId: DEOLEO_CLIENT_ID, domain: 'deoleo.gifsy.in', isPrimary: false },
    { id: 'seed-dom-clientb-1', clientId: CLIENTB_CLIENT_ID, domain: 'zenithrewards.gifsy.in', isPrimary: true },
    { id: 'seed-dom-clientb-2', clientId: CLIENTB_CLIENT_ID, domain: 'clientb.gifsy.in', isPrimary: false },
  ];
  for (const r of rows) {
    await prisma.clientDomain.upsert({
      where: { id: r.id },
      update: { clientId: r.clientId, domain: r.domain, isPrimary: r.isPrimary },
      create: r,
    });
  }
  console.log(
    '   ✓ domains: deoleo→[deoleoloyalty.gifsy.in, deoleo.gifsy.in], clientb→[zenithrewards.gifsy.in, clientb.gifsy.in]',
  );
}

main()
  .catch((e) => {
    console.error('❌  Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
