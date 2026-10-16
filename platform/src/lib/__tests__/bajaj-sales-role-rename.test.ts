import { describe, it, expect } from 'vitest';
import {
  roleLabelFor,
  childRoleLabelFor,
  childRole,
  ROLE_LABELS,
  type SalesRole,
} from '@/lib/sales-role';

// Bajaj-only sales-role nomenclature rename. Internal codes unchanged; only the SHOWN label differs.
// Deoleo (and every non-bajaj slug) MUST be byte-identical to the existing ROLE_LABELS.
describe('Bajaj sales-role rename — roleLabelFor / childRoleLabelFor', () => {
  const CODES: SalesRole[] = ['XSR', 'SO', 'ASM', 'RSM', 'ZNM', 'NSM'];

  it('Deoleo is byte-identical: roleLabelFor("deoleo", code) === ROLE_LABELS[code] for every code', () => {
    for (const c of CODES) {
      expect(roleLabelFor('deoleo', c)).toBe(ROLE_LABELS[c]);
    }
  });

  it('an unknown / empty slug also falls back to the existing ROLE_LABELS (non-bajaj default)', () => {
    for (const c of CODES) {
      expect(roleLabelFor('', c)).toBe(ROLE_LABELS[c]);
      expect(roleLabelFor('someotherclient', c)).toBe(ROLE_LABELS[c]);
    }
  });

  it('Bajaj shows the short display labels (XSR→ISR, RSM→SM, ZNM→ZH; SO/ASM/NSM unchanged)', () => {
    expect(roleLabelFor('bajaj', 'XSR')).toBe('ISR');
    expect(roleLabelFor('bajaj', 'SO')).toBe('SO');
    expect(roleLabelFor('bajaj', 'ASM')).toBe('ASM');
    expect(roleLabelFor('bajaj', 'RSM')).toBe('SM');
    expect(roleLabelFor('bajaj', 'ZNM')).toBe('ZH');
    expect(roleLabelFor('bajaj', 'NSM')).toBe('NSM');
  });

  it('Bajaj slug is case/space-insensitive', () => {
    expect(roleLabelFor(' Bajaj ', 'RSM')).toBe('SM');
    expect(roleLabelFor('BAJAJ', 'ZNM')).toBe('ZH');
  });

  it('childRoleLabelFor: Deoleo returns the raw child code; Bajaj returns the child short label', () => {
    // childRole(ASM) = SO (unchanged either way); childRole(ZNM) = RSM → Bajaj "SM".
    expect(childRoleLabelFor('deoleo', 'ASM')).toBe(childRole('ASM')); // 'SO'
    expect(childRoleLabelFor('deoleo', 'ZNM')).toBe('RSM');
    expect(childRoleLabelFor('bajaj', 'ASM')).toBe('SO');
    expect(childRoleLabelFor('bajaj', 'ZNM')).toBe('SM'); // child RSM → Bajaj SM
    expect(childRoleLabelFor('bajaj', 'SO')).toBe('ISR');  // child XSR → Bajaj ISR
    expect(childRoleLabelFor('bajaj', 'XSR')).toBeNull();  // leaf has no child
    expect(childRoleLabelFor('deoleo', 'XSR')).toBeNull();
  });
});
