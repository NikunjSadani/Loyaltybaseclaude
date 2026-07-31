import {
  isFieldEnforced,
  clashIsOutsideGroup,
  checkGroupUniqueness,
  checkPanMatchesGroup,
  normalizePhoneLast10,
  resolveOperableContexts,
  resolveActivePartnerId,
  resolveGroupParentByPhone,
  resolveGroupIdentity,
  type UniquenessPolicy,
} from './partner-group.helper';

const ALL_ON: UniquenessPolicy = { gst: true, phone: true, bank: true, upi: true };
const GST_ONLY: UniquenessPolicy = { gst: true, phone: false, bank: false, upi: false };

describe('partner-group.helper — pure predicates', () => {
  describe('isFieldEnforced', () => {
    it('PAN and GST are ALWAYS enforced regardless of policy (DB-backed golden keys)', () => {
      const allOff = { gst: false, phone: false, bank: false, upi: false };
      expect(isFieldEnforced('pan', allOff)).toBe(true);
      expect(isFieldEnforced('gst', allOff)).toBe(true); // GST is always-on now (has a partial-unique DB index)
    });
    it('policy gates bank/upi only', () => {
      expect(isFieldEnforced('bank', GST_ONLY)).toBe(false);
      expect(isFieldEnforced('upi', ALL_ON)).toBe(true);
      expect(isFieldEnforced('upi', GST_ONLY)).toBe(false);
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
  candidates?: Array<{ id: string; isParent?: boolean; outlets: Array<{ parentId: string | null }> }>;
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

  it('includes PARENTS in the clash search: a parent bank OUTSIDE the group is a violation', async () => {
    // A parent has no owned outlets; its group is its OWN id. Here the parent 'PARENT9' holds the
    // bank but we belong to 'PARENT1' → outside → violation (bank has no DB index, so the check is
    // the only guard — regression test for the "parent bank/UPI slip" audit finding).
    const db = mockDb({ candidates: [{ id: 'PARENT9', isParent: true, outlets: [] }] });
    const v = await checkGroupUniqueness(db, {
      clientId: 'deoleo',
      ourParentId: 'PARENT1',
      details: { bankAccountNumber: 'ACC1' },
      policy: ALL_ON,
    });
    expect(v?.field).toBe('bank');
    expect(v?.reason).toBe('duplicate-outside-group');
  });

  it('allows sharing a value with OUR OWN parent (parent group id == our parentId)', async () => {
    const db = mockDb({ candidates: [{ id: 'PARENT1', isParent: true, outlets: [] }] });
    const v = await checkGroupUniqueness(db, {
      clientId: 'deoleo',
      ourParentId: 'PARENT1',
      details: { bankAccountNumber: 'ACC1' },
      policy: ALL_ON,
    });
    expect(v).toBeNull();
  });

  it('GST is enforced even when policy.gst is false (always-on DB-backed rule)', async () => {
    const db = mockDb({ candidates: [{ id: 'other', outlets: [{ parentId: null }] }] });
    const v = await checkGroupUniqueness(db, {
      clientId: 'deoleo',
      ourParentId: null,
      details: { gstNumber: 'GST1' },
      policy: { gst: false, phone: false, bank: false, upi: false },
    });
    expect(v?.field).toBe('gst');
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

// ── Wave 3: operable-context resolution ───────────────────────────────────────────────────

describe('partner-group.helper — resolveGroupIdentity', () => {
  const idDb = (opts: { parent?: unknown; sibling?: unknown }) =>
    ({
      channelPartner: {
        findUnique: jest.fn().mockResolvedValue(opts.parent ?? null),
        findFirst: jest.fn().mockResolvedValue(opts.sibling ?? null),
      },
    }) as never;

  it('uses the APPROVED parent when it carries details (sibling never queried)', async () => {
    const db = idDb({
      parent: { onboardedAt: new Date(), businessName: 'ParentBiz', ownerName: 'Owner P', panNumber: 'PANP', gstNumber: null, bankName: null, bankAccountNumber: null, bankAccountHolder: null, ifscCode: null, upiId: null },
      sibling: { businessName: 'SibBiz', panNumber: 'PANS' },
    });
    const r = await resolveGroupIdentity(db, 'deoleo', 'PARENT1');
    expect(r?.businessName).toBe('ParentBiz');
    expect(r?.panNumber).toBe('PANP');
    expect((db as { channelPartner: { findFirst: jest.Mock } }).channelPartner.findFirst).not.toHaveBeenCalled();
  });

  it('falls back to an APPROVED sibling when the parent is UNAPPROVED', async () => {
    const db = idDb({
      parent: { onboardedAt: null, businessName: 'ParentBiz', panNumber: 'PANP' },
      sibling: { businessName: 'SibBiz', ownerName: 'Owner S', panNumber: 'PANS', gstNumber: 'GSTS', bankName: 'HDFC', bankAccountNumber: '111', bankAccountHolder: 'S', ifscCode: 'IFS', upiId: 's@upi' },
    });
    const r = await resolveGroupIdentity(db, 'deoleo', 'PARENT1');
    expect(r?.businessName).toBe('SibBiz');
    expect(r?.panNumber).toBe('PANS');
    expect(r?.upiId).toBe('s@upi');
  });

  it('falls back to an APPROVED sibling when the approved parent has NO details', async () => {
    const db = idDb({
      parent: { onboardedAt: new Date(), businessName: null, panNumber: null, gstNumber: null, bankAccountNumber: null, upiId: null },
      sibling: { businessName: 'SibBiz', panNumber: 'PANS' },
    });
    const r = await resolveGroupIdentity(db, 'deoleo', 'PARENT1');
    expect(r?.businessName).toBe('SibBiz');
  });

  it('returns null when nothing in the group is verified yet (no parent details, no approved sibling)', async () => {
    const db = idDb({ parent: { onboardedAt: null }, sibling: null });
    expect(await resolveGroupIdentity(db, 'deoleo', 'PARENT1')).toBeNull();
  });
});

describe('partner-group.helper — normalizePhoneLast10', () => {
  it('reduces to the last 10 digits, stripping non-digits + country code', () => {
    expect(normalizePhoneLast10('+91 98300-11252')).toBe('9830011252');
    expect(normalizePhoneLast10('919830011252')).toBe('9830011252');
    expect(normalizePhoneLast10('9830011252')).toBe('9830011252');
  });
  it('returns null for anything that is not 10 digits', () => {
    expect(normalizePhoneLast10('12345')).toBeNull();
    expect(normalizePhoneLast10('')).toBeNull();
    expect(normalizePhoneLast10(null)).toBeNull();
    expect(normalizePhoneLast10(undefined)).toBeNull();
  });
});

// A where-aware mock: routes findFirst by the shape of its `where`, findMany = siblings.
function ctxDb(opts: {
  own?: { id: string; groupId?: string | null; isParent?: boolean; businessName?: string | null; ownerName?: string | null; outlets?: any[] } | null;
  siblings?: Array<{ id: string; businessName?: string | null; ownerName?: string | null; outlets?: any[] }>;
  parent?: { id: string; businessName?: string | null; ownerName?: string | null } | null;
  sibleById?: { id: string } | null;
}) {
  const findFirst = jest.fn().mockImplementation(({ where }: any) => {
    if (where?.userId) return Promise.resolve(opts.own ?? null); // own lookup
    if (where?.isParent === true) return Promise.resolve(opts.parent ?? null); // parent-by-phone
    if (where?.id) return Promise.resolve(opts.sibleById ?? null); // sibling authorize by id
    return Promise.resolve(null);
  });
  const findMany = jest.fn().mockResolvedValue(opts.siblings ?? []);
  return { channelPartner: { findFirst, findMany } } as any;
}

const OUTLET = [{ id: 'o1', outletCode: 'O001', name: 'Shop', isPrimary: true, createdAt: new Date() }];

describe('partner-group.helper — resolveOperableContexts', () => {
  it('single ungrouped login → exactly one operable context (itself), no siblings, no group', async () => {
    const db = ctxDb({ own: { id: 'P0', groupId: null, businessName: 'A', outlets: OUTLET } });
    const r = await resolveOperableContexts(db, { clientId: 'd', userSub: 'u1', phone: '9830011252' });
    expect(r.ownPartnerId).toBe('P0');
    expect(r.operable.map((o) => o.partnerId)).toEqual(['P0']);
    expect(r.operable[0].isOwnLogin).toBe(true);
    expect(r.groupParent).toBeNull();
    expect(db.channelPartner.findMany).not.toHaveBeenCalled(); // no group → never searches siblings
  });

  it('grouped login sharing a phone → own + login-less same-group same-phone sibling', async () => {
    const db = ctxDb({
      own: { id: 'P0', groupId: 'PAR', businessName: 'A', outlets: OUTLET },
      siblings: [{ id: 'P1', businessName: 'B', outlets: OUTLET }],
    });
    const r = await resolveOperableContexts(db, { clientId: 'd', userSub: 'u1', phone: '9830011252' });
    expect(r.operable.map((o) => o.partnerId)).toEqual(['P0', 'P1']);
    expect(r.operable[1].isOwnLogin).toBe(false);
    // the sibling query is constrained to the login's own group + login-less + phone
    const args = (db.channelPartner.findMany as jest.Mock).mock.calls[0][0];
    expect(args.where.groupId).toBe('PAR');
    expect(args.where.userId).toBeNull();
    expect(args.where.phone.endsWith).toBe('9830011252');
  });

  it('drops a same-group sibling that has no ACTIVE outlet (not operable)', async () => {
    const db = ctxDb({
      own: { id: 'P0', groupId: 'PAR', outlets: OUTLET },
      siblings: [{ id: 'P1', outlets: [] }],
    });
    const r = await resolveOperableContexts(db, { clientId: 'd', userSub: 'u1', phone: '9830011252' });
    expect(r.operable.map((o) => o.partnerId)).toEqual(['P0']);
  });

  it('parent phone with no own outlet → only the read-only group overview', async () => {
    const db = ctxDb({ own: null, parent: { id: 'PAR', businessName: 'Group', ownerName: 'Owner' } });
    const r = await resolveOperableContexts(db, { clientId: 'd', userSub: 'u1', phone: '9830011252' });
    expect(r.ownPartnerId).toBeNull();
    expect(r.operable).toEqual([]);
    expect(r.groupParent).toEqual({ parentId: 'PAR', businessName: 'Group', ownerName: 'Owner' });
  });
});

describe('partner-group.helper — resolveActivePartnerId (the access boundary)', () => {
  it('no selector → own partner (fast path, not switched)', async () => {
    const db = ctxDb({ own: { id: 'P0', groupId: 'PAR' } });
    const r = await resolveActivePartnerId(db, { clientId: 'd', userSub: 'u1', phone: '9830011252' });
    expect(r).toEqual({ partnerId: 'P0', forbidden: false, isSwitched: false });
  });

  it('selector == own → own (not treated as a switch)', async () => {
    const db = ctxDb({ own: { id: 'P0', groupId: 'PAR' } });
    const r = await resolveActivePartnerId(db, { clientId: 'd', userSub: 'u1', phone: '9830011252', requestedPartnerId: 'P0' });
    expect(r).toEqual({ partnerId: 'P0', forbidden: false, isSwitched: false });
  });

  it('selector = a valid operable sibling → authorized switch', async () => {
    const db = ctxDb({ own: { id: 'P0', groupId: 'PAR' }, sibleById: { id: 'P1' } });
    const r = await resolveActivePartnerId(db, { clientId: 'd', userSub: 'u1', phone: '9830011252', requestedPartnerId: 'P1' });
    expect(r).toEqual({ partnerId: 'P1', forbidden: false, isSwitched: true });
  });

  it('selector = an unrelated partner (not in operable set) → FORBIDDEN', async () => {
    const db = ctxDb({ own: { id: 'P0', groupId: 'PAR' }, sibleById: null });
    const r = await resolveActivePartnerId(db, { clientId: 'd', userSub: 'u1', phone: '9830011252', requestedPartnerId: 'EVIL' });
    expect(r.forbidden).toBe(true);
    expect(r.partnerId).toBeNull();
  });

  it('selector on an UNGROUPED login → forbidden (no siblings possible)', async () => {
    const db = ctxDb({ own: { id: 'P0', groupId: null } });
    const r = await resolveActivePartnerId(db, { clientId: 'd', userSub: 'u1', phone: '9830011252', requestedPartnerId: 'P1' });
    expect(r.forbidden).toBe(true);
  });
});

describe('partner-group.helper — resolveGroupParentByPhone', () => {
  it('returns the parent id when a parent carries the phone', async () => {
    const db = ctxDb({ parent: { id: 'PAR' } });
    expect(await resolveGroupParentByPhone(db, { clientId: 'd', phone: '9830011252' })).toBe('PAR');
  });
  it('null when no parent matches / phone invalid', async () => {
    expect(await resolveGroupParentByPhone(ctxDb({ parent: null }), { clientId: 'd', phone: '9830011252' })).toBeNull();
    expect(await resolveGroupParentByPhone(ctxDb({ parent: { id: 'X' } }), { clientId: 'd', phone: '123' })).toBeNull();
  });
});
