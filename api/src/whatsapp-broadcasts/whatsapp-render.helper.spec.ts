import {
  deriveVariables,
  renderBody,
  templateVariableCount,
  variableIndexes,
} from './whatsapp-render.helper';

describe('whatsapp-render.helper (pure)', () => {
  describe('variableIndexes / templateVariableCount', () => {
    it('finds distinct 1-based placeholders in a body', () => {
      expect(variableIndexes('Hi {{1}}, your code {{2}} for {{1}}')).toEqual([1, 2]);
      expect(variableIndexes('no vars here')).toEqual([]);
    });
    it('prefers the contract length, falls back to the max body placeholder', () => {
      expect(templateVariableCount('Hi {{1}} {{2}}', [{ index: 1 }, { index: 2 }, { index: 3 }])).toBe(3);
      expect(templateVariableCount('Hi {{1}} {{2}}', null)).toBe(2);
      expect(templateVariableCount('none', [])).toBe(0);
    });
  });

  describe('deriveVariables (FILTER mapping)', () => {
    const fields = { ownerName: 'Asha', outletCode: 'OUT99', zone: 'North' };
    it('constant value wins over source', () => {
      const out = deriveVariables(fields, [{ index: 1, source: 'ownerName', value: 'FIXED' }], 1);
      expect(out).toEqual(['FIXED']);
    });
    it('reads a source field when no constant', () => {
      const out = deriveVariables(fields, [{ index: 1, source: 'ownerName' }, { index: 2, source: 'zone' }], 2);
      expect(out).toEqual(['Asha', 'North']);
    });
    it('unmapped or unknown-source indexes become empty, output is dense + ordered', () => {
      const out = deriveVariables(fields, [{ index: 2, source: 'missing' }], 3);
      expect(out).toEqual(['', '', '']);
    });
  });

  describe('renderBody', () => {
    it('substitutes ordered variables into {{n}} placeholders', () => {
      expect(renderBody('Hi {{1}}, code {{2}}', ['Asha', 'X9'])).toBe('Hi Asha, code X9');
    });
    it('a missing value renders empty (never a literal placeholder)', () => {
      expect(renderBody('Hi {{1}} {{2}}', ['Asha'])).toBe('Hi Asha ');
    });
  });
});
