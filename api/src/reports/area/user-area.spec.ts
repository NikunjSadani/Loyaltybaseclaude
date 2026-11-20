import {
  AREA_MAX_VALUES,
  AREA_NOT_IN_HIERARCHY,
  AREA_NOT_SET,
  buildUserAreaResolver,
  formatAreaValues,
  loadUserAreaResolver,
  type AreaPrisma,
} from './user-area';

const LEVELS = [
  { code: 'XSR', name: 'XSR', level: 1 },
  { code: 'SO', name: 'SO', level: 2 },
  { code: 'ASM', name: 'Area Manager', level: 3 },
  { code: 'RSM', name: 'RSM', level: 4 },
  { code: 'ZNM', name: 'ZNM', level: 5 },
  { code: 'NSM', name: 'NSM', level: 6 },
];

function su(
  id: string,
  code: string,
  reportingToId: string | null,
  over: Partial<{ isActive: boolean; deletedAt: Date | null; zone: string | null; name: string; status: string; employeeCode: string }> = {},
) {
  return {
    id,
    userId: `u-${id}`,
    reportingToId,
    isActive: over.isActive ?? true,
    deletedAt: over.deletedAt ?? null,
    employeeCode: over.employeeCode ?? id.toUpperCase(),
    zone: over.zone ?? null,
    hierarchyLevel: { code },
    user: { name: over.name ?? `${id} name`, status: over.status ?? 'ACTIVE' },
  };
}

function outlet(id: string, o: Partial<{ partnerId: string | null; owner: string | null; head: string | null; isPrimary: boolean; createdAt: string; zone: string | null; state: string; city: string }>) {
  return {
    id,
    partnerId: o.partnerId ?? null,
    isPrimary: o.isPrimary ?? false,
    createdAt: new Date(o.createdAt ?? '2026-01-01T00:00:00Z'),
    zone: o.zone ?? null,
    state: o.state ?? '',
    city: o.city ?? '',
    partner: o.owner ? { userId: o.owner } : null,
    parent: o.head ? { userId: o.head } : null,
  };
}

function fixtures() {
  const salesUsers = [
    su('nsm', 'NSM', null),
    su('zh', 'ZNM', 'nsm'),
    su('sm', 'RSM', 'zh'),
    su('asm1', 'ASM', 'sm', { name: 'Priya Mehta' }),
    su('so1', 'SO', 'asm1'),
    su('isr1', 'XSR', 'so1'),
    // vacant ASM position (persistHierarchy placeholder: isActive false, user INACTIVE, "(vacant) CODE")
    su('asmV', 'ASM', 'sm', { isActive: false, status: 'INACTIVE', name: '(vacant) ASM-07', employeeCode: 'ASM-07' }),
    su('so2', 'SO', 'asmV'),
    su('so3', 'SO', 'sm'), // reports straight to an SM — no ASM in the chain
    su('so4', 'SO', 'ghost'), // dangling manager link
    su('cyc1', 'SO', 'cyc2'),
    su('cyc2', 'SO', 'cyc1'), // corrupt cycle — must not hang
    su('soZ', 'SO', 'asm1', { zone: '  North-East ' }), // zone typed on the employee record wins
  ];
  const outlets = [
    outlet('o1', { partnerId: 'P1', owner: 'u-ret1', isPrimary: true, zone: 'West', state: 'Maharashtra', city: 'Pune' }),
    outlet('o1b', { partnerId: 'P1', owner: 'u-ret1', zone: 'West', state: 'Gujarat', city: 'Surat', createdAt: '2025-01-01T00:00:00Z' }),
    outlet('o2', { partnerId: 'P2', owner: 'u-ret2', zone: ' ', state: 'Goa', city: '' }),
    outlet('o3', { head: 'u-head', zone: 'South', state: 'Kerala', city: 'Kochi' }),
    outlet('o4', { partnerId: 'P4', owner: 'u-ret4', zone: 'East', state: 'Bihar', city: 'Patna' }),
  ];
  const assignments = [
    { salesUserId: 'isr1', outletId: 'o1', partnerId: null },
    { salesUserId: 'so2', outletId: null, partnerId: 'P2' }, // owner-level assignment → all P2 outlets
    { salesUserId: 'soZ', outletId: 'o4', partnerId: null },
  ];
  return { salesUsers, outlets, assignments };
}

const resolver = (clientId = 'deoleo', levels = LEVELS) => {
  const f = fixtures();
  return buildUserAreaResolver(clientId, levels, f.salesUsers, f.assignments, f.outlets);
};

describe('user area resolver (ASM · Zone · State · City)', () => {
  const r = resolver();
  const sales = (id: string, role = 'SALES_SO') => r.resolve({ id: `u-${id}`, role });

  it('SO / ISR → the ASM above them; geo from their (and their downline’s) assigned outlets', () => {
    expect(sales('isr1', 'SALES_ISR')).toEqual({ asm: 'Priya Mehta', zone: 'West', state: 'Maharashtra', city: 'Pune' });
    expect(sales('so1')).toEqual({ asm: 'Priya Mehta', zone: 'West', state: 'Maharashtra', city: 'Pune' });
  });

  it('an ASM → their own name; geo covers their whole downline', () => {
    expect(sales('asm1', 'SALES_ASM')).toEqual({ asm: 'Priya Mehta', zone: 'East, West', state: 'Bihar, Maharashtra', city: 'Patna, Pune' });
  });

  it('above ASM (SM / ZH / NSM) → ASM blank; geo still from the downline', () => {
    expect(sales('sm', 'SALES_STATE_HEAD')).toEqual({ asm: '', zone: 'East, West', state: 'Bihar, Goa, Maharashtra', city: 'Patna, Pune' });
    expect(sales('nsm', 'SALES_HO').asm).toBe('');
    expect(sales('zh', 'SALES_STATE_HEAD').asm).toBe('');
  });

  it('vacant ASM position → "Vacant (code)" — the vacant territory, NOT the next active manager', () => {
    expect(sales('so2')).toEqual({ asm: 'Vacant (ASM-07)', zone: AREA_NOT_SET, state: 'Goa', city: AREA_NOT_SET });
  });

  it('no ASM in the chain / dangling link / cycle → "Not set", never a crash or a hang', () => {
    expect(sales('so3').asm).toBe(AREA_NOT_SET);
    expect(sales('so4').asm).toBe(AREA_NOT_SET);
    expect(sales('cyc1')).toEqual({ asm: AREA_NOT_SET, zone: AREA_NOT_SET, state: AREA_NOT_SET, city: AREA_NOT_SET });
  });

  it('a zone typed on the employee record wins over outlet zones', () => {
    expect(sales('soZ')).toEqual({ asm: 'Priya Mehta', zone: 'North-East', state: 'Bihar', city: 'Patna' });
  });

  it('a sales login with no employee record → "Not set" everywhere', () => {
    expect(r.resolve({ id: 'u-nobody', role: 'SALES_SO' })).toEqual({
      asm: AREA_NOT_SET, zone: AREA_NOT_SET, state: AREA_NOT_SET, city: AREA_NOT_SET,
    });
  });

  it('retailer / wholesaler → primary outlet geo + the ASM of the rep assigned to that outlet (or its owner)', () => {
    // u-ret1 has o1 (primary) and o1b (older, not primary) → primary wins
    expect(r.resolve({ id: 'u-ret1', role: 'SSS' })).toEqual({ asm: 'Priya Mehta', zone: 'West', state: 'Maharashtra', city: 'Pune' });
    // owner-level assignment to a rep under a vacant ASM; blank zone / city → "Not set"
    expect(r.resolve({ id: 'u-ret2', role: 'WHOLESALER' })).toEqual({ asm: 'Vacant (ASM-07)', zone: AREA_NOT_SET, state: 'Goa', city: AREA_NOT_SET });
    // group head with no own outlet → the group's outlet; no rep → ASM "Not set"
    expect(r.resolve({ id: 'u-head', role: 'SUB_STOCKIST' })).toEqual({ asm: AREA_NOT_SET, zone: 'South', state: 'Kerala', city: 'Kochi' });
    // no outlet at all
    expect(r.resolve({ id: 'u-none', role: 'SSS' })).toEqual({ asm: AREA_NOT_SET, zone: AREA_NOT_SET, state: AREA_NOT_SET, city: AREA_NOT_SET });
  });

  it.each(['CLIENT_ADMIN', 'MIS_USER', 'GIFSY_ADMIN', 'GIFSY_STAFF', 'VENDOR'])('%s → "Not in sales hierarchy"', (role) => {
    expect(r.resolve({ id: 'u-x', role })).toEqual({
      asm: AREA_NOT_IN_HIERARCHY, zone: AREA_NOT_IN_HIERARCHY, state: AREA_NOT_IN_HIERARCHY, city: AREA_NOT_IN_HIERARCHY,
    });
  });

  it("ASM header = the tenant's own level name; Bajaj blank name → rung label; no levels → 'ASM'", () => {
    expect(r.asmHeader).toBe('Area Manager');
    expect(resolver('bajaj', LEVELS.map((l) => ({ ...l, name: '' }))).asmHeader).toBe('ASM');
    const none = resolver('newtenant', []);
    expect(none.asmHeader).toBe('ASM');
    // with no level rows the canonical code order still applies (SO → ASM, SM above ASM)
    expect(none.resolve({ id: 'u-so1', role: 'SALES_SO' }).asm).toBe('Priya Mehta');
    expect(none.resolve({ id: 'u-sm', role: 'SALES_STATE_HEAD' }).asm).toBe('');
  });

  it('notes explain every column and both placeholder words', () => {
    expect(r.notes).toHaveLength(3);
    expect(r.notes[0]).toMatch(/Area Manager this user reports to/);
    expect(r.notes[0]).toMatch(/Vacant \(code\)/);
    expect(r.notes[1]).toMatch(/outlet master/);
    expect(r.notes[2]).toMatch(/"Not set"/);
    expect(r.notes[2]).toMatch(/"Not in sales hierarchy"/);
  });

  it('formatAreaValues: sorted, distinct, trimmed, capped with "+N more", empty → Not set', () => {
    expect(formatAreaValues([' b', 'a', 'b', ''])).toBe('a, b');
    expect(formatAreaValues([])).toBe(AREA_NOT_SET);
    const many = ['G', 'F', 'E', 'D', 'C', 'B', 'A'];
    expect(formatAreaValues(many)).toBe(`A, B, C, D, E +${many.length - AREA_MAX_VALUES} more`);
  });

  it('odd rows (nulls, missing level, missing user) never throw', () => {
    const odd = buildUserAreaResolver(
      'deoleo',
      LEVELS,
      [{ ...su('x', 'SO', null), hierarchyLevel: null, user: null }, null as never],
      [{ salesUserId: 'x', outletId: 'missing', partnerId: 'missing' }, null as never],
      [null as never],
    );
    expect(odd.resolve({ id: 'u-x', role: 'SALES_SO' }).asm).toBe(AREA_NOT_SET);
  });
});

describe('loadUserAreaResolver — reads', () => {
  function fakePrisma(scale = 0) {
    const f = fixtures();
    for (let i = 0; i < scale; i++) {
      f.salesUsers.push(su(`bulk${i}`, 'XSR', 'so1'));
      f.outlets.push(outlet(`bo${i}`, { partnerId: `BP${i}`, owner: `u-bret${i}`, zone: 'West', state: 'Maharashtra', city: `C${i % 7}` }));
      f.assignments.push({ salesUserId: `bulk${i}`, outletId: `bo${i}`, partnerId: null });
    }
    return {
      salesHierarchyLevel: { findMany: jest.fn(async () => LEVELS) },
      salesUser: { findMany: jest.fn(async () => f.salesUsers) },
      salesUserAssignment: { findMany: jest.fn(async () => f.assignments) },
      outlet: { findMany: jest.fn(async () => f.outlets) },
    };
  }

  it('every read is pinned to the tenant', async () => {
    const p = fakePrisma();
    await loadUserAreaResolver(p as unknown as AreaPrisma, 'bajaj');
    expect((p.salesHierarchyLevel.findMany.mock.calls[0] as unknown[])[0]).toMatchObject({ where: { clientId: 'bajaj' } });
    expect((p.salesUser.findMany.mock.calls[0] as unknown[])[0]).toMatchObject({ where: { clientId: 'bajaj' } });
    expect((p.salesUserAssignment.findMany.mock.calls[0] as unknown[])[0]).toMatchObject({
      where: { unassignedAt: null, salesUser: { clientId: 'bajaj', deletedAt: null } },
    });
    expect((p.outlet.findMany.mock.calls[0] as unknown[])[0]).toMatchObject({ where: { clientId: 'bajaj', deletedAt: null } });
  });

  it('2,000 rows → still exactly 4 reads (no per-row query); every row resolved', async () => {
    const p = fakePrisma(2_000);
    const res = await loadUserAreaResolver(p as unknown as AreaPrisma, 'deoleo');
    const out = Array.from({ length: 2_000 }, (_, i) => [
      res.resolve({ id: `u-bulk${i}`, role: 'SALES_ISR' }),
      res.resolve({ id: `u-bret${i}`, role: 'SSS' }),
    ]).flat();
    expect(out.every((a) => a.asm === 'Priya Mehta' && a.state === 'Maharashtra')).toBe(true);
    for (const m of [p.salesHierarchyLevel, p.salesUser, p.salesUserAssignment, p.outlet]) expect(m.findMany).toHaveBeenCalledTimes(1);
    // the ASM's downline now spans 7+ cities → capped cell
    expect(res.resolve({ id: 'u-asm1', role: 'SALES_ASM' }).city).toMatch(/\+\d+ more$/);
  });
});
