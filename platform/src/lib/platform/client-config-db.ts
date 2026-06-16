/**
 * client-config-db.ts — SERVER-ONLY loader for tenant config from the DB.
 *
 * This module reads the Client row from the database and reconstructs a full
 * ClientConfig, re-attaching the per-tenant MSG91 auth key from env.
 *
 * IMPORTANT:
 *  - Never import this in Edge-runtime code (proxy.ts, tenant-resolution.ts).
 *    The Edge runtime cannot use Prisma / Node.js APIs.
 *  - The caller MUST fall back to the in-code registry on null return.
 *  - On any DB error this function catches and returns null (never throws).
 */

// Prevents this module from being bundled into client or Edge code.
import 'server-only';

import prisma from '@/lib/prisma';
import { rowToClientConfig } from './client-row';
import { CLIENT_REGISTRY } from './client-registry';
import type { ClientConfig } from './client-config';

// ─────────────────────────────────────────────────────────────────────────────
// DB loader
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Loads the Client row for the given clientId (= tenant slug) from the DB and
 * returns a fully-reconstructed ClientConfig.
 *
 * Returns null when:
 *  - No row exists for the clientId (new/unknown tenant)
 *  - The DB query throws for any reason (DB down, misconfigured connection, etc.)
 *
 * The caller is responsible for falling back to the in-code registry.
 *
 * Secret resolution: secrets are intentionally NOT stored in the DB. The
 * registry entry's `notifications.msg91AuthKey` is already evaluated from
 * `process.env.<correct-name> ?? '<correct-fallback>'`, so we re-use that as
 * the authoritative secret source. A tenant present in the DB but NOT in the
 * registry will receive the generic 'DEMO_KEY' fallback — a known limitation
 * until a proper per-tenant secret store lands in P7.
 */
export async function getClientConfigFromDb(
  clientId: string,
): Promise<ClientConfig | null> {
  try {
    const row = await prisma.client.findUnique({
      where: { id: clientId },
      // Explicit select that OMITS `partnerClasses`: that column was dropped from the
      // DB when partner classes were retired (World-A de-scaffold), but the platform
      // schema still declares it (stale — the full platform-schema retirement is P4,
      // alongside removing partnerClasses from the row mapper + write path). A
      // select-all throws "column clients.partnerClasses does not exist" on every load.
      select: {
        id: true,
        internalName: true,
        status: true,
        onboardedAt: true,
        branding: true,
        features: true,
        approvalHierarchy: true,
        notifications: true,
        invoicing: true,
        wallet: true,
      },
    });

    if (!row) return null;

    // Source the secret from the registry's own resolution — the registry uses
    // the correctly-named env vars (e.g. CLIENT_B_MSG91_AUTH_KEY for 'clientb'),
    // which cannot be reproduced by mechanical slug transformation.
    const reg = CLIENT_REGISTRY[clientId];
    const secretAuthKey = reg?.notifications.msg91AuthKey ?? 'DEMO_KEY';

    // partnerClasses is no longer persisted (retired) — source it from the CODE
    // registry so config consumers/displays keep working until full retirement (P4).
    return rowToClientConfig(
      { ...row, partnerClasses: reg?.partnerClasses ?? [] },
      secretAuthKey,
    );
  } catch (e) {
    // Log for observability but always fail safe — caller uses registry fallback.
    console.error('[getClientConfigFromDb]', e);
    return null;
  }
}
