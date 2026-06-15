/**
 * seed-outlet-types.ts — seeds the standard outlet types and enables them for
 * every client tenant, so the Outlet Master upload (which validates each row's
 * "Outlet Type" against the tenant's enabled OutletTypeClientConfig) can succeed.
 *
 * The codes match VALID_OUTLET_TYPES in src/lib/outlet-upload.ts.
 *
 * Usage:
 *   npx tsx scripts/seed-outlet-types.ts
 *
 * Idempotent: OutletType is matched by code (it has no unique constraint on
 * code, so we findFirst-then-create); the per-tenant config upserts on
 * (clientId, outletTypeId). Safe to re-run.
 */

import 'dotenv/config';
import { prisma } from '../src/lib/prisma';

const OUTLET_TYPES: { code: string; name: string }[] = [
  { code: 'SSS',          name: 'SSS' },
  { code: 'WHOLESALER',   name: 'Wholesaler' },
  { code: 'SUB_STOCKIST', name: 'Sub-Stockist' },
  { code: 'SSS_TOT',      name: 'SSS TOT' },
];

async function main() {
  const clients = await prisma.client.findMany({ select: { id: true } });
  console.log(`Seeding ${OUTLET_TYPES.length} outlet types for ${clients.length} client(s): ${clients.map(c => c.id).join(', ')}`);

  // 1. Ensure the global OutletType catalog rows exist (idempotent by code).
  const typeIdByCode = new Map<string, string>();
  for (const t of OUTLET_TYPES) {
    let type = await prisma.outletType.findFirst({ where: { code: t.code } });
    if (!type) {
      type = await prisma.outletType.create({ data: { code: t.code, name: t.name, isActive: true } });
      console.log(`  created OutletType ${t.code}`);
    }
    typeIdByCode.set(t.code, type.id);
  }

  // 2. Enable each type for each client tenant (idempotent on clientId+outletTypeId).
  let configs = 0;
  for (const c of clients) {
    for (const t of OUTLET_TYPES) {
      const outletTypeId = typeIdByCode.get(t.code)!;
      await prisma.outletTypeClientConfig.upsert({
        where:  { clientId_outletTypeId: { clientId: c.id, outletTypeId } },
        create: { clientId: c.id, outletTypeId, isEnabled: true },
        update: { isEnabled: true },
      });
      configs++;
    }
  }
  console.log(`Done. ${typeIdByCode.size} types ensured, ${configs} per-tenant configs upserted.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
