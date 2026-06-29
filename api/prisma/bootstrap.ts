import 'dotenv/config';
import { PrismaClient, UserRole, UserStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as bcrypt from 'bcrypt';

/**
 * PRODUCTION BOOTSTRAP — the one-time, idempotent break-the-deadlock script.
 *
 * Prod starts with ZERO users and ZERO OutletType master rows, and there is NO
 * app/API path to create either:
 *   • the first GIFSY_ADMIN — `assertRoleAssignable` only lets an *existing*
 *     GIFSY_ADMIN mint another (chicken-and-egg);
 *   • the OutletType master rows — `GifsyService.createClient` only upserts the
 *     per-tenant *config* for already-existing OutletType rows; the prisma seed
 *     that creates the master list is hard-firewalled to dev/staging.
 *
 * This script creates exactly those two things so #76 (real data load) can start.
 * Everything else — the Deoleo client, its CLIENT_ADMIN, additional GIFSY_ADMINs,
 * hierarchy, outlets — then flows through the normal app/API.
 *
 * RUN MECHANISM (mirrors the seed): the api Dockerfile compiles this to
 * `prisma/bootstrap.js` into the prod image (which omits ts-node). Run it via an
 * in-VPC Cloud Run Job against the prod DB — the same way `gifsy-migrate` runs:
 *   command=node  args=prisma/bootstrap.js
 *   env: DATABASE_URL=<prod secret>, BOOTSTRAP_CONFIRM=gifsy_prod,
 *        GIFSY_ADMIN_NAME=Nikunj, GIFSY_ADMIN_PHONE=9830011252
 *
 * SAFETY:
 *   • Double-guard: refuses to run unless BOOTSTRAP_CONFIRM === current_database()
 *     (the instance is SHARED by gifsy_staging + gifsy_prod — this forces the
 *     operator to name the exact target).
 *   • Idempotent: skips if a GIFSY_ADMIN already exists; OutletType rows are
 *     find-then-create on `code`. Re-running is a safe no-op.
 *   • Additive only — never updates/deletes existing data.
 */

const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const GIFSY_CLIENT_ID = 'gifsy';
const GIFSY_ADMIN_NAME = process.env['GIFSY_ADMIN_NAME'] ?? 'Nikunj';
const GIFSY_ADMIN_PHONE = process.env['GIFSY_ADMIN_PHONE'] ?? '9830011252';

// The OutletType master list — must match api/prisma/seed.ts exactly (the four
// types Deoleo uses). code is the stable key the upload parser + award editor
// resolve on; name is the display label and can change without code edits.
const OUTLET_TYPES = [
  { code: 'SSS', name: 'SSS', description: 'SSS channel partner' },
  { code: 'WHOLESALER', name: 'Wholesaler', description: 'Wholesale channel partner' },
  { code: 'SUB_STOCKIST', name: 'Sub-Stockist', description: 'Sub-stockist channel partner' },
  { code: 'SSS_TOT', name: 'SSS TOT', description: 'Super stockist / TOT channel partner' },
] as const;

/** Double-guard: only proceed when the caller has named the exact connected DB. */
async function assertConfirmedDatabase(): Promise<string> {
  const rows = await prisma.$queryRaw<{ current_database: string }[]>`
    SELECT current_database() AS current_database
  `;
  const dbName = rows[0]?.current_database ?? '(unknown)';
  const confirm = process.env['BOOTSTRAP_CONFIRM'];
  console.log(`   → connected database: "${dbName}"`);
  if (confirm !== dbName) {
    throw new Error(
      `🚫 Refusing to bootstrap. Set BOOTSTRAP_CONFIRM to the EXACT connected database name to proceed.\n` +
        `   connected: "${dbName}"  ·  BOOTSTRAP_CONFIRM: ${confirm ? `"${confirm}"` : '(unset)'}\n` +
        `   (Double-guard — the instance is shared by gifsy_staging + gifsy_prod.)`,
    );
  }
  console.log(`   ✓ Confirmation matches "${dbName}".`);
  return dbName;
}

async function main(): Promise<void> {
  console.log('🚀  Bootstrap — first GIFSY_ADMIN + OutletType master rows');
  const dbName = await assertConfirmedDatabase();

  // 1. OutletType master list (idempotent — code is NOT @unique, so find-then-create).
  for (const ot of OUTLET_TYPES) {
    const existing = await prisma.outletType.findFirst({ where: { code: ot.code } });
    if (existing) {
      console.log(`   ✓ OutletType [${ot.code}] already exists — id: ${existing.id}`);
    } else {
      const created = await prisma.outletType.create({
        data: { code: ot.code, name: ot.name, description: ot.description, isActive: true },
      });
      console.log(`   ✓ OutletType [${created.code}] "${created.name}" created — id: ${created.id}`);
    }
  }

  // 2. First GIFSY_ADMIN. Idempotent: if ANY GIFSY_ADMIN already exists under the
  // operator clientId, do nothing (additional admins are created in-app).
  const existingAdmin = await prisma.user.findFirst({
    where: { clientId: GIFSY_CLIENT_ID, role: UserRole.GIFSY_ADMIN },
  });
  if (existingAdmin) {
    console.log(
      `   ✓ GIFSY_ADMIN already exists (${existingAdmin.phone}) — skipping; no new admin created.`,
    );
  } else {
    // Guard the (clientId, phone) unique: a non-admin user could already hold it.
    const phoneTaken = await prisma.user.findFirst({
      where: { clientId: GIFSY_CLIENT_ID, phone: GIFSY_ADMIN_PHONE },
    });
    if (phoneTaken) {
      throw new Error(
        `Phone ${GIFSY_ADMIN_PHONE} already exists under clientId '${GIFSY_CLIENT_ID}' ` +
          `(role ${phoneTaken.role}). Resolve before bootstrapping.`,
      );
    }
    // OTP is the real login path; the password hash is an inert safety net (mirrors the seed).
    const passwordHash = await bcrypt.hash('ChangeMeOnFirstLogin!', 12);
    const admin = await prisma.user.create({
      data: {
        clientId: GIFSY_CLIENT_ID,
        phone: GIFSY_ADMIN_PHONE,
        name: GIFSY_ADMIN_NAME,
        role: UserRole.GIFSY_ADMIN,
        status: UserStatus.ACTIVE,
        passwordHash,
      },
    });
    console.log(
      `   ✓ GIFSY_ADMIN created — id: ${admin.id}, name: "${admin.name}", phone: ${admin.phone} (login via OTP).`,
    );
  }

  console.log(
    `✅  Bootstrap complete on "${dbName}". The GIFSY_ADMIN can now log in (clientId '${GIFSY_CLIENT_ID}') and provision tenants.`,
  );
}

main()
  .catch((e) => {
    console.error('❌  Bootstrap failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
