import { currentMonthKey } from '../../targets/targets.helpers';
import {
  isMonthKey,
  lastDayOfMonth,
  monthLabel,
  previousMonthKey,
  resolveMonthState,
  shiftMonthKey,
} from './month-state';

// Date-relative (never hardcode "now"): every month below is derived from the real current IST month.
const CURRENT = currentMonthKey();
const NEXT = shiftMonthKey(CURRENT, 1);
const PREV = shiftMonthKey(CURRENT, -1);
const OLDER = shiftMonthKey(CURRENT, -2);
const MUCH_OLDER = shiftMonthKey(CURRENT, -14);
const AT = new Date();

describe('month helpers', () => {
  it('previous/shift roll the year', () => {
    expect(previousMonthKey('2026-01')).toBe('2025-12');
    expect(shiftMonthKey('2025-12', 1)).toBe('2026-01');
    expect(shiftMonthKey('2026-03', -14)).toBe('2025-01');
  });
  it('lastDayOfMonth handles leap years', () => {
    expect(lastDayOfMonth('2028-02')).toBe('2028-02-29');
    expect(lastDayOfMonth('2026-02')).toBe('2026-02-28');
    expect(lastDayOfMonth('2026-12')).toBe('2026-12-31');
  });
  it('isMonthKey is strict', () => {
    expect(isMonthKey('2026-05')).toBe(true);
    expect(isMonthKey('2026-13')).toBe(false);
    expect(isMonthKey('2026-5')).toBe(false);
    expect(isMonthKey(202605)).toBe(false);
  });
  it('monthLabel', () => expect(monthLabel('2026-05')).toBe('May 2026'));
});

describe('resolveMonthState — exhaustive table (relation × override)', () => {
  type Row = [string, string, { state: string; closedAt?: Date | null; reopenedAt?: Date | null } | null, string, boolean, boolean, boolean, boolean];
  // [name, month, override, state, implicit, appliable, canClose, canReopen]
  const table: Row[] = [
    ['future, none', NEXT, null, 'OPEN', true, false, false, false],
    ['future, OPEN', NEXT, { state: 'OPEN', reopenedAt: AT }, 'OPEN', true, false, false, false],
    ['future, CLOSED (ignored)', NEXT, { state: 'CLOSED', closedAt: AT }, 'OPEN', true, false, false, false],
    ['current, none', CURRENT, null, 'OPEN', true, true, false, false],
    ['current, OPEN', CURRENT, { state: 'OPEN', reopenedAt: AT }, 'OPEN', false, true, false, false],
    ['current, CLOSED (ignored: current is always OPEN)', CURRENT, { state: 'CLOSED', closedAt: AT }, 'OPEN', false, true, false, false],
    ['previous, none → OPEN', PREV, null, 'OPEN', true, true, true, false],
    ['previous, OPEN', PREV, { state: 'OPEN', reopenedAt: AT }, 'OPEN', false, true, true, false],
    ['previous, CLOSED', PREV, { state: 'CLOSED', closedAt: AT }, 'CLOSED', false, false, false, true],
    ['older, none → CLOSED', OLDER, null, 'CLOSED', true, false, false, true],
    ['older, OPEN (reopened)', OLDER, { state: 'OPEN', reopenedAt: AT }, 'OPEN', false, true, true, false],
    ['older, CLOSED', OLDER, { state: 'CLOSED', closedAt: AT }, 'CLOSED', false, false, false, true],
    ['much older, none → CLOSED', MUCH_OLDER, null, 'CLOSED', true, false, false, true],
    ['previous, garbage override → implicit', PREV, { state: 'WHAT' }, 'OPEN', true, true, true, false],
  ];
  it.each(table)('%s', (_n, month, ov, state, implicit, appliable, canClose, canReopen) => {
    const r = resolveMonthState(month, CURRENT, ov);
    expect(r).toEqual(expect.objectContaining({ state, implicit, appliable, canClose, canReopen }));
  });

  it('a row WITHOUT closedAt/reopenedAt (created by an apply for the last-applied pointer) is NOT an override', () => {
    expect(resolveMonthState(OLDER, CURRENT, { state: 'OPEN' })).toEqual(expect.objectContaining({ state: 'CLOSED', implicit: true }));
    expect(resolveMonthState(PREV, CURRENT, { state: 'CLOSED' })).toEqual(expect.objectContaining({ state: 'OPEN', implicit: true }));
  });

  it('closed → reopened → closed again: the latest action wins', () => {
    expect(resolveMonthState(OLDER, CURRENT, { state: 'OPEN', closedAt: AT, reopenedAt: AT }).state).toBe('OPEN');
    expect(resolveMonthState(OLDER, CURRENT, { state: 'CLOSED', closedAt: AT, reopenedAt: AT }).state).toBe('CLOSED');
  });

  it('relation is classified', () => {
    expect(resolveMonthState(NEXT, CURRENT).relation).toBe('FUTURE');
    expect(resolveMonthState(CURRENT, CURRENT).relation).toBe('CURRENT');
    expect(resolveMonthState(PREV, CURRENT).relation).toBe('PREVIOUS');
    expect(resolveMonthState(OLDER, CURRENT).relation).toBe('OLDER');
  });

  it('January: previous is December of the prior year', () => {
    expect(resolveMonthState('2025-12', '2026-01').relation).toBe('PREVIOUS');
    expect(resolveMonthState('2025-11', '2026-01').state).toBe('CLOSED');
  });
});
