/**
 * Owner decision D1 (2026-11-19, every tenant incl. LEGACY / Deoleo — explicitly approved as a platform-wide change):
 * a 194C payout can NOT be reversed once it is PAID. Gifsy is the 194C deductor across every programme on a PAN, so
 * a paid 194C payout's TDS base, withholding and invoice must never move afterwards. Before PAID (PENDING / FAILED,
 * and PROCESSING's existing "record the UTR first" refusal) nothing changes.
 *
 * "194C" = the entry's EFFECTIVE section — the one frozen at confirm, or for a legacy visibility row with no frozen
 * section the 194C default (tds.helpers effectiveEntrySection, the same rule the TDS reports use).
 */
import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { formatINR } from '../common/money';
import { effectiveEntrySection } from '../tds/tds.helpers';

export const PAID_194C_REFUSAL = "194C payouts can't be reversed once paid";

/** The visibility (separate-payout) field ids among `fieldIds` — the fields whose un-frozen entries default to 194C. */
export async function visibilityFieldIdsOf(
  tx: Prisma.TransactionClient,
  clientId: string,
  fieldIds: string[],
): Promise<Set<string>> {
  const ids = [...new Set(fieldIds)];
  if (ids.length === 0) return new Set();
  const rows = await tx.creditField.findMany({
    where: { clientId, id: { in: ids }, payoutStream: 'VISIBILITY' },
    select: { id: true },
  });
  return new Set((rows ?? []).map((r) => r.id));
}

export function isPaid194C(
  e: { status: string; tdsSection?: string | null; fieldId?: string | null },
  visibilityFieldIds: Set<string>,
): boolean {
  if (String(e.status) !== 'PAID') return false;
  const frozen = e.tdsSection === 'SEC_194R' || e.tdsSection === 'SEC_194C' ? e.tdsSection : null;
  return effectiveEntrySection(frozen, !!e.fieldId && visibilityFieldIds.has(e.fieldId)) === 'SEC_194C';
}

/** Refuse (400, the owner's wording) when any of `entries` is a PAID 194C payout. */
export function assertNoPaid194C(
  entries: Array<{ id: string; amountPaise: bigint; status: string; tdsSection?: string | null; fieldId?: string | null }>,
  visibilityFieldIds: Set<string>,
): void {
  const hit = entries.filter((e) => isPaid194C(e, visibilityFieldIds));
  if (hit.length > 0) {
    throw new BadRequestException(
      `${PAID_194C_REFUSAL} — ${hit.length === 1 ? 'this payout' : `${hit.length} payouts`} (` +
        hit.map((e) => formatINR(e.amountPaise)).join(', ') +
        ') already reached the retailer with 194C TDS settled. Reject this reversal request; settle with the retailer off-platform.',
    );
  }
}
