import type { HubbleOrderResult, HubbleService } from './hubble.service';

/**
 * ONE canary lookup — the shared core of the "no order for this reference" canary rule
 * (RewardsService.verifyHubbleNotFoundCanary and VoucherDispersalService both use it).
 *
 * Hubble's not-found body is not pinned to a documented error code, so before ANY money decision is
 * taken on a `getOrderByReference → null` ("Hubble has no order"), the caller looks up an order Hubble
 * is KNOWN to hold (a delivered Hubble voucher placed on the SAME Hubble account) through the SAME
 * route. Verified only when that lookup comes back as that very order with status SUCCESS (and, when
 * present, the matching reference / Hubble order id).
 *
 * @returns null = verified; otherwise a human-readable reason it was NOT verified. Never throws.
 */
export async function checkHubbleCanaryOrder(
  hubble: Pick<HubbleService, 'getOrderByReference'>,
  canary: { referenceId: string; hubbleOrderRef: string | null },
  budgetMs: number | null = null,
): Promise<string | null> {
  let body: HubbleOrderResult | null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const lookup = hubble.getOrderByReference(canary.referenceId);
    body = budgetMs === null
      ? await lookup
      : await Promise.race([
          lookup,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('canary time budget exhausted')), budgetMs);
            (timer as { unref?: () => void }).unref?.();
          }),
        ]);
  } catch (e) {
    return `canary lookup failed: ${e}`;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (body === null) return 'canary lookup also returned "not found" for an order Hubble delivered';
  const status = (body.status ?? '').toString().toUpperCase();
  if (status !== 'SUCCESS') return `canary lookup returned status ${status || '(none)'}, not SUCCESS`;
  if (body.referenceId != null && body.referenceId !== canary.referenceId) return 'canary lookup returned a different reference';
  const hubbleId = body.id ?? body.orderId ?? null;
  const ref = (canary.hubbleOrderRef ?? '').trim();
  if (hubbleId != null && ref && String(hubbleId) !== ref) return 'canary lookup returned a different Hubble order id';
  return null;
}
