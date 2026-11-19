/**
 * The ONE advisory-lock key for a client's 194R whole-year state: (client, FY). All 194R state is per
 * client, so one key per client+FY is as correct as per-retailer keys and keeps a Bajaj-scale run at a
 * single lock (Cloud SQL lock table ≈ 6,400 slots shared). Taken by the download engine, the UTR
 * FAILED path, reversal approvals and (Wallet Reversal Engine) TDS-credit creation / application.
 */
export function r194LockKey(clientId: string, fyLabel: string): string {
  return `R194|${clientId}|${fyLabel}`;
}
