/// <reference types="vitest/globals" />
/**
 * Curation-flag CSV helpers (employee-rewards catalogue curation).
 *
 * parseCsvList: comma/newline text → deduped, trimmed, empty-dropped string[]
 * joinCsvList:  string[] | null | undefined → comma-joined text for a text input
 */
import { describe, it, expect } from 'vitest';
import { parseCsvList, joinCsvList } from '../page';

describe('curation CSV helpers', () => {
  it('parses comma + newline separated values, trimming and dropping empties', () => {
    expect(parseCsvList(' ASM , RSM ,\n TSM ')).toEqual(['ASM', 'RSM', 'TSM']);
  });

  it('dedupes repeated tokens', () => {
    expect(parseCsvList('North, North , South')).toEqual(['North', 'South']);
  });

  it('returns [] for blank / whitespace-only input (→ visible to all)', () => {
    expect(parseCsvList('')).toEqual([]);
    expect(parseCsvList('   ,  \n ')).toEqual([]);
  });

  it('joins an array back to comma text, and handles null/undefined', () => {
    expect(joinCsvList(['ASM', 'RSM'])).toBe('ASM, RSM');
    expect(joinCsvList(null)).toBe('');
    expect(joinCsvList(undefined)).toBe('');
    expect(joinCsvList([])).toBe('');
  });
});
