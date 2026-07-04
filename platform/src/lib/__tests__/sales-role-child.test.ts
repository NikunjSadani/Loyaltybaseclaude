import { describe, it, expect } from 'vitest';
import { childRole, type SalesRole } from '../sales-role';

describe('childRole — immediate subordinate level (KYC-list member-filter label)', () => {
  it('maps each manager role to the level one step down', () => {
    // Drives "All XSR" for an SO, "All SO" for an ASM, etc.
    expect(childRole('SO')).toBe('XSR');
    expect(childRole('ASM')).toBe('SO');
    expect(childRole('RSM')).toBe('ASM');
    expect(childRole('ZNM')).toBe('RSM');
    expect(childRole('NSM')).toBe('ZNM');
  });

  it('returns null for XSR (a leaf — no reports)', () => {
    expect(childRole('XSR')).toBeNull();
  });

  it('the label falls back to "Members" only for a leaf role', () => {
    const label = (r: SalesRole) => `All ${childRole(r) ?? 'Members'}`;
    expect(label('SO')).toBe('All XSR');
    expect(label('ASM')).toBe('All SO');
    expect(label('XSR')).toBe('All Members');
  });
});
