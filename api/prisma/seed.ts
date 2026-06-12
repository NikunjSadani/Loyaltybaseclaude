/**
 * Seed script — platform bootstrap data only.
 *
 * Scope of this seed:
 *   1. GIFSY_ADMIN user  — the platform super-admin account.
 *   2. OutletType rows   — the global master list (Retailer, Wholesaler,
 *                          Sub-Stockist, SSS TOT). Names and codes can be
 *                          updated later via a migration; the @unique code
 *                          is the stable identifier.
 *
 * Everything else (clients, partner classes, tiers, schemes, targets) is
 * configured by CLIENT_ADMIN through the UI after a tenant is onboarded.
 *
 * Run:
 *   npx prisma db seed
 *   -- or --
 *   GIFSY_ADMIN_PHONE=9999999999 npx prisma db seed
 */

import 'dotenv/config';
import { PrismaClient, UserRole, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

// ── Config ────────────────────────────────────────────────────────────────────

const GIFSY_CLIENT_ID    = 'gifsy';
const GIFSY_ADMIN_PHONE  = process.env['GIFSY_ADMIN_PHONE'] ?? '9830011252';
const GIFSY_ADMIN_NAME   = process.env['GIFSY_ADMIN_NAME']  ?? 'Gifsy Super Admin';

// OutletType master list. code is the stable key — name is the display label
// and can be changed at any time without touching code or migrations.
const OUTLET_TYPES = [
  { code: 'RETAILER',     name: 'Retailer',     description: 'Retail channel partner' },
  { code: 'WHOLESALER',   name: 'Wholesaler',   description: 'Wholesale channel partner' },
  { code: 'SUB_STOCKIST', name: 'Sub-Stockist', description: 'Sub-stockist channel partner' },
  { code: 'SSS_TOT',      name: 'SSS TOT',      description: 'Super stockist / TOT channel partner' },
] as const;

// ── Seed ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🌱  Starting seed…');

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
  // upsert on code (the @unique stable key). name and description can be
  // updated by re-running the seed or via the admin UI.
  for (const ot of OUTLET_TYPES) {
    const result = await prisma.outletType.upsert({
      where:  { code: ot.code },
      update: { name: ot.name, description: ot.description },
      create: { code: ot.code, name: ot.name, description: ot.description, isActive: true },
    });

    console.log(`   ✓ OutletType [${result.code}] "${result.name}"  — id: ${result.id}`);
  }

  console.log('\n✅  Seed complete.');
}

main()
  .catch((e) => {
    console.error('❌  Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
