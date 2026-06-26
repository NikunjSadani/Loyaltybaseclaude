/**
 * Tests for the canonical Indian states + union territories list that backs the
 * KYC "State" searchable dropdown.
 */

import { describe, it, expect } from 'vitest';
import {
  INDIAN_STATES,
  INDIAN_STATE_NAMES,
  INDIAN_UNION_TERRITORY_NAMES,
} from '../indian-states';

describe('INDIAN_STATES', () => {
  it('contains 28 states + 8 union territories = 36 entries', () => {
    expect(INDIAN_STATE_NAMES).toHaveLength(28);
    expect(INDIAN_UNION_TERRITORY_NAMES).toHaveLength(8);
    expect(INDIAN_STATES).toHaveLength(36);
  });

  it('includes the key reorganised union territories', () => {
    for (const ut of [
      'Delhi',
      'Jammu and Kashmir',
      'Ladakh',
      'Puducherry',
      'Andaman and Nicobar Islands',
      'Dadra and Nagar Haveli and Daman and Diu',
      'Lakshadweep',
      'Chandigarh',
    ]) {
      expect(INDIAN_STATES).toContain(ut);
    }
  });

  it('is sorted alphabetically and free of duplicates', () => {
    const sorted = [...INDIAN_STATES].sort((a, b) => a.localeCompare(b));
    expect(INDIAN_STATES).toEqual(sorted);
    expect(new Set(INDIAN_STATES).size).toBe(INDIAN_STATES.length);
  });
});
