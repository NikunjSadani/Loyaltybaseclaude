import { isInrUnit } from './format-inr';

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

/**
 * max(0, target − achieved) with floating-point noise snapped to 0: summed fractional values can leave
 * a remainder like 5.5e-17 on a target that IS met, which `fmtRemaining` would show as "1 to go" next to
 * "Target achieved 🎉". Every "remaining / to go" site uses this so the met/green checks and the
 * displayed amount agree.
 */
export function remainingOf(target: number, achieved: number): number {
  const r = (Number(target) || 0) - (Number(achieved) || 0);
  return r > 1e-6 * Math.max(1, Math.abs(Number(target) || 0)) ? r : 0;
}

/**
 * A KPI achieved / target figure for display: Indian digit grouping; INR units as WHOLE rupees, other
 * units (cases, Litre, SKU…) keep up to 2 decimals (integers print as before, just grouped).
 * Fractional client targets used to render raw ("of 1349942.4167 INR"). Non-finite → "0".
 */
export function fmtKpiNum(value: number, unit?: string | null): string {
  if (!Number.isFinite(value)) return '0';
  if (isInrUnit(unit)) return (Math.round(value) || 0).toLocaleString('en-IN');
  const v = Math.round(value * 100) / 100 || 0;
  return v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
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
