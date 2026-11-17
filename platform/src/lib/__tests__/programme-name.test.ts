import { describe, it, expect } from 'vitest';
import { programmeOwnerName, loyaltyProgrammeLabel, tradeLoyaltyProgrammeTitle } from '../programme-name';
import { DEFAULT_CLIENT_CONFIG } from '../platform/default-client-config';

describe('programme-name (tenant name in programme copy)', () => {
  it('uses the tenant display name', () => {
    expect(loyaltyProgrammeLabel('Bajaj Consumer Care Ltd')).toBe('the Bajaj Consumer Care Ltd Loyalty Programme');
    expect(tradeLoyaltyProgrammeTitle('Bajaj Consumer Care Ltd')).toBe('Bajaj Consumer Care Ltd Trade Loyalty Programme');
  });
  it('Deoleo self-declaration PDF heading is unchanged', () => {
    expect(tradeLoyaltyProgrammeTitle('Deoleo India')).toBe('Deoleo India Trade Loyalty Programme');
  });
  it('blank / null / the platform DEFAULT placeholder → neutral copy', () => {
    for (const v of ['', '   ', null, undefined, DEFAULT_CLIENT_CONFIG.branding.displayName]) {
      expect(programmeOwnerName(v)).toBeNull();
      expect(loyaltyProgrammeLabel(v)).toBe('the Loyalty Programme');
      expect(tradeLoyaltyProgrammeTitle(v)).toBe('Trade Loyalty Programme');
    }
  });
  it('trims the name', () => {
    expect(loyaltyProgrammeLabel('  Bajaj Consumer Care Ltd ')).toBe('the Bajaj Consumer Care Ltd Loyalty Programme');
  });
});
