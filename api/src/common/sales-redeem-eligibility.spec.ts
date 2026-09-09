import { isSalesRedeemEnabledForPartner } from './sales-redeem-eligibility';

/**
 * Unit spec for the per-outlet-type sales-assisted redemption resolver. Verifies:
 *  - an explicit stored true/false ALWAYS wins (both directions),
 *  - unset (null) resolves to the preserve-today default: WHOLESALER on, every other type off,
 *  - a partner with no resolvable outlet/type is conservatively OFF (money path).
 */
function makeDb(outlet: unknown, cfg: unknown) {
  return {
    outlet: { findFirst: jest.fn().mockResolvedValue(outlet) },
    outletTypeClientConfig: { findUnique: jest.fn().mockResolvedValue(cfg) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('isSalesRedeemEnabledForPartner', () => {
  it('explicit TRUE wins even for a non-wholesaler type', async () => {
    const db = makeDb({ outletTypeId: 'ot1', outletType: { code: 'SUB_STOCKIST' } }, { salesAssistedRedeemEnabled: true });
    await expect(isSalesRedeemEnabledForPartner(db, 'c1', 'p1')).resolves.toBe(true);
  });

  it('explicit FALSE wins even for a wholesaler', async () => {
    const db = makeDb({ outletTypeId: 'ot1', outletType: { code: 'WHOLESALER' } }, { salesAssistedRedeemEnabled: false });
    await expect(isSalesRedeemEnabledForPartner(db, 'c1', 'p1')).resolves.toBe(false);
  });

  it('unset (no config row) → preserve-today default TRUE for WHOLESALER', async () => {
    const db = makeDb({ outletTypeId: 'ot1', outletType: { code: 'WHOLESALER' } }, null);
    await expect(isSalesRedeemEnabledForPartner(db, 'c1', 'p1')).resolves.toBe(true);
  });

  it('unset (config present but field null) → default FALSE for a non-wholesaler', async () => {
    const db = makeDb({ outletTypeId: 'ot1', outletType: { code: 'SSS' } }, { salesAssistedRedeemEnabled: null });
    await expect(isSalesRedeemEnabledForPartner(db, 'c1', 'p1')).resolves.toBe(false);
  });

  it('no resolvable outlet/type → conservative FALSE', async () => {
    const db = makeDb(null, null);
    await expect(isSalesRedeemEnabledForPartner(db, 'c1', 'p1')).resolves.toBe(false);
  });
});
