/**
 * Builds the "X units to go · Y days left" message used in the
 * Sales vs Target card on the partner dashboard.
 *
 * Consistent format regardless of whether the outlet is on pace or behind —
 * mirrors the language shown in the red (behind-pace) badge on outlet cards.
 */
export function buildCasesToGoMsg(
  remaining: number,
  unit: string,
  daysLeft: number,
): string {
  const dayWord = daysLeft === 1 ? 'day' : 'days';
  return `${fmtRemaining(remaining)} ${unit} to go · ${daysLeft} ${dayWord} left`;
}

/**
 * The "X to go" amount as a WHOLE number with Indian digit grouping (e.g. 6,74,972).
 * Targets/achievements arrive as fractional values (client target files carry decimals), so the
 * raw difference rendered as "674971.2084833332". Rounded UP: anything still remaining shows at
 * least 1 — never a misleading "0 to go" while the target is not yet met. 0 / negative / NaN → "0".
 */
export function fmtRemaining(remaining: number): string {
  if (!Number.isFinite(remaining) || remaining <= 0) return '0';
  return Math.max(1, Math.ceil(remaining)).toLocaleString('en-IN');
}

// ─── Pace classification ─────────────────────────────────────────────────────

export type PaceStatus = 'green' | 'amber' | 'red';

/**
 * Classifies a pace gap into green / amber / red.
 *
 * The amber zone uses a **relative** threshold: the gap must be within
 * `amberThreshold`% of `timePct`. This is more stringent than an absolute
 * percentage-point cutoff and scales naturally through the month.
 *
 * Example (amberThreshold = 10, timePct = 40):
 *   amber window = 40 × 0.10 = 4 pp → achievedPct must be ≥ 36% to stay amber
 *
 * @param gap            timePct − achievedPct  (negative = ahead of pace)
 * @param timePct        % of period elapsed (0–100)
 * @param amberThreshold configurable threshold stored in GifsySettings (default 10)
 */
export function classifyPaceGap(
  gap: number,
  timePct: number,
  amberThreshold: number,
): PaceStatus {
  if (gap <= 0) return 'green';
  if (gap <= timePct * (amberThreshold / 100)) return 'amber';
  return 'red';
}
