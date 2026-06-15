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

import prisma from '@/lib/prisma';
import { rowToClientConfig } from './client-row';
import type { ClientConfig } from './client-config';

// ─────────────────────────────────────────────────────────────────────────────
// Secret key resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves the per-tenant MSG91 auth key from environment variables.
 *
 * Convention (mirrors the registry):
 *   slug "deoleo"  → env var  DEOLEO_MSG91_AUTH_KEY   fallback: 'DEMO_KEY'
 *   slug "clientb" → env var  CLIENTB_MSG91_AUTH_KEY  fallback: 'DEMO_KEY'
 *
 * The env var name is derived by:
 *   1. Uppercasing the slug
 *   2. Replacing hyphens with underscores (slugs may contain hyphens)
 *   3. Appending _MSG91_AUTH_KEY
 */
function resolveMsg91AuthKey(slug: string): string {
  const envVarName = `${slug.toUpperCase().replace(/-/g, '_')}_MSG91_AUTH_KEY`;
  return process.env[envVarName] ?? 'DEMO_KEY';
}

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
 */
export async function getClientConfigFromDb(
  clientId: string,
): Promise<ClientConfig | null> {
  try {
    const row = await prisma.client.findUnique({
      where: { id: clientId },
    });

    if (!row) return null;

    const secretAuthKey = resolveMsg91AuthKey(clientId);
    return rowToClientConfig(row, secretAuthKey);
  } catch {
    // Log for observability but always fail safe — caller uses registry fallback.
    // We intentionally swallow the error here; the caller's fallback is the
    // safety net.
    return null;
  }
}
