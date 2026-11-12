/// <reference types="vitest/globals" />
import { describe, it, expect } from 'vitest';
import { kycDocDisplayLabel, otherDocLabel, OTHER_DOC_FALLBACK_LABEL } from '../kyc-doc-label';

const base = (t: string) => t.replace(/_/g, ' ');

describe('KDL — KYC document display label', () => {
  it('KDL1: non-OTHER types keep the base label even when fileName/metadata.label exist', () => {
    expect(kycDocDisplayLabel(
      { documentType: 'PAN_CARD', fileName: 'Counter photo.jpg', metadata: { label: 'X' } }, base,
    )).toBe('PAN CARD');
  });

  it('KDL2: OTHER prefers metadata.label', () => {
    expect(kycDocDisplayLabel(
      { documentType: 'OTHER', fileName: 'ID proof (Voter ID).pdf', metadata: { label: '  Voter ID card ' } }, base,
    )).toBe('Voter ID card');
  });

  it('KDL3: OTHER falls back to fileName without its extension', () => {
    expect(otherDocLabel({ documentType: 'OTHER', fileName: 'Counter photo.jpg' })).toBe('Counter photo');
    expect(otherDocLabel({ documentType: 'OTHER', fileName: 'ID proof (Driving licence).jpg' }))
      .toBe('ID proof (Driving licence)');
    expect(otherDocLabel({ documentType: 'OTHER', fileName: 'ID proof (Voter ID).pdf', metadata: {} }))
      .toBe('ID proof (Voter ID)');
    expect(otherDocLabel({ documentType: 'OTHER', fileName: 'imports/bajaj/Counter photo.jpeg' }))
      .toBe('Counter photo');
  });

  it('KDL4: OTHER with no usable label/fileName → fallback', () => {
    expect(otherDocLabel({ documentType: 'OTHER' })).toBe(OTHER_DOC_FALLBACK_LABEL);
    expect(otherDocLabel({ documentType: 'OTHER', fileName: '  ', metadata: { label: '' } })).toBe('Other document');
    expect(otherDocLabel({ documentType: 'OTHER', fileName: null, metadata: { label: 42 } })).toBe('Other document');
    expect(otherDocLabel({ documentType: 'OTHER', metadata: ['label'] })).toBe('Other document');
    expect(kycDocDisplayLabel({ documentType: 'OTHER' }, base, 'Other Document')).toBe('Other Document');
  });
});
