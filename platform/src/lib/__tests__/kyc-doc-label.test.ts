/// <reference types="vitest/globals" />
import { describe, it, expect } from 'vitest';
import { kycDocDisplayLabel, metadataLabel } from '../kyc-doc-label';

const base = (t: string) => t.replace(/_/g, ' ');

describe('KDL — KYC document display label', () => {
  it('KDL1: non-OTHER types keep the base label even when metadata.label exists', () => {
    expect(kycDocDisplayLabel({ documentType: 'PAN_CARD', metadata: { label: 'X' } }, base)).toBe('PAN CARD');
  });

  it('KDL2: OTHER with a non-blank metadata.label shows it (trimmed)', () => {
    expect(kycDocDisplayLabel({ documentType: 'OTHER', metadata: { label: '  Voter ID card ' } }, base))
      .toBe('Voter ID card');
  });

  it('KDL3: OTHER WITHOUT a usable metadata.label renders exactly the base label (existing tenants unchanged)', () => {
    for (const metadata of [undefined, null, {}, { label: '' }, { label: '   ' }, { label: 42 }, ['label'], 'label']) {
      expect(kycDocDisplayLabel({ documentType: 'OTHER', metadata }, base)).toBe('OTHER');
    }
  });

  it('KDL4: fileName is never used as a label', () => {
    const doc = { documentType: 'OTHER', fileName: 'Counter photo.jpg' } as { documentType: string; fileName: string };
    expect(kycDocDisplayLabel(doc, base)).toBe('OTHER');
  });

  it('KDL5: metadataLabel guards', () => {
    expect(metadataLabel({ label: ' A ' })).toBe('A');
    expect(metadataLabel({ label: ' ' })).toBeNull();
    expect(metadataLabel(null)).toBeNull();
  });
});
