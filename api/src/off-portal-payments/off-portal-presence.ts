/**
 * "Does this client have ANY off-portal payment?" — a per-process cache (60 s) so the partner wallet / ledger reads and
 * the admin nav skip the off-portal query for the (many) clients that have none (audit B7). A confirm in THIS process
 * invalidates it at once; another API instance sees a new client's first upload within 60 s at most (the register
 * screen itself always reads the table directly).
 */
const TTL_MS = 60_000;
const cache = new Map<string, { has: boolean; at: number }>();

export interface PresenceDb {
  offPortalPayment?: { findFirst: (args: { where: { clientId: string }; select: { id: true } }) => Promise<{ id: string } | null> };
}

export async function clientHasOffPortalPayments(db: PresenceDb, clientId: string, now = Date.now()): Promise<boolean> {
  if (!db.offPortalPayment) return false; // narrow unit-test fakes only
  if (typeof db.offPortalPayment.findFirst !== 'function') return true; // a reader without findFirst → just query
  const hit = cache.get(clientId);
  if (hit && now - hit.at < TTL_MS) return hit.has;
  // Voided rows count too (cheap, and a voided-only client still has a register to show).
  const row = await db.offPortalPayment.findFirst({ where: { clientId }, select: { id: true } });
  const has = !!row;
  cache.set(clientId, { has, at: now });
  return has;
}

export function invalidateOffPortalPresence(clientId?: string): void {
  if (clientId) cache.delete(clientId);
  else cache.clear();
}
