import {
  isFieldEnforced,
  clashIsOutsideGroup,
  checkGroupUniqueness,
  checkPanMatchesGroup,
  type UniquenessPolicy,
} from './partner-group.helper';

const ALL_ON: UniquenessPolicy = { gst: true, phone: true, bank: true, upi: true };
const GST_ONLY: UniquenessPolicy = { gst: true, phone: false, bank: false, upi: false };

describe('partner-group.helper — pure predicates', () => {
  describe('isFieldEnforced', () => {
    it('PAN is always enforced regardless of policy', () => {
      expect(isFieldEnforced('pan', { gst: false, phone: false, bank: false, upi: false })).toBe(true);
    });
    it('policy gates gst/bank/upi', () => {
      expect(isFieldEnforced('gst', GST_ONLY)).toBe(true);
      expect(isFieldEnforced('bank', GST_ONLY)).toBe(false);
      expect(isFieldEnforced('upi', ALL_ON)).toBe(true);
    });
  });

  describe('clashIsOutsideGroup', () => {
    it('ungrouped (null) → any clash is outside', () => {
      expect(clashIsOutsideGroup(null, ['P1'])).toBe(true);
      expect(clashIsOutsideGroup(null, [null])).toBe(true);
    });
    it('grouped + clash shares our parent → inside (allowed)', () => {
      expect(clashIsOutsideGroup('P1', ['P1'])).toBe(false);
      expect(clashIsOutsideGroup('P1', [null, 'P1'])).toBe(false);
    });
    it('grouped + clash in a different/no group → outside (violation)', () => {
      expect(clashIsOutsideGroup('P1', ['P2'])).toBe(true);
      expect(clashIsOutsideGroup('P1', [null])).toBe(true);
      expect(clashIsOutsideGroup('P1', [])).toBe(true);
    });
  });
});

// Minimal mocked Prisma client covering the two models the helper touches.
function mockDb(opts: {
  candidates?: Array<{ id: string; outlets: Array<{ parentId: string | null }> }>;
  parentPan?: string | null;
  siblingPan?: string | null;
}) {
  return {
    channelPartner: {
      findMany: jest.fn().mockResolvedValue(opts.candidates ?? []),
      findUnique: jest.fn().mockResolvedValue({ panNumber: opts.parentPan ?? null }),
    },
    outlet: {
      findFirst: jest.fn().mockResolvedValue(
        opts.siblingPan ? { partner: { panNumber: opts.siblingPan } } : null,
      ),
    },
  } as any;
}

describe('partner-group.helper — checkGroupUniqueness', () => {
  it('passes when there are no clashing partners', async () => {
    const db = mockDb({ candidates: [] });
    const v = await checkGroupUniqueness(db, {
      clientId: 'deoleo',
      ourParentId: null,
      details: { gstNumber: 'GST1', panNumber: 'PAN1' },
      policy: ALL_ON,
    });
    expect(v).toBeNull();
  });

  it('blocks a GST already used by an outlet OUTSIDE the group', async () => {
    const db = mockDb({ candidates: [{ id: 'other', outlets: [{ parentId: null }] }] });
    const v = await checkGroupUniqueness(db, {
      clientId: 'deoleo',
      ourParentId: 'PARENT1',
      details: { gstNumber: 'GST1' },
      policy: GST_ONLY,
    });
    expect(v?.field).toBe('gst');
    expect(v?.reason).toBe('duplicate-outside-group');
  });

  it('allows a GST shared with a sibling in the SAME group', async () => {
    const db = mockDb({ candidates: [{ id: 'sibling', outlets: [{ parentId: 'PARENT1' }] }] });
    const v = await checkGroupUniqueness(db, {
      clientId: 'deoleo',
      ourParentId: 'PARENT1',
      details: { gstNumber: 'GST1' },
      policy: GST_ONLY,
    });
    expect(v).toBeNull();
  });

  it('skips a field the tenant policy does not enforce (bank off)', async () => {
    const db = mockDb({ candidates: [{ id: 'other', outlets: [{ parentId: null }] }] });
    const v = await checkGroupUniqueness(db, {
      clientId: 'deoleo',
      ourParentId: null,
      details: { bankAccountNumber: 'ACC1' },
      policy: GST_ONLY, // bank: false
    });
    expect(v).toBeNull();
  });

  it('PAN: a same-PAN outlet outside an ungrouped outlet is a violation', async () => {
    const db = mockDb({ candidates: [{ id: 'other', outlets: [{ parentId: 'PARENT9' }] }] });
    const v = await checkGroupUniqueness(db, {
      clientId: 'deoleo',
      ourParentId: null,
      details: { panNumber: 'PAN1' },
      policy: { gst: false, phone: false, bank: false, upi: false },
    });
    expect(v?.field).toBe('pan');
  });
});

describe('partner-group.helper — checkPanMatchesGroup', () => {
  it('no-op when ungrouped', async () => {
    const db = mockDb({});
    expect(await checkPanMatchesGroup(db, { clientId: 'd', ourParentId: null, pan: 'PAN1' })).toBeNull();
  });

  it('passes when our PAN equals the group PAN (from the parent)', async () => {
    const db = mockDb({ parentPan: 'PANX' });
    expect(await checkPanMatchesGroup(db, { clientId: 'd', ourParentId: 'P1', pan: 'PANX' })).toBeNull();
  });

  it('blocks when our PAN differs from the group PAN', async () => {
    const db = mockDb({ parentPan: 'PANX' });
    const v = await checkPanMatchesGroup(db, { clientId: 'd', ourParentId: 'P1', pan: 'PANY' });
    expect(v?.reason).toBe('pan-group-mismatch');
  });

  it('falls back to a sibling PAN when the parent has none', async () => {
    const db = mockDb({ parentPan: null, siblingPan: 'PANS' });
    const v = await checkPanMatchesGroup(db, { clientId: 'd', ourParentId: 'P1', pan: 'PANOTHER' });
    expect(v?.reason).toBe('pan-group-mismatch');
  });

  it('passes when the group has no PAN yet (first member sets it)', async () => {
    const db = mockDb({ parentPan: null, siblingPan: null });
    expect(await checkPanMatchesGroup(db, { clientId: 'd', ourParentId: 'P1', pan: 'PANNEW' })).toBeNull();
  });
});
