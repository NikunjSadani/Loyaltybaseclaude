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
  RewardCatalogStatus,
  VisibilityProgramStatus,
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
  { code: 'RETAILER',     name: 'Retailer',     description: 'Retail channel partner' },
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
  if (dbName !== 'gifsy_dev') {
    throw new Error(
      `🚫  Refusing to seed: connected database is "${dbName}", expected "gifsy_dev". ` +
        `This seed only runs against the dev database. Check DATABASE_URL.`,
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

  console.log('\n✅  Seed complete.');
}

// ── deoleo demo data ────────────────────────────────────────────────────────────

async function seedDeoleoDemo() {
  console.log('\n🏷️   Seeding deoleo demo dataset…');

  const demoPasswordHash = await bcrypt.hash('ChangeMeOnFirstLogin!', 12);

  // 3.0 Tenant row — clientId on every model below is just a string tag, but the
  // app reads the Client config, so make sure the tenant exists.
  const emptyJson = {} as const;
  await prisma.client.upsert({
    where: { id: DEOLEO_CLIENT_ID },
    update: {},
    create: {
      id: DEOLEO_CLIENT_ID,
      internalName: 'Deoleo (Demo)',
      status: 'ACTIVE',
      onboardedAt: new Date(),
      branding: emptyJson,
      features: emptyJson,
      approvalHierarchy: emptyJson,
      notifications: emptyJson,
      invoicing: emptyJson,
      wallet: emptyJson,
    },
  });
  console.log(`   ✓ Client [${DEOLEO_CLIENT_ID}]`);

  // NOTE on idempotency strategy: gifsy_dev may already hold rows from manual
  // testing that use FIXED ids (seed-cp-1, seed-w-1, …) with their own natural
  // keys. To be safe against BOTH a fresh DB and those rows, every upsert below
  // is keyed on the fixed `id` and its natural-key values match what already
  // exists. So a re-run takes the update path on the same id rather than
  // attempting a create that would collide on a natural unique.

  // 3.1 CLIENT_ADMIN user (keyed on fixed id seed-deoleo-admin).
  const clientAdmin = await prisma.user.upsert({
    where: { id: 'seed-deoleo-admin' },
    update: {},
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

  // 3.2 OutletType lookups (created above).
  const retailerType = await prisma.outletType.findFirstOrThrow({ where: { code: 'RETAILER' } });
  const wholesalerType = await prisma.outletType.findFirstOrThrow({ where: { code: 'WHOLESALER' } });

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
  ];

  const createdPartners: { partnerId: string; outletId: string; userId: string }[] = [];

  for (const p of partnerSpecs) {
    // 3.3a Partner user (keyed on fixed id).
    const user = await prisma.user.upsert({
      where: { id: p.userId },
      update: {},
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
      update: {},
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
      update: {},
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

  // 3.4 Sales hierarchy level + SalesUser assigned to the first outlet.
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

  const salesUserAccount = await prisma.user.upsert({
    where: { id: 'seed-deoleo-sales' },
    update: {},
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

  const salesUser = await prisma.salesUser.upsert({
    where: { id: 'seed-su-1' },
    update: {},
    create: {
      id: 'seed-su-1',
      clientId: DEOLEO_CLIENT_ID,
      userId: salesUserAccount.id,
      hierarchyLevelId: hierarchyLevel.id,
      employeeCode: 'EMP001',
      region: 'West',
      zone: 'Pune',
      isActive: true,
    },
  });
  console.log(`   ✓ SalesUser ${salesUser.employeeCode}`);

  // 3.4a Assign the sales user to the first partner's outlet (keyed on fixed id
  // seed-sa-1).
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

  await prisma.client.upsert({
    where: { id: CLIENTB_CLIENT_ID },
    update: {},
    create: {
      id: CLIENTB_CLIENT_ID,
      internalName: 'Client B (Demo)',
      status: 'ACTIVE',
      onboardedAt: new Date(),
      branding: emptyJson,
      features: emptyJson,
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

  console.log(
    `   ✓ clientb: admin ${clientAdmin.phone} + partner CPB001 (Zenith Trading Co) + wallet + outlet OB001 + PENDING_GIFSY KYC`,
  );
  console.log('   ✅ clientb cross-tenant dataset ready.');
}

main()
  .catch((e) => {
    console.error('❌  Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
