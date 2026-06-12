/// <reference types="vitest/globals" />
/**
 * TDD — Target configuration fixes
 *
 * RED phase: all tests fail before implementation.
 *
 * Changes under test:
 *  1. lib/targets.ts   — isMonthLocked: current month must NOT be locked
 *  2. admin/targets/page.tsx — KPI delete button must use a visible colour (not text-gray-300)
 */

import { readFileSync } from 'fs';
import { resolve }      from 'path';
import { describe, it, expect } from 'vitest';

const src = (rel: string) =>
  readFileSync(resolve(__dirname, '../..', rel), 'utf-8');

// ─── A: isMonthLocked logic ───────────────────────────────────────────────────

import { isMonthLocked, CURRENT_MONTH, getMonthOptions } from '../targets';

describe('A — isMonthLocked: current month is editable', () => {
  it('A1: CURRENT_MONTH is not locked (admins can adjust in-flight month targets)', () => {
    expect(isMonthLocked(CURRENT_MONTH)).toBe(false);
  });

  it('A2: a month in the past is still locked', () => {
    // Build a month that is definitely in the past: 2 months ago
    const d = new Date();
    d.setMonth(d.getMonth() - 2);
    const past = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    expect(isMonthLocked(past)).toBe(true);
  });

  it('A3: one month before CURRENT_MONTH is locked', () => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    const prev = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    expect(isMonthLocked(prev)).toBe(true);
  });

  it('A4: the month after CURRENT_MONTH is not locked', () => {
    const d = new Date();
    d.setMonth(d.getMonth() + 1);
    const next = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    expect(isMonthLocked(next)).toBe(false);
  });

  it('A5: getMonthOptions marks CURRENT_MONTH as not locked', () => {
    const opts = getMonthOptions();
    const current = opts.find(o => o.value === CURRENT_MONTH);
    expect(current).toBeDefined();
    expect(current!.locked).toBe(false);
  });

  it('A6: isMonthLocked uses strict less-than (not less-than-or-equal)', () => {
    // Confirm the fix: the old condition was <= , the new correct one is <
    const code = src('lib/targets.ts');
    // Must contain `month < CURRENT_MONTH` (strict less-than)
    expect(code).toMatch(/month\s*<\s*CURRENT_MONTH/);
    // Must NOT contain `month <= CURRENT_MONTH`
    expect(code).not.toMatch(/month\s*<=\s*CURRENT_MONTH/);
  });
});

// ─── B: KPI delete button is visible ─────────────────────────────────────────

describe('B — admin/targets/page.tsx KPI delete button colour', () => {
  const code = src('app/admin/targets/page.tsx');

  it('B1: delete button does NOT use text-gray-300 (too faint)', () => {
    // text-gray-300 is barely visible on a white/light background.
    // The delete button specifically should not use it.
    // We look for the Trash2 button near "removeKpi" to be precise.
    // Approach: check that the removeKpi button line doesn't have text-gray-300.
    const trashBtnMatch = code.match(/removeKpi[\s\S]{0,300}Trash2|Trash2[\s\S]{0,300}removeKpi/);
    expect(trashBtnMatch).not.toBeNull();
    // The matched region must not contain text-gray-300
    expect(trashBtnMatch![0]).not.toMatch(/text-gray-300/);
  });

  it('B2: delete button uses a visible grey (text-gray-400 or darker)', () => {
    // Extract the button that calls removeKpi and check it has a darker default colour.
    // Accept text-gray-400, text-gray-500, text-gray-600.
    const trashBtnMatch = code.match(/removeKpi[\s\S]{0,300}Trash2|Trash2[\s\S]{0,300}removeKpi/);
    expect(trashBtnMatch).not.toBeNull();
    expect(trashBtnMatch![0]).toMatch(/text-gray-[456]/);
  });

  it('B3: delete button still has a red hover state (UX confirmation)', () => {
    const trashBtnMatch = code.match(/removeKpi[\s\S]{0,300}Trash2|Trash2[\s\S]{0,300}removeKpi/);
    expect(trashBtnMatch).not.toBeNull();
    expect(trashBtnMatch![0]).toMatch(/hover:text-red-/);
  });
});
