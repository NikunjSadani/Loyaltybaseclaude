import { HeldLoadConfig, HeldLoadStore, runHeldLoad } from './held-balances-load';
import { heldLoadConfigFromEnv } from './held-balances-load.main';
import { SAMPLE_EVENTS } from './held-fixtures.test-spec';

const ONE = (code: string, p: number) => ({ outletCode: code, closingPoints: p, events: [{ d: '2025-04-01', t: 'EARN', p, l: 'Points earned' }] });

function store(over: Partial<HeldLoadStore> = {}) {
  const inserted: unknown[] = [];
  const s: HeldLoadStore & { inserted: unknown[]; supersedeIds?: string[] } = {
    inserted,
    currentDatabase: async () => 'gifsy_staging',
    clientExists: async (c) => c === 'bajaj',
    outletFacts: async (_c, codes) =>
      new Map(
        codes.map((c) => [
          c,
          c === 'ACTIVE1'
            ? { onPortal: true, hasWallet: true, activity: true, imported: false }
            : c === 'IMPORTED1'
              ? { onPortal: true, hasWallet: true, activity: true, imported: true }
              : { onPortal: false, hasWallet: false, activity: false, imported: false },
        ]),
      ),
    existingHeld: async () => [
      { id: 'h1', outletCode: 'LOADED1', source: 'vendor-earnburn-2026-11-11', status: 'PENDING', closingPoints: 5 },
      { id: 'h2', outletCode: 'OTHER1', source: 'vendor-earlier', status: 'FAILED', closingPoints: 3 },
      { id: 'h3', outletCode: 'DONE1', source: 'vendor-earlier', status: 'APPLIED', closingPoints: 3 },
    ],
    insert: async (_c, _s, rows, a) => {
      inserted.push(...rows);
      s.supersedeIds = a.supersedeIds;
      return rows.length;
    },
    ...over,
  };
  return s;
}

const base: HeldLoadConfig = { expectedDb: 'gifsy_staging', clientId: 'bajaj', source: 'vendor-earnburn-2026-11-11', apply: false };
const APPLY = { ...base, apply: true, confirm: 'APPLY gifsy_staging', asOf: '2026-11-11' };
const manifest = [{ outletCode: 'new1', closingPoints: 600, events: SAMPLE_EVENTS }, ONE('ACTIVE1', 10), ONE('LOADED1', 5)];

describe('held opening balances loader (pure runner)', () => {
  it('DRY RUN plans every row loudly, normalises codes, writes nothing', async () => {
    const s = store();
    const log: string[] = [];
    const r = await runHeldLoad(s, base, manifest, (l) => log.push(l));
    expect(r.exitCode).toBe(0);
    expect(r.counts).toEqual(expect.objectContaining({ INSERT: 1, INSERT_APPLY_NOW: 1, ALREADY_LOADED: 1, REFUSED_EXISTING: 0 }));
    expect(r.lines.find((l) => l.action === 'INSERT')!.outletCode).toBe('NEW1');
    expect(s.inserted).toEqual([]);
    expect(log.join('\n')).toMatch(/DRY_RUN — no writes/);
  });

  it('a second live row for an outlet is REFUSED (any source) — and the WHOLE apply is refused', async () => {
    const s = store();
    const r = await runHeldLoad(s, { ...APPLY, expectedRows: 4, expectedTotal: 616 }, [...manifest, ONE('OTHER1', 1)], () => undefined);
    expect(r.exitCode).toBe(3);
    expect(r.counts.REFUSED_EXISTING).toBe(1);
    expect(s.inserted).toEqual([]);
  });

  it('SUPERSEDE=true cancels a live PENDING/FAILED row in the same insert; an APPLIED row is never superseded; imported wallets refused', async () => {
    const s = store();
    const ok = await runHeldLoad(s, { ...APPLY, supersede: true, expectedRows: 1, expectedTotal: 1 }, [ONE('OTHER1', 1)], () => undefined);
    expect([ok.exitCode, ok.counts.SUPERSEDE, ok.inserted]).toEqual([0, 1, 1]);
    expect(s.supersedeIds).toEqual(['h2']);
    const done = await runHeldLoad(store(), { ...APPLY, supersede: true, expectedRows: 1, expectedTotal: 1 }, [ONE('DONE1', 1)], () => undefined);
    expect([done.exitCode, done.counts.REFUSED_EXISTING]).toEqual([3, 1]);
    const imp = await runHeldLoad(store(), { ...APPLY, expectedRows: 1, expectedTotal: 7 }, [ONE('IMPORTED1', 7)], () => undefined);
    expect([imp.exitCode, imp.counts.REFUSED_IMPORTED]).toEqual([3, 1]);
  });

  it('APPLY guards: confirm string, EXPECTED_DB, EXPECTED_ROWS + EXPECTED_TOTAL + AS_OF required (exit 2), nothing written', async () => {
    for (const cfg of [
      { ...APPLY, expectedRows: 3, expectedTotal: 615, confirm: undefined },
      { ...APPLY, expectedRows: 3, expectedTotal: 615, confirm: 'APPLY gifsy_prod' },
      { ...APPLY, expectedRows: 3, expectedTotal: 615, expectedDb: 'gifsy_prod' },
      { ...APPLY, expectedTotal: 615 },
      { ...APPLY, expectedRows: 3 },
      { ...APPLY, expectedRows: 3, expectedTotal: 615, asOf: undefined },
      { ...APPLY, expectedRows: 3, expectedTotal: 615, asOf: '11-11-2026' },
      { ...base, clientId: 'nope' },
      { ...base, source: undefined },
    ]) {
      const s = store();
      expect((await runHeldLoad(s, cfg, manifest, () => undefined)).exitCode).toBe(2);
      expect(s.inserted).toEqual([]);
    }
  });

  it('EXPECTED_TOTAL is checked against the closings AND, independently, Σ event deltas; invalid passbook → exit 3', async () => {
    expect((await runHeldLoad(store(), { ...APPLY, expectedRows: 3, expectedTotal: 614 }, manifest, () => undefined)).exitCode).toBe(3);
    const lying = [{ outletCode: 'A', closingPoints: 5, events: [{ d: '2025-04-01', t: 'EARN', p: 4, l: 'x' }] }];
    expect((await runHeldLoad(store(), { ...APPLY, expectedRows: 1, expectedTotal: 5 }, lying, () => undefined)).exitCode).toBe(3);
    expect((await runHeldLoad(store(), base, [ONE('A', 1), ONE(' a ', 1)], () => undefined)).exitCode).toBe(3); // duplicate after normalising
    const ok = await runHeldLoad(store(), { ...APPLY, expectedRows: 3, expectedTotal: 615 }, manifest, () => undefined);
    expect([ok.exitCode, ok.inserted]).toEqual([0, 2]);
  });

  it('env: APPLY only on the exact string "true"; SUPERSEDE / AS_OF parsed', () => {
    expect(heldLoadConfigFromEnv({ HELD_APPLY: 'TRUE' }).apply).toBe(false);
    expect(heldLoadConfigFromEnv({ HELD_APPLY: 'true', EXPECTED_ROWS: '40', EXPECTED_TOTAL: '122843', AS_OF: '2026-11-11', SUPERSEDE: 'true' })).toEqual(
      expect.objectContaining({ apply: true, expectedRows: 40, expectedTotal: 122843, asOf: '2026-11-11', supersede: true }),
    );
  });
});
