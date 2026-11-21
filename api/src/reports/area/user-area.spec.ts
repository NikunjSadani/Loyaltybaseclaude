import {
  AREA_NOT_IN_HIERARCHY,
  AREA_NOT_SET,
  areaCell,
  areaValues,
  buildUserAreaResolver,
  cachedUserAreaResolver,
  clearUserAreaCache,
  loadUserAreaResolver,
  summariseAboveAsm,
  USER_AREA_CACHE_TTL_MS,
  type AreaPrisma,
  type UserArea,
  type UserAreaResolver,
} from './user-area';

const LEVELS = [
  { code: 'XSR', name: 'XSR', level: 1 },
  { code: 'SO', name: 'SO', level: 2 },
  { code: 'ASM', name: 'Area Manager', level: 3 },
  { code: 'RSM', name: 'Regional Manager', level: 4 },
  { code: 'ZNM', name: 'ZNM', level: 5 },
  { code: 'NSM', name: 'NSM', level: 6 },
];
const ABOVE = 'Above Area Manager level';

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

function outlet(
  id: string,
  o: Partial<{ partnerId: string | null; parentId: string | null; owner: string | null; head: string | null; isPrimary: boolean; createdAt: string; zone: string | null; state: string; city: string }>,
) {
  return {
    id,
    partnerId: o.partnerId ?? null,
    parentId: o.parentId ?? null,
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
    su('sm', 'RSM', 'zh', { name: 'Suresh SM' }),
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
    // a DEACTIVATED ASM (resigned) — still their own name on their own row
    su('asmOff', 'ASM', 'sm', { isActive: false, status: 'INACTIVE', name: 'Old Asm', employeeCode: 'ASM-09' }),
    // reps who no longer cover anything
    su('isrOff', 'XSR', 'so1', { isActive: false }), // deactivated
    su('isrVac', 'XSR', 'so1', { status: 'INACTIVE' }), // vacated placeholder
  ];
  const outlets = [
    outlet('o1', { partnerId: 'P1', owner: 'u-ret1', isPrimary: true, zone: 'West', state: 'Maharashtra', city: 'Pune' }),
    outlet('o1b', { partnerId: 'P1', owner: 'u-ret1', zone: 'West', state: 'Gujarat', city: 'Surat', createdAt: '2025-01-01T00:00:00Z' }),
    outlet('o2', { partnerId: 'P2', owner: 'u-ret2', zone: ' ', state: 'Goa', city: '' }),
    // a parent group G (login u-head, no outlet of its own) with two child outlets owned by u-kid1 / u-kid2
    outlet('g1', { partnerId: 'K1', parentId: 'G', owner: 'u-kid1', head: 'u-head', zone: 'South', state: 'Kerala', city: 'Kochi' }),
    outlet('g2', { partnerId: 'K2', parentId: 'G', owner: 'u-kid2', head: 'u-head', zone: 'South', state: 'Kerala', city: 'Kollam' }),
    outlet('o4', { partnerId: 'P4', owner: 'u-ret4', zone: 'East', state: 'Bihar', city: 'Patna' }),
    outlet('o5', { partnerId: 'P5', owner: 'u-ret5', zone: 'North', state: 'Punjab', city: 'Amritsar' }),
    outlet('o6', { partnerId: 'P6', owner: 'u-ret6', zone: 'North', state: 'Haryana', city: 'Karnal' }),
  ];
  const assignments = [
    { salesUserId: 'isr1', outletId: 'o1', partnerId: null },
    { salesUserId: 'so2', outletId: null, partnerId: 'P2' }, // owner-level assignment → all P2 outlets
    { salesUserId: 'soZ', outletId: 'o4', partnerId: null },
    { salesUserId: 'so1', outletId: null, partnerId: 'G' }, // PARENT-group assignment → child outlets g1, g2
    { salesUserId: 'sm', outletId: 'o5', partnerId: null }, // a manager ABOVE ASM covers o5 directly
    { salesUserId: 'isrOff', outletId: 'o6', partnerId: null }, // inactive rep → ignored
    { salesUserId: 'isrVac', outletId: 'o6', partnerId: null }, // vacant rep → ignored
  ];
  return { salesUsers, outlets, assignments };
}

const resolver = (clientId = 'deoleo', levels = LEVELS): UserAreaResolver => {
  const f = fixtures();
  return buildUserAreaResolver(clientId, levels, f.salesUsers, f.assignments, f.outlets);
};
const fill = (v: string): UserArea => ({ asm: [v], zone: [v], state: [v], city: [v] });

describe('user area resolver (ASM · Zone · State · City)', () => {
  const r = resolver();
  const sales = (id: string, role = 'SALES_SO') => r.resolve({ id: `u-${id}`, role });

  it('SO / ISR → the ASM above them; geo from their (and their downline’s) assigned outlets', () => {
    expect(sales('isr1', 'SALES_ISR')).toEqual({ asm: ['Priya Mehta'], zone: ['West'], state: ['Maharashtra'], city: ['Pune'] });
    expect(sales('so1')).toEqual({
      asm: ['Priya Mehta'], zone: ['South', 'West'], state: ['Kerala', 'Maharashtra'], city: ['Kochi', 'Kollam', 'Pune'],
    });
  });

  it('an ASM → their own name; geo covers their whole downline', () => {
    expect(sales('asm1', 'SALES_ASM')).toEqual({
      asm: ['Priya Mehta'],
      zone: ['East', 'South', 'West'],
      state: ['Bihar', 'Kerala', 'Maharashtra'],
      city: ['Kochi', 'Kollam', 'Patna', 'Pune'],
    });
  });

  it('a DEACTIVATED ASM’s own row shows their own name, not "Vacant"', () => {
    expect(sales('asmOff', 'SALES_ASM').asm).toEqual(['Old Asm']);
  });

  it('above ASM (SM / ZH / NSM) → "Above <level> level" (never blank); geo still from the downline', () => {
    expect(sales('sm', 'SALES_STATE_HEAD').asm).toEqual([ABOVE]);
    expect(sales('sm', 'SALES_STATE_HEAD').state).toEqual(['Bihar', 'Goa', 'Kerala', 'Maharashtra', 'Punjab']);
    expect(sales('nsm', 'SALES_HO').asm).toEqual([ABOVE]);
    expect(sales('zh', 'SALES_STATE_HEAD').asm).toEqual([ABOVE]);
  });

  it('above ASM (owner 2026-11-21): City → "<N> cities" (full list kept in cityAll); State in full while ≤ 5', () => {
    const smRow = sales('sm', 'SALES_STATE_HEAD');
    expect(smRow.city).toEqual(['5 cities']);
    expect(smRow.cityAll).toEqual(['Amritsar', 'Kochi', 'Kollam', 'Patna', 'Pune']);
    expect(smRow.state).toEqual(['Bihar', 'Goa', 'Kerala', 'Maharashtra', 'Punjab']);
    expect(smRow).not.toHaveProperty('stateAll');
    expect(smRow.zone).toEqual(['East', 'North', 'South', 'West']); // zone unchanged
    expect(areaCell(smRow.city)).toBe('5 cities'); // what both Excel files write
    // the ASM and everyone below / partners are unchanged — full lists, no *All keys
    const asmRow = sales('asm1', 'SALES_ASM');
    expect(asmRow.city).toEqual(['Kochi', 'Kollam', 'Patna', 'Pune']);
    expect(asmRow).not.toHaveProperty('cityAll');
    expect(r.resolve({ id: 'u-ret1', role: 'SSS' })).not.toHaveProperty('cityAll');
  });

  it('above ASM: > 5 states → "<N> states"; one city / "Not set" shown as-is', () => {
    const states = ['A', 'B', 'C', 'D', 'E', 'F'];
    expect(summariseAboveAsm({ asm: [ABOVE], zone: ['N'], state: states, city: ['Pune'] })).toEqual({
      asm: [ABOVE], zone: ['N'], state: ['6 states'], stateAll: states, city: ['Pune'],
    });
    expect(summariseAboveAsm(fill(AREA_NOT_SET))).toEqual(fill(AREA_NOT_SET));
    // end to end: an NSM whose downline spans 6 states
    const f = fixtures();
    f.outlets.push(outlet('o7', { partnerId: 'P7', owner: 'u-ret7', zone: 'East', state: 'Odisha', city: 'Puri' }));
    f.assignments.push({ salesUserId: 'sm', outletId: 'o7', partnerId: null });
    const big = buildUserAreaResolver('deoleo', LEVELS, f.salesUsers, f.assignments, f.outlets);
    const nsm = big.resolve({ id: 'u-nsm', role: 'SALES_HO' });
    expect(nsm.state).toEqual(['6 states']);
    expect(nsm.stateAll).toEqual(['Bihar', 'Goa', 'Kerala', 'Maharashtra', 'Odisha', 'Punjab']);
    expect(nsm.city).toEqual(['6 cities']);
    // unknown-level tenant: canonical order still marks the SM as above ASM
    expect(resolver('newtenant', []).resolve({ id: 'u-sm', role: 'SALES_STATE_HEAD' }).city).toEqual(['5 cities']);
  });

  it('vacant ASM position above someone → "Vacant (code)" — the vacant territory, NOT the next active manager', () => {
    expect(sales('so2')).toEqual({ asm: ['Vacant (ASM-07)'], zone: [AREA_NOT_SET], state: ['Goa'], city: [AREA_NOT_SET] });
  });

  it('no ASM in the chain / dangling link / cycle → "Not set", never a crash or a hang', () => {
    expect(sales('so3').asm).toEqual([AREA_NOT_SET]);
    expect(sales('so4').asm).toEqual([AREA_NOT_SET]);
    expect(sales('cyc1')).toEqual(fill(AREA_NOT_SET));
  });

  it('a zone typed on the employee record wins over outlet zones', () => {
    expect(sales('soZ')).toEqual({ asm: ['Priya Mehta'], zone: ['North-East'], state: ['Bihar'], city: ['Patna'] });
  });

  it('a sales login with no employee record → "Not set" everywhere', () => {
    expect(r.resolve({ id: 'u-nobody', role: 'SALES_SO' })).toEqual(fill(AREA_NOT_SET));
  });

  it('retailer / wholesaler → primary own outlet geo + the ASM of the rep covering it', () => {
    // u-ret1 has o1 (primary) and o1b (older, not primary) → primary wins
    expect(r.resolve({ id: 'u-ret1', role: 'SSS' })).toEqual({ asm: ['Priya Mehta'], zone: ['West'], state: ['Maharashtra'], city: ['Pune'] });
    // owner-level assignment to a rep under a vacant ASM; blank zone / city → "Not set"
    expect(r.resolve({ id: 'u-ret2', role: 'WHOLESALER' })).toEqual({ asm: ['Vacant (ASM-07)'], zone: [AREA_NOT_SET], state: ['Goa'], city: [AREA_NOT_SET] });
    expect(r.resolve({ id: 'u-none', role: 'SSS' })).toEqual(fill(AREA_NOT_SET));
  });

  it('(2) an outlet covered by a manager ABOVE ASM → "Above ASM level — Name (level)", not "Not set"', () => {
    expect(r.resolve({ id: 'u-ret5', role: 'SSS' }).asm).toEqual([`${ABOVE} — Suresh SM (Regional Manager)`]);
  });

  it('(3) inactive and vacated reps cover nothing — neither the retailer’s ASM nor any roll-up', () => {
    expect(r.resolve({ id: 'u-ret6', role: 'SSS' })).toEqual({ asm: [AREA_NOT_SET], zone: ['North'], state: ['Haryana'], city: ['Karnal'] });
    expect(sales('isrOff', 'SALES_ISR').state).toEqual([AREA_NOT_SET]);
    expect(sales('isrVac', 'SALES_ISR').state).toEqual([AREA_NOT_SET]);
    expect(sales('asm1', 'SALES_ASM').state).not.toContain('Haryana');
  });

  it('(8) a rep assigned at the PARENT group covers the child outlets (ASM + roll-up)', () => {
    expect(r.resolve({ id: 'u-kid1', role: 'SSS' })).toEqual({ asm: ['Priya Mehta'], zone: ['South'], state: ['Kerala'], city: ['Kochi'] });
    expect(r.resolve({ id: 'u-kid2', role: 'SSS' }).asm).toEqual(['Priya Mehta']);
  });

  it('(7) a group head with no outlet of their own → "Group — N outlets" in all four columns', () => {
    expect(r.resolve({ id: 'u-head', role: 'WHOLESALER' })).toEqual(fill('Group — 2 outlets'));
  });

  it.each(['CLIENT_ADMIN', 'MIS_USER', 'GIFSY_ADMIN', 'GIFSY_STAFF', 'VENDOR'])('%s → "Not in sales hierarchy"', (role) => {
    expect(r.resolve({ id: 'u-x', role })).toEqual(fill(AREA_NOT_IN_HIERARCHY));
  });

  it("ASM header = the tenant's own level name; Bajaj blank name → rung label; no levels → 'ASM'", () => {
    expect(r.asmHeader).toBe('Area Manager');
    expect(resolver('bajaj', LEVELS.map((l) => ({ ...l, name: '' }))).asmHeader).toBe('ASM');
    const none = resolver('newtenant', []);
    expect(none.asmHeader).toBe('ASM');
    // with no level rows the canonical code order still applies
    expect(none.resolve({ id: 'u-so1', role: 'SALES_SO' }).asm).toEqual(['Priya Mehta']);
    expect(none.resolve({ id: 'u-sm', role: 'SALES_STATE_HEAD' }).asm).toEqual(['Above ASM level']);
    expect(none.resolve({ id: 'u-ret5', role: 'SSS' }).asm).toEqual(['Above ASM level — Suresh SM (RSM)']);
  });

  it('notes explain every column and every placeholder word accurately', () => {
    expect(r.notes).toHaveLength(4);
    expect(r.notes[3]).toMatch(/above the Area Manager level/);
    expect(r.notes[3]).toMatch(/"<N> cities"/);
    expect(r.notes[3]).toMatch(/"<N> states" when they cover more than 5 states/);
    expect(r.notes[0]).toMatch(/Area Manager this user reports to/);
    expect(r.notes[0]).toMatch(/show "Above Area Manager level"/);
    expect(r.notes[0]).toMatch(/Vacant \(code\)/);
    expect(r.notes[0]).toMatch(/"Above Area Manager level — Name \(level\)"/);
    expect(r.notes[0]).toMatch(/Inactive or vacant reps are ignored/);
    expect(r.notes[1]).toMatch(/outlet master/);
    expect(r.notes[1]).toMatch(/"Group — N outlets"/);
    expect(r.notes[1]).toMatch(/Excel file lists every value/);
    expect(r.notes[2]).toMatch(/"Not set"/);
    expect(r.notes[2]).toMatch(/"Not in sales hierarchy"/);
  });

  it('(6) values: sorted, distinct, trimmed, never empty; Excel cell = the FULL list (no cap)', () => {
    expect(areaValues([' b', 'a', 'b', ''])).toEqual(['a', 'b']);
    expect(areaValues([])).toEqual([AREA_NOT_SET]);
    const many = Array.from({ length: 40 }, (_, i) => `City ${String(i).padStart(2, '0')}`);
    expect(areaCell(areaValues(many))).toBe(many.join(', '));
    expect(areaCell([])).toBe(AREA_NOT_SET);
  });

  it('odd rows (nulls, missing level, missing user) never throw', () => {
    const odd = buildUserAreaResolver(
      'deoleo',
      LEVELS,
      [{ ...su('x', 'SO', null), hierarchyLevel: null, user: null }, null as never],
      [{ salesUserId: 'x', outletId: 'missing', partnerId: 'missing' }, null as never],
      [null as never],
    );
    expect(odd.resolve({ id: 'u-x', role: 'SALES_SO' }).asm).toEqual([AREA_NOT_SET]);
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

  it('every read is pinned to the tenant; outlets read parentId (group inheritance)', async () => {
    const p = fakePrisma();
    await loadUserAreaResolver(p as unknown as AreaPrisma, 'bajaj');
    expect((p.salesHierarchyLevel.findMany.mock.calls[0] as unknown[])[0]).toMatchObject({ where: { clientId: 'bajaj' } });
    expect((p.salesUser.findMany.mock.calls[0] as unknown[])[0]).toMatchObject({ where: { clientId: 'bajaj' } });
    expect((p.salesUserAssignment.findMany.mock.calls[0] as unknown[])[0]).toMatchObject({
      where: { unassignedAt: null, salesUser: { clientId: 'bajaj', deletedAt: null } },
    });
    expect((p.outlet.findMany.mock.calls[0] as unknown[])[0]).toMatchObject({
      where: { clientId: 'bajaj', deletedAt: null },
      select: { parentId: true },
    });
  });

  it('2,000 rows → still exactly 4 reads (no per-row query); every row resolved', async () => {
    const p = fakePrisma(2_000);
    const res = await loadUserAreaResolver(p as unknown as AreaPrisma, 'deoleo');
    const out = Array.from({ length: 2_000 }, (_, i) => [
      res.resolve({ id: `u-bulk${i}`, role: 'SALES_ISR' }),
      res.resolve({ id: `u-bret${i}`, role: 'SSS' }),
    ]).flat();
    expect(out.every((a) => a.asm[0] === 'Priya Mehta' && a.state[0] === 'Maharashtra')).toBe(true);
    for (const m of [p.salesHierarchyLevel, p.salesUser, p.salesUserAssignment, p.outlet]) expect(m.findMany).toHaveBeenCalledTimes(1);
    // the ASM's downline now spans 11 cities → ALL listed (the cap is a page-display concern only)
    expect(res.resolve({ id: 'u-asm1', role: 'SALES_ASM' }).city).toHaveLength(11);
  });
});

describe('cachedUserAreaResolver — per-tenant ~60 s cache', () => {
  beforeEach(() => clearUserAreaCache());
  const fake = (tag: string) => ({ asmHeader: tag, resolve: () => fill(tag), notes: [] }) as UserAreaResolver;

  it('reuses the tenant’s resolver inside the TTL, reloads after it, and keys by tenant', async () => {
    const load = jest.fn(async () => fake('a'));
    const t0 = 1_000_000;
    await cachedUserAreaResolver('bajaj', load, t0);
    await cachedUserAreaResolver('bajaj', load, t0 + USER_AREA_CACHE_TTL_MS - 1);
    expect(load).toHaveBeenCalledTimes(1);
    await cachedUserAreaResolver('deoleo', load, t0 + 1);
    expect(load).toHaveBeenCalledTimes(2); // another tenant never shares the entry
    await cachedUserAreaResolver('bajaj', load, t0 + USER_AREA_CACHE_TTL_MS);
    expect(load).toHaveBeenCalledTimes(3); // expired
  });

  it('concurrent callers share one in-flight load; a failed load is not cached', async () => {
    let calls = 0;
    const failing = jest.fn(async () => {
      calls++;
      throw new Error('timeout');
    });
    const [a, b] = [cachedUserAreaResolver('bajaj', failing, 1), cachedUserAreaResolver('bajaj', failing, 2)];
    await expect(a).rejects.toThrow('timeout');
    await expect(b).rejects.toThrow('timeout');
    expect(calls).toBe(1);
    const ok = jest.fn(async () => fake('ok'));
    await expect(cachedUserAreaResolver('bajaj', ok, 3)).resolves.toMatchObject({ asmHeader: 'ok' });
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
