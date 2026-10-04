import { describe, it, expect } from 'vitest';
import {
  detectReorderMoves,
  affectedEmployeeCount,
  type LevelDraft,
} from '../hierarchy-levels-reorder';

const L = (roleCode: string, userRole: LevelDraft['userRole']): LevelDraft => ({
  roleCode,
  roleLabel: roleCode,
  isLeaf: false,
  isRoot: false,
  userRole,
});

describe('detectReorderMoves', () => {
  it('flags existing codes that moved to a new position (a swap)', () => {
    const base = [L('XSR', 'SALES_ISR'), L('SO', 'SALES_SO'), L('ASM', 'SALES_ASM')];
    const rows = [L('SO', 'SALES_SO'), L('XSR', 'SALES_ISR'), L('ASM', 'SALES_ASM')];
    expect(detectReorderMoves(base, rows).sort()).toEqual(['SO: L2 → L1', 'XSR: L1 → L2']);
  });

  it('does NOT flag a rename-in-place (new code, same position)', () => {
    const base = [L('XSR', 'SALES_ISR'), L('SO', 'SALES_SO')];
    const rows = [L('FIELD', 'SALES_ISR'), L('SO', 'SALES_SO')];
    expect(detectReorderMoves(base, rows)).toEqual([]);
  });

  it('does NOT flag an in-place role change', () => {
    const base = [L('XSR', 'SALES_ISR'), L('SO', 'SALES_SO')];
    const rows = [L('XSR', 'SALES_ISR'), L('SO', 'SALES_ASM')]; // SO role changed but same position
    expect(detectReorderMoves(base, rows)).toEqual([]);
  });

  it('does NOT flag add or remove (no existing code moved)', () => {
    const base = [L('XSR', 'SALES_ISR'), L('SO', 'SALES_SO')];
    expect(detectReorderMoves(base, [...base, L('ASM', 'SALES_ASM')])).toEqual([]); // add at end
    expect(detectReorderMoves(base, [L('XSR', 'SALES_ISR')])).toEqual([]); // remove SO
  });

  it('is case-insensitive on code matching', () => {
    const base = [L('xsr', 'SALES_ISR'), L('so', 'SALES_SO')];
    const rows = [L('SO', 'SALES_SO'), L('XSR', 'SALES_ISR')];
    expect(detectReorderMoves(base, rows).length).toBe(2);
  });
});

describe('affectedEmployeeCount', () => {
  it('sums employees at positions whose mapped role changed', () => {
    const base = [L('XSR', 'SALES_ISR'), L('SO', 'SALES_SO'), L('ASM', 'SALES_ASM')];
    const rows = [L('SO', 'SALES_SO'), L('XSR', 'SALES_ISR'), L('ASM', 'SALES_ASM')]; // pos1+pos2 roles change
    expect(affectedEmployeeCount(base, rows, { 1: 10, 2: 3, 3: 1 })).toBe(13); // 10 + 3, pos3 unchanged
  });

  it('is 0 when no position changed role (pure rename, roles preserved by position)', () => {
    const base = [L('XSR', 'SALES_ISR'), L('SO', 'SALES_SO')];
    const rows = [L('FIELD', 'SALES_ISR'), L('MGR', 'SALES_SO')];
    expect(affectedEmployeeCount(base, rows, { 1: 5, 2: 2 })).toBe(0);
  });

  it('treats a missing headcount as 0', () => {
    const base = [L('XSR', 'SALES_ISR')];
    const rows = [L('XSR', 'SALES_HO')]; // role changed at pos1 but no count known
    expect(affectedEmployeeCount(base, rows, {})).toBe(0);
  });
});
