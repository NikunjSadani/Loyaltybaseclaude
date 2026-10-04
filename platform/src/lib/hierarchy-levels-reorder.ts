/**
 * Employee Rewards — pure helpers for the hierarchy-levels editor's REORDER guardrail (F5).
 *
 * The backend reconcile (reconcileLevelsToConfig) matches employees to levels by POSITION, so
 * reordering levels in the editor re-roles everyone at a moved position. These helpers let the
 * editor detect a reorder and quantify its impact so it can confirm before saving. Kept pure (no
 * React) so they are unit-tested directly.
 */
import type { HierarchyUserRole } from '@/types';

export interface LevelDraft {
  roleCode: string;
  roleLabel: string;
  isLeaf: boolean;
  isRoot: boolean;
  userRole: HierarchyUserRole | '';
}

/**
 * Codes present in BOTH the baseline and the current rows but now at a DIFFERENT position = a
 * reorder. Rename (a new code at the same position), add, remove, and in-place role changes do NOT
 * count — only an existing level that moved. Returns human-readable "CODE: Lx → Ly" moves.
 */
export function detectReorderMoves(baseline: LevelDraft[], rows: LevelDraft[]): string[] {
  const basePos = new Map<string, number>();
  baseline.forEach((b, i) => {
    const c = b.roleCode.trim().toUpperCase();
    if (c) basePos.set(c, i);
  });
  const moves: string[] = [];
  rows.forEach((r, i) => {
    const c = r.roleCode.trim().toUpperCase();
    if (!c) return;
    const was = basePos.get(c);
    if (was !== undefined && was !== i) moves.push(`${r.roleCode.trim()}: L${was + 1} → L${i + 1}`);
  });
  return moves;
}

/**
 * Employees who will be re-roled (and signed out) by this save: those sitting at a position whose
 * mapped role differs from the baseline at that same position (the reconcile keeps employees at
 * their position and applies the position's new role). `countByLevel` is level-number → headcount.
 */
export function affectedEmployeeCount(
  baseline: LevelDraft[],
  rows: LevelDraft[],
  countByLevel: Record<number, number>,
): number {
  let n = 0;
  for (let i = 0; i < rows.length; i++) {
    if (baseline[i]?.userRole !== rows[i].userRole) n += countByLevel[i + 1] ?? 0;
  }
  return n;
}
