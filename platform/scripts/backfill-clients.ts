/**
 * backfill-clients.ts — seeds the `clients` table from CLIENT_REGISTRY.
 *
 * ─── IMPORTANT ───────────────────────────────────────────────────────────────
 * DO NOT run this script until the orchestrator has run the Prisma migration
 * that creates the `clients` table (task 1.3 migration gate).
 *
 * Running this before the migration exists will throw a Prisma error.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Usage (after migration):
 *   npx tsx scripts/backfill-clients.ts
 *
 * Idempotent: uses upsert — safe to re-run.
 *
 * Secrets note: msg91AuthKey is NOT written to the DB (stripped by
 * clientConfigToRow). It must remain in env / Secret Manager.
 */

import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import { CLIENT_REGISTRY } from '../src/lib/platform/client-registry';
import { clientConfigToRow } from '../src/lib/platform/client-row';

async function main() {
  const entries = Object.values(CLIENT_REGISTRY);

  console.log(`Backfilling ${entries.length} client(s) …`);

  for (const config of entries) {
    const row = clientConfigToRow(config);

    await prisma.client.upsert({
      where:  { id: row.id },
      create: {
        id:                row.id,
        internalName:      row.internalName,
        status:            row.status,
        onboardedAt:       row.onboardedAt,
        branding:          row.branding      as object,
        features:          row.features      as object,
        partnerClasses:    row.partnerClasses as object,
        approvalHierarchy: row.approvalHierarchy as object,
        notifications:     row.notifications  as object,
        invoicing:         row.invoicing      as object,
        wallet:            row.wallet         as object,
      },
      update: {
        internalName:      row.internalName,
        status:            row.status,
        onboardedAt:       row.onboardedAt,
        branding:          row.branding      as object,
        features:          row.features      as object,
        partnerClasses:    row.partnerClasses as object,
        approvalHierarchy: row.approvalHierarchy as object,
        notifications:     row.notifications  as object,
        invoicing:         row.invoicing      as object,
        wallet:            row.wallet         as object,
      },
    });

    console.log(`  ✓ upserted client: ${row.id} (${row.internalName}) → ${row.status}`);
  }

  console.log('Done.');
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
