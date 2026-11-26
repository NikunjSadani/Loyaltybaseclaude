import type { Prisma } from '@prisma/client';

/**
 * The per-(client, month) SERVICE-invoice lock (audit fix 2026-11-26). Every writer of a self-billed SERVICE invoice
 * takes it FIRST in its transaction — the manual "Generate invoices" run, the confirm-time generation and the payout
 * cancellation (void / re-issue) — so none of them can race another on the same outlet + month. Transaction-scoped
 * advisory lock(s), taken in one sorted statement (deadlock-free).
 */
export async function lockInvoiceMonths(tx: Prisma.TransactionClient, clientId: string, periods: string[]): Promise<void> {
  const keys = [...new Set(periods.map((p) => `INVMONTH|${clientId}|${p}`))].sort();
  if (keys.length === 0) return;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(k, 0)) FROM unnest(${keys}::text[]) WITH ORDINALITY AS t(k, n) ORDER BY n`;
}
