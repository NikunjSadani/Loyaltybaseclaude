/**
 * wipe-tenant-data.ts — GUARDED, FK-safe tenant-data wipe.
 *
 * Purpose
 *   Delete ALL rows belonging to a given set of tenant `clientId`s — used at the
 *   Deoleo go-live cutover to clear seed/UAT data from a database BEFORE loading
 *   real client data. This is DESTRUCTIVE and will eventually run against PROD.
 *
 *   ⚠️  Read platform/docs/plans/runbooks/PROD-DATA-WIPE.md before running this.
 *       Cloud SQL backups + PITR (O-4) MUST be enabled first — this script's only
 *       rollback is a point-in-time restore.
 *
 * Safety guards (ALL must pass before a single row is deleted)
 *   1. Positive DB-name assertion. SELECT current_database() must EXACTLY equal
 *      $WIPE_TARGET_DB. Unset / mismatch → exit 1. (Inverse of seed.ts's hard-coded
 *      dev guard: here the caller must NAME the database they intend to wipe.)
 *   2. Confirmation token. $WIPE_CONFIRM must EXACTLY equal
 *      `WIPE <db> <clientIds-joined-by-comma>`. Absent / mismatch → exit 1.
 *   3. Tenant scope. Only rows owned by $WIPE_CLIENT_IDS (default "deoleo,clientb")
 *      are touched. The GIFSY platform admin / "gifsy" client and all global/master
 *      tables (Client, OutletType, …) are NEVER deleted, and no other tenant's rows.
 *   4. Dry-run by DEFAULT. Counts only; ZERO deletes unless the caller explicitly
 *      sets WIPE_DRY_RUN=false (or passes --no-dry-run). Fail-safe.
 *
 * What it does NOT do
 *   - Never TRUNCATE ... CASCADE. Every delete is a scoped Prisma deleteMany,
 *     emitted children-before-parents so no FK constraint is violated.
 *   - Never deletes the Client (tenant) rows themselves, OutletType, or any other
 *     global/master/config table that has no per-tenant owner.
 *
 * Run (dry-run — safe, the default):
 *   WIPE_TARGET_DB=gifsy_dev npx ts-node api/prisma/wipe-tenant-data.ts
 *
 * Run (REAL wipe — requires the confirmation token):
 *   WIPE_TARGET_DB=gifsy_staging \
 *   WIPE_CLIENT_IDS=deoleo,clientb \
 *   WIPE_DRY_RUN=false \
 *   WIPE_CONFIRM="WIPE gifsy_staging deoleo,clientb" \
 *   npx ts-node api/prisma/wipe-tenant-data.ts
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

// Construct PrismaClient with the pg driver adapter — mirrors seed.ts /
// api/src/prisma/prisma.service.ts (a bare `new PrismaClient()` throws under
// Prisma 7: "must provide a driver adapter").
const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ── Config ──────────────────────────────────────────────────────────────────

// The "gifsy" tenant is the platform itself (GIFSY_ADMIN). It must NEVER be a
// wipe target — even if a caller mistakenly lists it, we refuse.
const PROTECTED_CLIENT_IDS = ['gifsy'];

function parseClientIds(): string[] {
  // Fail-closed: the tenant list must be named EXPLICITLY (no default), so a forgotten
  // env var on prod can never silently widen the wipe scope (audit A-10 F3).
  const raw = process.env['WIPE_CLIENT_IDS']?.trim();
  if (!raw || raw.length === 0) {
    console.error(
      '🚫  WIPE_CLIENT_IDS is not set. You must explicitly list the tenant clientId(s) to ' +
        'wipe (e.g. WIPE_CLIENT_IDS=deoleo). Refusing to run.',
    );
    process.exit(1);
  }
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Dry-run is the DEFAULT. Only an explicit opt-out turns it off.
function isDryRun(): boolean {
  const argOptOut = process.argv.includes('--no-dry-run');
  const argOptIn = process.argv.includes('--dry-run');
  const envVal = process.env['WIPE_DRY_RUN'];

  // Explicit opt-outs (only these make it a REAL wipe):
  if (argOptOut) return false;
  if (envVal === 'false') return false;

  // Everything else (unset, 'true', '--dry-run', any other value) → dry-run.
  void argOptIn;
  return true;
}

// ── Guards ──────────────────────────────────────────────────────────────────

async function assertTargetDatabase(): Promise<string> {
  const expected = process.env['WIPE_TARGET_DB']?.trim();
  if (!expected) {
    console.error(
      '🚫  WIPE_TARGET_DB is not set. You must explicitly name the database you ' +
        'intend to wipe (e.g. WIPE_TARGET_DB=gifsy_staging). Refusing to run.',
    );
    process.exit(1);
  }

  const rows = await prisma.$queryRaw<{ current_database: string }[]>`
    SELECT current_database() AS current_database
  `;
  const dbName = rows[0]?.current_database;

  if (dbName !== expected) {
    console.error(
      `🚫  Refusing to wipe: connected database is "${dbName}", but ` +
        `WIPE_TARGET_DB="${expected}". They must match EXACTLY. Check DATABASE_URL.`,
    );
    process.exit(1);
  }

  console.log(`   ✓ DB assertion passed — connected to "${dbName}" (== WIPE_TARGET_DB).`);
  return dbName;
}

function assertConfirmationToken(dbName: string, clientIds: string[]): void {
  const expected = `WIPE ${dbName} ${clientIds.join(',')}`;
  const provided = process.env['WIPE_CONFIRM'];

  if (provided !== expected) {
    console.error('🚫  Confirmation token missing or mismatched.');
    console.error(`    Set WIPE_CONFIRM to EXACTLY (note the spacing and order):`);
    console.error(`    WIPE_CONFIRM="${expected}"`);
    process.exit(1);
  }

  console.log('   ✓ Confirmation token matched.');
}

function assertNoProtectedTenant(clientIds: string[]): void {
  const offenders = clientIds.filter((id) => PROTECTED_CLIENT_IDS.includes(id));
  if (offenders.length > 0) {
    console.error(
      `🚫  Refusing to wipe protected tenant(s): ${offenders.join(', ')}. ` +
        `These are the GIFSY platform rows and can never be a wipe target.`,
    );
    process.exit(1);
  }
}

// ── Delete plan ─────────────────────────────────────────────────────────────
//
// Ordered CHILDREN-BEFORE-PARENTS so no FK constraint is ever violated.
// Each step is one scoped Prisma deleteMany. `where` scopes by:
//   • direct clientId where the model has it, or
//   • a nested parent relation (model → … → clientId) where it does not.
//
// `count(tx)`  → returns how many rows WOULD be deleted (for dry-run + summary).
// `del(tx)`    → performs the scoped deleteMany.
//
// `tx` is a Prisma transaction client so the whole wipe is atomic.

type Step = {
  /** table label for the summary */
  model: string;
  /** human-readable scope, printed in the plan/summary for auditing */
  scope: string;
  count: (tx: Prisma.TransactionClient) => Promise<number>;
  del: (tx: Prisma.TransactionClient) => Promise<number>;
};

function buildSteps(clientIds: string[]): Step[] {
  const In = { in: clientIds };

  // Reusable nested-relation scopes (parent chains that end in a clientId).
  const viaUser = { user: { clientId: In } }; // child.user.clientId
  const viaPartnerClient = { partner: { clientId: In } }; // child.partner.clientId

  const steps: Step[] = [
    // ── Leaf-most children first ───────────────────────────────────────────

    // KYC tree: KycSubmission → user.clientId. Its children scope through it.
    {
      model: 'KycDocument',
      scope: 'kycSubmission.user.clientId in tenants',
      count: (tx) =>
        tx.kycDocument.count({ where: { kycSubmission: viaUser } }),
      del: (tx) =>
        tx.kycDocument
          .deleteMany({ where: { kycSubmission: viaUser } })
          .then((r) => r.count),
    },
    {
      model: 'KycStatusHistory',
      scope: 'kycSubmission.user.clientId in tenants',
      count: (tx) =>
        tx.kycStatusHistory.count({ where: { kycSubmission: viaUser } }),
      del: (tx) =>
        tx.kycStatusHistory
          .deleteMany({ where: { kycSubmission: viaUser } })
          .then((r) => r.count),
    },
    {
      model: 'KycVerificationItem',
      scope: 'kycSubmission.user.clientId in tenants',
      count: (tx) =>
        tx.kycVerificationItem.count({ where: { kycSubmission: viaUser } }),
      del: (tx) =>
        tx.kycVerificationItem
          .deleteMany({ where: { kycSubmission: viaUser } })
          .then((r) => r.count),
    },
    {
      // ConsentRecord → user.clientId. (Also FK-soft to KycSubmission via SetNull,
      // so it can be deleted before or after KycSubmission; we scope by user.)
      model: 'ConsentRecord',
      scope: 'user.clientId in tenants',
      count: (tx) => tx.consentRecord.count({ where: viaUser }),
      del: (tx) =>
        tx.consentRecord.deleteMany({ where: viaUser }).then((r) => r.count),
    },
    {
      // KycSubmission → user.clientId. Children above are gone first.
      model: 'KycSubmission',
      scope: 'user.clientId in tenants',
      count: (tx) => tx.kycSubmission.count({ where: viaUser }),
      del: (tx) =>
        tx.kycSubmission.deleteMany({ where: viaUser }).then((r) => r.count),
    },
    {
      model: 'DataRequest',
      scope: 'user.clientId in tenants',
      count: (tx) => tx.dataRequest.count({ where: viaUser }),
      del: (tx) =>
        tx.dataRequest.deleteMany({ where: viaUser }).then((r) => r.count),
    },

    // ── Visibility tree ────────────────────────────────────────────────────
    // VisibilitySubmission → partner.clientId (partner is a required relation).
    {
      model: 'VisibilityApproval',
      scope: 'submission.partner.clientId in tenants',
      count: (tx) =>
        tx.visibilityApproval.count({
          where: { submission: viaPartnerClient },
        }),
      del: (tx) =>
        tx.visibilityApproval
          .deleteMany({ where: { submission: viaPartnerClient } })
          .then((r) => r.count),
    },
    {
      model: 'VisibilityFraudLog',
      scope: 'submission.partner.clientId in tenants',
      count: (tx) =>
        tx.visibilityFraudLog.count({
          where: { submission: viaPartnerClient },
        }),
      del: (tx) =>
        tx.visibilityFraudLog
          .deleteMany({ where: { submission: viaPartnerClient } })
          .then((r) => r.count),
    },
    {
      // VisibilityImageHash has NO Prisma relation field but stores submissionId.
      // Scope by submissionId ∈ (the tenants' submissions). Collected at run time.
      model: 'VisibilityImageHash',
      scope: 'submissionId in (tenant VisibilitySubmission ids)',
      count: async (tx) => {
        const ids = await tenantSubmissionIds(tx, clientIds);
        if (ids.length === 0) return 0;
        return tx.visibilityImageHash.count({
          where: { submissionId: { in: ids } },
        });
      },
      del: async (tx) => {
        const ids = await tenantSubmissionIds(tx, clientIds);
        if (ids.length === 0) return 0;
        return tx.visibilityImageHash
          .deleteMany({ where: { submissionId: { in: ids } } })
          .then((r) => r.count);
      },
    },
    {
      model: 'VisibilitySubmission',
      scope: 'partner.clientId in tenants',
      count: (tx) => tx.visibilitySubmission.count({ where: viaPartnerClient }),
      del: (tx) =>
        tx.visibilitySubmission
          .deleteMany({ where: viaPartnerClient })
          .then((r) => r.count),
    },
    {
      model: 'VisibilityProgram',
      scope: 'clientId in tenants (direct)',
      count: (tx) => tx.visibilityProgram.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.visibilityProgram
          .deleteMany({ where: { clientId: In } })
          .then((r) => r.count),
    },

    // ── Finance / TDS / payouts ────────────────────────────────────────────
    {
      // TdsRecord → payoutTransaction.partner.clientId.
      model: 'TdsRecord',
      scope: 'payoutTransaction.partner.clientId in tenants',
      count: (tx) =>
        tx.tdsRecord.count({
          where: { payoutTransaction: { partner: { clientId: In } } },
        }),
      del: (tx) =>
        tx.tdsRecord
          .deleteMany({
            where: { payoutTransaction: { partner: { clientId: In } } },
          })
          .then((r) => r.count),
    },
    {
      // PayoutTransaction → partner.clientId (partner required; batch nullable).
      model: 'PayoutTransaction',
      scope: 'partner.clientId in tenants',
      count: (tx) => tx.payoutTransaction.count({ where: viaPartnerClient }),
      del: (tx) =>
        tx.payoutTransaction
          .deleteMany({ where: viaPartnerClient })
          .then((r) => r.count),
    },
    {
      model: 'PayoutBatch',
      scope: 'clientId in tenants (direct)',
      count: (tx) => tx.payoutBatch.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.payoutBatch
          .deleteMany({ where: { clientId: In } })
          .then((r) => r.count),
    },

    // ── Redemption tree ────────────────────────────────────────────────────
    {
      // RedemptionStatusHistory → order.partner.clientId.
      model: 'RedemptionStatusHistory',
      scope: 'order.partner.clientId in tenants',
      count: (tx) =>
        tx.redemptionStatusHistory.count({
          where: { order: viaPartnerClient },
        }),
      del: (tx) =>
        tx.redemptionStatusHistory
          .deleteMany({ where: { order: viaPartnerClient } })
          .then((r) => r.count),
    },
    {
      model: 'RedemptionOrder',
      scope: 'partner.clientId in tenants',
      count: (tx) => tx.redemptionOrder.count({ where: viaPartnerClient }),
      del: (tx) =>
        tx.redemptionOrder
          .deleteMany({ where: viaPartnerClient })
          .then((r) => r.count),
    },

    // ── Wallet / points tree ───────────────────────────────────────────────
    {
      // PointsLedger → wallet.partner.clientId (wallet required).
      model: 'PointsLedger',
      scope: 'wallet.partner.clientId in tenants',
      count: (tx) =>
        tx.pointsLedger.count({
          where: { wallet: { partner: { clientId: In } } },
        }),
      del: (tx) =>
        tx.pointsLedger
          .deleteMany({ where: { wallet: { partner: { clientId: In } } } })
          .then((r) => r.count),
    },
    {
      // WalletTransaction → wallet.partner.clientId.
      model: 'WalletTransaction',
      scope: 'wallet.partner.clientId in tenants',
      count: (tx) =>
        tx.walletTransaction.count({
          where: { wallet: { partner: { clientId: In } } },
        }),
      del: (tx) =>
        tx.walletTransaction
          .deleteMany({ where: { wallet: { partner: { clientId: In } } } })
          .then((r) => r.count),
    },
    {
      // Wallet → partner.clientId.
      model: 'Wallet',
      scope: 'partner.clientId in tenants',
      count: (tx) => tx.wallet.count({ where: viaPartnerClient }),
      del: (tx) =>
        tx.wallet.deleteMany({ where: viaPartnerClient }).then((r) => r.count),
    },

    // ── Leaderboard tree ───────────────────────────────────────────────────
    {
      // LeaderboardEntry → snapshot.config.clientId (and partner.clientId).
      model: 'LeaderboardEntry',
      scope: 'snapshot.config.clientId in tenants',
      count: (tx) =>
        tx.leaderboardEntry.count({
          where: { snapshot: { config: { clientId: In } } },
        }),
      del: (tx) =>
        tx.leaderboardEntry
          .deleteMany({ where: { snapshot: { config: { clientId: In } } } })
          .then((r) => r.count),
    },
    {
      model: 'LeaderboardSnapshot',
      scope: 'config.clientId in tenants',
      count: (tx) =>
        tx.leaderboardSnapshot.count({ where: { config: { clientId: In } } }),
      del: (tx) =>
        tx.leaderboardSnapshot
          .deleteMany({ where: { config: { clientId: In } } })
          .then((r) => r.count),
    },
    {
      model: 'LeaderboardConfig',
      scope: 'clientId in tenants (direct)',
      count: (tx) => tx.leaderboardConfig.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.leaderboardConfig
          .deleteMany({ where: { clientId: In } })
          .then((r) => r.count),
    },

    // ── Schemes / enrollment / reward catalog ──────────────────────────────
    {
      // SchemeEnrollment → scheme.clientId (also user.clientId — same tenant).
      model: 'SchemeEnrollment',
      scope: 'scheme.clientId in tenants',
      count: (tx) =>
        tx.schemeEnrollment.count({ where: { scheme: { clientId: In } } }),
      del: (tx) =>
        tx.schemeEnrollment
          .deleteMany({ where: { scheme: { clientId: In } } })
          .then((r) => r.count),
    },
    {
      model: 'SchemeEnrollmentForm',
      scope: 'scheme.clientId in tenants',
      count: (tx) =>
        tx.schemeEnrollmentForm.count({ where: { scheme: { clientId: In } } }),
      del: (tx) =>
        tx.schemeEnrollmentForm
          .deleteMany({ where: { scheme: { clientId: In } } })
          .then((r) => r.count),
    },
    {
      model: 'SchemeEligibility',
      scope: 'scheme.clientId in tenants',
      count: (tx) =>
        tx.schemeEligibility.count({ where: { scheme: { clientId: In } } }),
      del: (tx) =>
        tx.schemeEligibility
          .deleteMany({ where: { scheme: { clientId: In } } })
          .then((r) => r.count),
    },
    {
      // Scheme → clientId. PointsLedger references it (SetNull) but is gone above.
      model: 'Scheme',
      scope: 'clientId in tenants (direct)',
      count: (tx) => tx.scheme.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.scheme.deleteMany({ where: { clientId: In } }).then((r) => r.count),
    },
    {
      // RewardCatalog → clientId. RedemptionOrder.reward (no onDelete) is gone above.
      model: 'RewardCatalog',
      scope: 'clientId in tenants (direct)',
      count: (tx) => tx.rewardCatalog.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.rewardCatalog
          .deleteMany({ where: { clientId: In } })
          .then((r) => r.count),
    },
    {
      // RewardCategory → clientId. Self-referential parent/child + RewardCatalog
      // children (gone above). Delete children-before-parents within the tenant
      // by repeatedly removing leaf categories.
      model: 'RewardCategory',
      scope: 'clientId in tenants (direct, leaf-first within tenant)',
      count: (tx) => tx.rewardCategory.count({ where: { clientId: In } }),
      del: async (tx) => {
        let total = 0;
        // Drill from leaves up: a category with no remaining children can go.
        // Loop until none remain (bounded by hierarchy depth).
        // eslint-disable-next-line no-constant-condition
        for (let guard = 0; guard < 1000; guard++) {
          const remaining = await tx.rewardCategory.count({
            where: { clientId: In },
          });
          if (remaining === 0) break;
          const r = await tx.rewardCategory.deleteMany({
            where: { clientId: In, children: { none: {} } },
          });
          total += r.count;
          if (r.count === 0) {
            // No leaf deletable (shouldn't happen — would imply a cycle). Fall
            // back to deleting the rest; the FK is nullable parent so this is safe.
            const rest = await tx.rewardCategory.deleteMany({
              where: { clientId: In },
            });
            total += rest.count;
            break;
          }
        }
        return total;
      },
    },

    // ── Targets / sales-data / visibility-upload (outletCode-keyed, direct clientId) ──
    {
      model: 'OutletTarget',
      scope: 'clientId in tenants (direct)',
      count: (tx) => tx.outletTarget.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.outletTarget
          .deleteMany({ where: { clientId: In } })
          .then((r) => r.count),
    },
    {
      model: 'TargetUploadBatch',
      scope: 'clientId in tenants (direct)',
      count: (tx) => tx.targetUploadBatch.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.targetUploadBatch
          .deleteMany({ where: { clientId: In } })
          .then((r) => r.count),
    },
    {
      model: 'OutletSalesRecord',
      scope: 'clientId in tenants (direct)',
      count: (tx) => tx.outletSalesRecord.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.outletSalesRecord
          .deleteMany({ where: { clientId: In } })
          .then((r) => r.count),
    },
    {
      model: 'SalesUploadBatch',
      scope: 'clientId in tenants (direct)',
      count: (tx) => tx.salesUploadBatch.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.salesUploadBatch
          .deleteMany({ where: { clientId: In } })
          .then((r) => r.count),
    },
    {
      model: 'KpiDef',
      scope: 'clientId in tenants (direct)',
      count: (tx) => tx.kpiDef.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.kpiDef.deleteMany({ where: { clientId: In } }).then((r) => r.count),
    },
    {
      model: 'OutletVisibilityRecord',
      scope: 'clientId in tenants (direct)',
      count: (tx) =>
        tx.outletVisibilityRecord.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.outletVisibilityRecord
          .deleteMany({ where: { clientId: In } })
          .then((r) => r.count),
    },
    {
      model: 'OutletVisibilityAuditLog',
      scope: 'clientId in tenants (direct)',
      count: (tx) =>
        tx.outletVisibilityAuditLog.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.outletVisibilityAuditLog
          .deleteMany({ where: { clientId: In } })
          .then((r) => r.count),
    },
    {
      model: 'OutletVisibilityUploadBatch',
      scope: 'clientId in tenants (direct)',
      count: (tx) =>
        tx.outletVisibilityUploadBatch.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.outletVisibilityUploadBatch
          .deleteMany({ where: { clientId: In } })
          .then((r) => r.count),
    },

    // ── Credits & payouts tree ─────────────────────────────────────────────
    {
      // CreditReversal → clientId (FK to CreditBatch, no onDelete → delete first).
      model: 'CreditReversal',
      scope: 'clientId in tenants (direct)',
      count: (tx) => tx.creditReversal.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.creditReversal
          .deleteMany({ where: { clientId: In } })
          .then((r) => r.count),
    },
    {
      // CreditPayoutEntry → clientId (FK to CreditBatch + CreditPayoutDownload).
      model: 'CreditPayoutEntry',
      scope: 'clientId in tenants (direct)',
      count: (tx) => tx.creditPayoutEntry.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.creditPayoutEntry
          .deleteMany({ where: { clientId: In } })
          .then((r) => r.count),
    },
    {
      model: 'CreditPayoutDownload',
      scope: 'clientId in tenants (direct)',
      count: (tx) => tx.creditPayoutDownload.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.creditPayoutDownload
          .deleteMany({ where: { clientId: In } })
          .then((r) => r.count),
    },
    {
      model: 'CreditBatch',
      scope: 'clientId in tenants (direct)',
      count: (tx) => tx.creditBatch.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.creditBatch
          .deleteMany({ where: { clientId: In } })
          .then((r) => r.count),
    },
    {
      model: 'CreditField',
      scope: 'clientId in tenants (direct)',
      count: (tx) => tx.creditField.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.creditField
          .deleteMany({ where: { clientId: In } })
          .then((r) => r.count),
    },

    // ── Invoicing / fund / TDS upload tables (direct clientId, no children) ──
    {
      model: 'AutoInvoice',
      scope: 'clientId in tenants (direct)',
      count: (tx) => tx.autoInvoice.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.autoInvoice
          .deleteMany({ where: { clientId: In } })
          .then((r) => r.count),
    },
    {
      model: 'FundLedger',
      scope: 'clientId in tenants (direct)',
      count: (tx) => tx.fundLedger.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.fundLedger
          .deleteMany({ where: { clientId: In } })
          .then((r) => r.count),
    },
    {
      model: 'FundReceipt',
      scope: 'clientId in tenants (direct)',
      count: (tx) => tx.fundReceipt.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.fundReceipt
          .deleteMany({ where: { clientId: In } })
          .then((r) => r.count),
    },
    {
      // TdsOffPlatformEntry → clientId (required).
      model: 'TdsOffPlatformEntry',
      scope: 'clientId in tenants (direct)',
      count: (tx) => tx.tdsOffPlatformEntry.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.tdsOffPlatformEntry
          .deleteMany({ where: { clientId: In } })
          .then((r) => r.count),
    },
    {
      // TdsDeposit.clientId is NULLABLE: null = GIFSY/194C platform rows (NEVER
      // ours to wipe). Scope strictly to clientId ∈ tenants, so null rows are skipped.
      model: 'TdsDeposit',
      scope: 'clientId in tenants (direct; NULL/GIFSY rows excluded)',
      count: (tx) => tx.tdsDeposit.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.tdsDeposit
          .deleteMany({ where: { clientId: In } })
          .then((r) => r.count),
    },

    // ── Support / tickets tree ─────────────────────────────────────────────
    {
      // TicketMessage → ticket.clientId.
      model: 'TicketMessage',
      scope: 'ticket.clientId in tenants',
      count: (tx) =>
        tx.ticketMessage.count({ where: { ticket: { clientId: In } } }),
      del: (tx) =>
        tx.ticketMessage
          .deleteMany({ where: { ticket: { clientId: In } } })
          .then((r) => r.count),
    },
    {
      model: 'TicketStatusHistory',
      scope: 'ticket.clientId in tenants',
      count: (tx) =>
        tx.ticketStatusHistory.count({ where: { ticket: { clientId: In } } }),
      del: (tx) =>
        tx.ticketStatusHistory
          .deleteMany({ where: { ticket: { clientId: In } } })
          .then((r) => r.count),
    },
    {
      model: 'Ticket',
      scope: 'clientId in tenants (direct)',
      count: (tx) => tx.ticket.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.ticket.deleteMany({ where: { clientId: In } }).then((r) => r.count),
    },

    // ── Notifications tree ─────────────────────────────────────────────────
    {
      // NotificationDeliveryLog → queue.user.clientId.
      model: 'NotificationDeliveryLog',
      scope: 'queue.user.clientId in tenants',
      count: (tx) =>
        tx.notificationDeliveryLog.count({
          where: { queue: viaUser },
        }),
      del: (tx) =>
        tx.notificationDeliveryLog
          .deleteMany({ where: { queue: viaUser } })
          .then((r) => r.count),
    },
    {
      // NotificationQueue → user.clientId (also template SetNull — template kept).
      model: 'NotificationQueue',
      scope: 'user.clientId in tenants',
      count: (tx) => tx.notificationQueue.count({ where: viaUser }),
      del: (tx) =>
        tx.notificationQueue
          .deleteMany({ where: viaUser })
          .then((r) => r.count),
    },
    {
      model: 'NotificationTemplate',
      scope: 'clientId in tenants (direct)',
      count: (tx) => tx.notificationTemplate.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.notificationTemplate
          .deleteMany({ where: { clientId: In } })
          .then((r) => r.count),
    },

    // ── Reports tree ───────────────────────────────────────────────────────
    {
      // ReportDeliveryLog → report.clientId (also triggeredBy SetNull).
      model: 'ReportDeliveryLog',
      scope: 'report.clientId in tenants',
      count: (tx) =>
        tx.reportDeliveryLog.count({ where: { report: { clientId: In } } }),
      del: (tx) =>
        tx.reportDeliveryLog
          .deleteMany({ where: { report: { clientId: In } } })
          .then((r) => r.count),
    },
    {
      // ScheduledReport → clientId (createdBy is Restrict → delete before User).
      model: 'ScheduledReport',
      scope: 'clientId in tenants (direct)',
      count: (tx) => tx.scheduledReport.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.scheduledReport
          .deleteMany({ where: { clientId: In } })
          .then((r) => r.count),
    },

    // ── Admin / config (direct clientId, no children) ──────────────────────
    {
      model: 'AdminConfig',
      scope: 'clientId in tenants (direct)',
      count: (tx) => tx.adminConfig.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.adminConfig
          .deleteMany({ where: { clientId: In } })
          .then((r) => r.count),
    },
    {
      model: 'BannerManagement',
      scope: 'clientId in tenants (direct)',
      count: (tx) => tx.bannerManagement.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.bannerManagement
          .deleteMany({ where: { clientId: In } })
          .then((r) => r.count),
    },
    {
      model: 'ProgramSetting',
      scope: 'clientId in tenants (direct)',
      count: (tx) => tx.programSetting.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.programSetting
          .deleteMany({ where: { clientId: In } })
          .then((r) => r.count),
    },
    {
      model: 'PointExpiryConfig',
      scope: 'clientId in tenants (direct)',
      count: (tx) => tx.pointExpiryConfig.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.pointExpiryConfig
          .deleteMany({ where: { clientId: In } })
          .then((r) => r.count),
    },
    {
      // OutletTypeClientConfig → per-tenant outlet-type enable/feature config (direct clientId).
      // Audit A-10 F1: previously missed. Leaving stale rows would collide on @@unique
      // ([clientId, outletTypeId]) or silently reuse UAT toggles when real data is loaded.
      // References only OutletType (global, never deleted) and nothing references it → order-free.
      model: 'OutletTypeClientConfig',
      scope: 'clientId in tenants (direct)',
      count: (tx) => tx.outletTypeClientConfig.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.outletTypeClientConfig
          .deleteMany({ where: { clientId: In } })
          .then((r) => r.count),
    },

    // ── Outlet tree ────────────────────────────────────────────────────────
    {
      // OutletGeoHistory → outlet.clientId.
      model: 'OutletGeoHistory',
      scope: 'outlet.clientId in tenants',
      count: (tx) =>
        tx.outletGeoHistory.count({ where: { outlet: { clientId: In } } }),
      del: (tx) =>
        tx.outletGeoHistory
          .deleteMany({ where: { outlet: { clientId: In } } })
          .then((r) => r.count),
    },

    // ── Hierarchy / assignment tree ────────────────────────────────────────
    {
      // SalesUserAssignment → salesUser.clientId (partner/outlet are SetNull).
      model: 'SalesUserAssignment',
      scope: 'salesUser.clientId in tenants',
      count: (tx) =>
        tx.salesUserAssignment.count({
          where: { salesUser: { clientId: In } },
        }),
      del: (tx) =>
        tx.salesUserAssignment
          .deleteMany({ where: { salesUser: { clientId: In } } })
          .then((r) => r.count),
    },
    {
      // Outlet → clientId. Partner FK is SetNull; salesAssignments + geoHistory +
      // visibilitySubmissions gone above. Delete before ChannelPartner/OutletType.
      model: 'Outlet',
      scope: 'clientId in tenants (direct)',
      count: (tx) => tx.outlet.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.outlet.deleteMany({ where: { clientId: In } }).then((r) => r.count),
    },
    {
      // ChannelPartner → clientId. All children (wallets, redemptions, payouts,
      // visibility subs, leaderboard entries, sales assignments) gone above.
      // user FK is Cascade — but we delete User explicitly later for clarity.
      model: 'ChannelPartner',
      scope: 'clientId in tenants (direct)',
      count: (tx) => tx.channelPartner.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.channelPartner
          .deleteMany({ where: { clientId: In } })
          .then((r) => r.count),
    },
    {
      // SalesUser → clientId. assignments gone above; subordinates self-ref —
      // delete leaf-first within tenant (reportingTo has no onDelete).
      model: 'SalesUser',
      scope: 'clientId in tenants (direct, leaf-first within tenant)',
      count: (tx) => tx.salesUser.count({ where: { clientId: In } }),
      del: async (tx) => {
        let total = 0;
        for (let guard = 0; guard < 1000; guard++) {
          const remaining = await tx.salesUser.count({
            where: { clientId: In },
          });
          if (remaining === 0) break;
          const r = await tx.salesUser.deleteMany({
            where: { clientId: In, subordinates: { none: {} } },
          });
          total += r.count;
          if (r.count === 0) {
            const rest = await tx.salesUser.deleteMany({
              where: { clientId: In },
            });
            total += rest.count;
            break;
          }
        }
        return total;
      },
    },
    {
      model: 'SalesHierarchyLevel',
      scope: 'clientId in tenants (direct)',
      count: (tx) => tx.salesHierarchyLevel.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.salesHierarchyLevel
          .deleteMany({ where: { clientId: In } })
          .then((r) => r.count),
    },

    // ── User-owned smoke-test side-effects + the users themselves ──────────
    {
      // OtpCode → user.clientId (userId nullable → only delete rows tied to a
      // tenant user; truly-anonymous OTPs with null userId are left alone).
      model: 'OtpCode',
      scope: 'user.clientId in tenants (null-userId rows skipped)',
      count: (tx) => tx.otpCode.count({ where: viaUser }),
      del: (tx) =>
        tx.otpCode.deleteMany({ where: viaUser }).then((r) => r.count),
    },
    {
      // UserSession → user.clientId (it also carries clientId directly; we scope
      // by the user relation so it can't outlive its user).
      model: 'UserSession',
      scope: 'user.clientId in tenants',
      count: (tx) => tx.userSession.count({ where: viaUser }),
      del: (tx) =>
        tx.userSession.deleteMany({ where: viaUser }).then((r) => r.count),
    },
    {
      // LoginLog → user.clientId.
      model: 'LoginLog',
      scope: 'user.clientId in tenants',
      count: (tx) => tx.loginLog.count({ where: viaUser }),
      del: (tx) =>
        tx.loginLog.deleteMany({ where: viaUser }).then((r) => r.count),
    },
    {
      // AuditLog → actor/target User (both SetNull, nullable). Delete rows where
      // EITHER party is a tenant user so we don't leave dangling tenant audit data.
      model: 'AuditLog',
      scope: 'actor.clientId in tenants OR targetUser.clientId in tenants',
      count: (tx) =>
        tx.auditLog.count({
          where: {
            OR: [{ actor: { clientId: In } }, { targetUser: { clientId: In } }],
          },
        }),
      del: (tx) =>
        tx.auditLog
          .deleteMany({
            where: {
              OR: [
                { actor: { clientId: In } },
                { targetUser: { clientId: In } },
              ],
            },
          })
          .then((r) => r.count),
    },
    {
      // User → clientId. LAST tenant-owned delete. All FK children handled above
      // or are Cascade. The "gifsy" platform admin is NOT in `clientIds`, so safe.
      model: 'User',
      scope: 'clientId in tenants (direct)',
      count: (tx) => tx.user.count({ where: { clientId: In } }),
      del: (tx) =>
        tx.user.deleteMany({ where: { clientId: In } }).then((r) => r.count),
    },
  ];

  return steps;
}

/** Collect the ids of every VisibilitySubmission owned by the target tenants. */
async function tenantSubmissionIds(
  tx: Prisma.TransactionClient,
  clientIds: string[],
): Promise<string[]> {
  const rows = await tx.visibilitySubmission.findMany({
    where: { partner: { clientId: { in: clientIds } } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const clientIds = parseClientIds();
  const dryRun = isDryRun();

  console.log('🧹  Tenant-data wipe');
  console.log(`    target tenants : ${clientIds.join(', ')}`);
  console.log(`    mode           : ${dryRun ? 'DRY-RUN (no deletes)' : 'REAL WIPE'}`);
  console.log('');

  // Guard order matters: cheapest/most-protective first.
  assertNoProtectedTenant(clientIds);
  const dbName = await assertTargetDatabase();
  assertConfirmationToken(dbName, clientIds);

  console.log('');
  console.log(`   All guards passed. Building delete plan…`);

  const steps = buildSteps(clientIds);
  const summary: { model: string; scope: string; count: number }[] = [];

  if (dryRun) {
    // DRY-RUN: count each step. Read-only → NO transaction needed (and wrapping all 69
    // counts in one interactive tx hits Prisma's 5s default timeout — caught by the dev
    // dry-run). ZERO deletes.
    for (const step of steps) {
      const n = await step.count(prisma);
      summary.push({ model: step.model, scope: step.scope, count: n });
    }
  } else {
    // REAL WIPE: count-then-delete each step, all inside ONE transaction so a
    // failure rolls the whole thing back (never half-wiped).
    await prisma.$transaction(
      async (tx) => {
        for (const step of steps) {
          const n = await step.del(tx);
          summary.push({ model: step.model, scope: step.scope, count: n });
        }
      },
      // Generous timeout: 69 relation-scoped deletes on a large prod dataset can be slow
      // (the dev dry-run showed even counts take ~5s). Run in a maintenance window; if it
      // still times out, raise this / split. maxWait covers pool-acquire under load.
      { timeout: 600_000, maxWait: 15_000 },
    );
  }

  // ── Print the per-table summary ─────────────────────────────────────────
  console.log('');
  console.log(`   ┌─ ${dryRun ? 'WOULD DELETE' : 'DELETED'} (FK-safe order) ─────────────`);
  let totalRows = 0;
  for (const row of summary) {
    totalRows += row.count;
    const label = row.model.padEnd(28);
    const count = String(row.count).padStart(8);
    console.log(`   │ ${label} ${count}   [${row.scope}]`);
  }
  console.log(`   └─ total rows: ${totalRows}`);
  console.log('');
  console.log(
    dryRun
      ? '✅  DRY-RUN complete — nothing was deleted. ' +
          'Re-run with WIPE_DRY_RUN=false (+ token) to perform the wipe.'
      : `✅  WIPE complete on "${dbName}" — ${totalRows} rows deleted across ${summary.length} tables.`,
  );
}

main()
  .catch((err) => {
    console.error('❌  Wipe failed (transaction rolled back — no partial delete):');
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
