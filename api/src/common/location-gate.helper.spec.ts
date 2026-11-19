import {
  FENCE_BLOCK_ENTITY,
  LOCATION_REQUIRED_FEATURE,
  isLocationRequiredFor,
  recordFenceBlock,
} from './location-gate.helper';

describe('location-gate.helper', () => {
  describe('isLocationRequiredFor', () => {
    it('is ON only for a SALES_* caller when features.requireLocation === true', () => {
      const on = { [LOCATION_REQUIRED_FEATURE]: true };
      for (const role of ['SALES_ISR', 'SALES_SO', 'SALES_ASM', 'SALES_STATE_HEAD', 'SALES_HO']) {
        expect(isLocationRequiredFor(on, role)).toBe(true);
      }
    });

    it('is OFF for non-sales initiators (partner self-enrollment, admins) even when the flag is on', () => {
      const on = { requireLocation: true };
      for (const role of ['SSS', 'WHOLESALER', 'CLIENT_ADMIN', 'GIFSY_ADMIN', 'MIS_USER']) {
        expect(isLocationRequiredFor(on, role)).toBe(false);
      }
    });

    it('is OFF when the flag is absent / false / not a real boolean (Deoleo default)', () => {
      expect(isLocationRequiredFor({}, 'SALES_ISR')).toBe(false);
      expect(isLocationRequiredFor(null, 'SALES_ISR')).toBe(false);
      expect(isLocationRequiredFor({ requireLocation: false }, 'SALES_ISR')).toBe(false);
      expect(isLocationRequiredFor({ requireLocation: 'true' }, 'SALES_ISR')).toBe(false);
    });
  });

  describe('recordFenceBlock', () => {
    it('writes ONE audit row (REJECT / LOCATION_FENCE_BLOCK) with the flow + distance + tenant', async () => {
      const create = jest.fn().mockResolvedValue({});
      await recordFenceBlock({ auditLog: { create } } as never, {
        actorId: 'u-rep',
        clientId: 'bajaj',
        flow: 'KYC',
        outletId: 'o-1',
        distanceM: 6512.4,
        accuracyM: 12,
      });
      expect(create).toHaveBeenCalledTimes(1);
      const data = create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        action: 'REJECT',
        entityType: FENCE_BLOCK_ENTITY,
        entityId: 'o-1',
        actorId: 'u-rep',
        metadata: { flow: 'KYC', clientId: 'bajaj', distanceM: 6512, accuracyM: 12 },
      });
    });

    it('never throws (a failed audit write must not change the rep-facing refusal)', async () => {
      const create = jest.fn().mockRejectedValue(new Error('db down'));
      await expect(
        recordFenceBlock({ auditLog: { create } } as never, {
          actorId: 'u-rep', clientId: 'bajaj', flow: 'VISIBILITY', outletId: 'o-1', distanceM: null, accuracyM: null,
        }),
      ).resolves.toBeUndefined();
    });
  });
});
