/**
 * client-row.ts — pure mapping from ClientConfig to the Prisma Client
 * create/upsert input shape.
 *
 * Rules:
 *  - Pure function; no I/O, no side effects. Safe to import in tests.
 *  - msg91AuthKey is EXCLUDED from the mapped notifications block.
 *    The auth key is a secret; it must live in env / Secret Manager,
 *    never in the clients table.
 *  - onboardedAt (ISO string in ClientConfig) is converted to Date for
 *    Prisma's DateTime field.
 */

import type { ClientConfig, NotificationsConfig } from './client-config';

// ─────────────────────────────────────────────────────────────────────────────
// Notifications without the secret auth key
// ─────────────────────────────────────────────────────────────────────────────

/**
 * NotificationsConfig minus msg91AuthKey.
 * This is the shape stored in the clients.notifications JSON column.
 */
export type SafeNotificationsConfig = Omit<NotificationsConfig, 'msg91AuthKey'>;

/**
 * Strips msg91AuthKey (and any other known secret fields) from
 * the notifications config before it is written to the database.
 */
function stripSecrets(notifications: NotificationsConfig): SafeNotificationsConfig {
  // Destructure to drop msg91AuthKey; spread the rest.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { msg91AuthKey: _secret, ...safe } = notifications;
  return safe;
}

// ─────────────────────────────────────────────────────────────────────────────
// ClientStatus mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps a ClientConfig status string to the Prisma ClientStatus enum value.
 * Using a plain string cast works because the Prisma enum values are identical
 * to the ClientConfig union literals.
 */
type PrismaClientStatus = 'ACTIVE' | 'INACTIVE' | 'ONBOARDING';

// ─────────────────────────────────────────────────────────────────────────────
// Row type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The shape returned by clientConfigToRow — compatible with Prisma's
 * `client.create({ data: ... })` and `client.upsert({ create: ..., update: ... })`.
 */
export interface ClientRow {
  id: string;
  internalName: string;
  status: PrismaClientStatus;
  onboardedAt: Date;
  branding: ClientConfig['branding'];
  features: ClientConfig['features'];
  partnerClasses: ClientConfig['partnerClasses'];
  approvalHierarchy: ClientConfig['approvalHierarchy'];
  /** msg91AuthKey is NOT present — stored in env / Secret Manager only. */
  notifications: SafeNotificationsConfig;
  invoicing: ClientConfig['invoicing'];
  wallet: ClientConfig['wallet'];
}

// ─────────────────────────────────────────────────────────────────────────────
// Main mapping function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts a ClientConfig (in-code registry shape) to the Prisma Client row
 * input shape, ready for `prisma.client.create` or `prisma.client.upsert`.
 *
 * Key invariants:
 *  - row.id === config.slug  (the tenant slug is the PK)
 *  - msg91AuthKey is absent from row.notifications
 *  - onboardedAt is a proper Date object (Prisma DateTime)
 *
 * Pure — no I/O, no Prisma imports. Fully testable without a DB.
 */
export function clientConfigToRow(config: ClientConfig): ClientRow {
  return {
    id:           config.slug,
    internalName: config.internalName,
    status:       config.status as PrismaClientStatus,
    onboardedAt:  new Date(config.onboardedAt),

    branding:          config.branding,
    features:          config.features,
    partnerClasses:    config.partnerClasses,
    approvalHierarchy: config.approvalHierarchy,

    // msg91AuthKey intentionally excluded — secret stays in env / Secret Manager
    notifications:     stripSecrets(config.notifications),

    invoicing: config.invoicing,
    wallet:    config.wallet,
  };
}
