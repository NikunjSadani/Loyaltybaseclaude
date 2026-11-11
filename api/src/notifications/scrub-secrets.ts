/**
 * Replace every occurrence of each secret (longest first, so a combined "code | PIN: x" value goes
 * before its parts) with "••••". Blank secrets are ignored; no secrets → the text unchanged.
 * Used to keep caller-flagged secrets (a voucher code / gift-card PIN) out of anything stored or
 * logged about a failed send (MessageDeliveryReceipt.failureReason, app logs).
 */
export function scrubSecrets(text: string, secrets: readonly (string | null | undefined)[] | undefined): string {
  if (!secrets?.length) return text;
  const list = [
    ...new Set(
      secrets
        .flatMap((v) => (typeof v === 'string' ? [v, v.trim()] : []))
        .filter((v) => v.trim() !== ''),
    ),
  ].sort((a, b) => b.length - a.length);
  let out = text;
  for (const v of list) out = out.split(v).join('••••');
  return out;
}
