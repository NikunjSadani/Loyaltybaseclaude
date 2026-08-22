import {
  deriveTenantCode,
  formatOrderNumber,
  generateTenantOrderNumber,
  orderYearYY,
} from './order-number.helper';

describe('order-number.helper', () => {
  describe('deriveTenantCode', () => {
    it('uppercases + strips non-alphanumerics', () => {
      expect(deriveTenantCode('deoleo')).toBe('DEOLEO');
      expect(deriveTenantCode('acme-foods')).toBe('ACMEFOODS');
      expect(deriveTenantCode('a.b_c')).toBe('ABC');
    });
    it('falls back to TENANT for an empty slug', () => {
      expect(deriveTenantCode('')).toBe('TENANT');
    });
  });

  describe('orderYearYY', () => {
    it('returns the 2-digit IST year', () => {
      expect(orderYearYY(new Date('2026-06-01T00:00:00Z'))).toBe('26');
      // Late-night UTC that is already the next IST day/year is handled via the offset.
      expect(orderYearYY(new Date('2025-12-31T20:00:00Z'))).toBe('26');
    });
  });

  describe('formatOrderNumber', () => {
    it('zero-pads the sequence to 6 digits', () => {
      expect(formatOrderNumber('DEOLEO', '26', 1)).toBe('DEOLEO-26-000001');
      expect(formatOrderNumber('DEOLEO', '26', 42)).toBe('DEOLEO-26-000042');
      expect(formatOrderNumber('DEOLEO', '26', 123456)).toBe('DEOLEO-26-123456');
    });
  });

  describe('generateTenantOrderNumber', () => {
    const makeTx = (existing: string[]) => ({
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue(existing.map((orderNumber) => ({ orderNumber }))),
    });

    it('starts at 000001 when no prior order exists for the tenant+year', async () => {
      const tx = makeTx([]);
      const n = await generateTenantOrderNumber(tx as never, 'deoleo', new Date('2026-06-01T00:00:00Z'));
      expect(n).toBe('DEOLEO-26-000001');
      // Advisory lock is taken before the scan.
      expect(tx.$executeRaw).toHaveBeenCalled();
    });

    it('increments past the current max suffix', async () => {
      const tx = makeTx(['DEOLEO-26-000041']);
      const n = await generateTenantOrderNumber(tx as never, 'deoleo', new Date('2026-06-01T00:00:00Z'));
      expect(n).toBe('DEOLEO-26-000042');
    });

    it('is namespaced per tenant code', async () => {
      const tx = makeTx([]);
      const n = await generateTenantOrderNumber(tx as never, 'acme', new Date('2026-06-01T00:00:00Z'));
      expect(n).toBe('ACME-26-000001');
    });
  });
});
