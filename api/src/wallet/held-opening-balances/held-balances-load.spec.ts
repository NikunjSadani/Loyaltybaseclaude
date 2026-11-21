import { HeldLoadConfig, HeldLoadStore, runHeldLoad } from './held-balances-load';
import { heldLoadConfigFromEnv } from './held-balances-load.main';
import { SAMPLE_EVENTS } from './held-harness.test-spec';

const ONE = (code: string, p: number) => ({ outletCode: code, closingPoints: p, events: [{ d: '2025-04-01', t: 'EARN', p, l: 'Points earned' }] });

function store(over: Partial<HeldLoadStore> = {}) {
  const inserted: unknown[] = [];
  const s: HeldLoadStore & { inserted: unknown[] } = {
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
    existingHeld: async () => [{ outletCode: 'LOADED1', source: 'vendor-earnburn-2026-11-11', status: 'PENDING' }],
    insert: async (_c, _s, rows) => {
      inserted.push(...rows);
      return rows.length;
    },
    ...over,
  };
  return s;
}

const base: HeldLoadConfig = { expectedDb: 'gifsy_staging', clientId: 'bajaj', source: 'vendor-earnburn-2026-11-11', apply: false };
const manifest = [{ outletCode: 'NEW1', closingPoints: 600, events: SAMPLE_EVENTS }, ONE('ACTIVE1', 10), ONE('LOADED1', 5), ONE('IMPORTED1', 7)];

describe('held opening balances loader', () => {
  it('DRY RUN (default) plans every row loudly and writes nothing', async () => {
    const s = store();
    const log: string[] = [];
    const r = await runHeldLoad(s, base, manifest, (l) => log.push(l));
    expect(r.exitCode).toBe(0);
    expect(r.mode).toBe('DRY_RUN');
    expect(r.counts).toEqual({ INSERT: 1, INSERT_APPLY_NOW: 1, ALREADY_LOADED: 1, REFUSED_IMPORTED: 1, INVALID: 0 });
    expect(r.points.INSERT).toBe(600);
    expect(s.inserted).toEqual([]);
    expect(log.join('\n')).toMatch(/IMPORTED1 {2}7 pts {2}REFUSED_IMPORTED — wallet already carries a vendor passbook/);
    expect(log.join('\n')).toMatch(/DRY_RUN — no writes/);
  });

  it('APPLY needs HELD_CONFIRM="APPLY <db>" and the right EXPECTED_DB — otherwise refused (exit 2), nothing written', async () => {
    for (const cfg of [
      { ...base, apply: true },
      { ...base, apply: true, confirm: 'APPLY gifsy_prod' },
      { ...base, apply: true, confirm: 'APPLY gifsy_staging', expectedDb: 'gifsy_prod' },
      { ...base, expectedDb: undefined },
      { ...base, clientId: 'nope' },
      { ...base, source: undefined },
    ]) {
      const s = store();
      const r = await runHeldLoad(s, cfg, manifest, () => undefined);
      expect(r.exitCode).toBe(2);
      expect(s.inserted).toEqual([]);
    }
  });

  it('APPLY inserts the INSERT + INSERT_APPLY_NOW rows only (idempotent: already-loaded skipped, imported refused)', async () => {
    const s = store();
    const r = await runHeldLoad(s, { ...base, apply: true, confirm: 'APPLY gifsy_staging' }, manifest, () => undefined);
    expect(r.exitCode).toBe(0);
    expect(r.inserted).toBe(2);
    expect((s.inserted as Array<{ outletCode: string }>).map((x) => x.outletCode)).toEqual(['NEW1', 'ACTIVE1']);
  });

  it('any invalid passbook refuses the WHOLE apply (exit 3) — never a partial load', async () => {
    const s = store();
    const bad = [...manifest, { outletCode: 'BAD1', closingPoints: 99, events: SAMPLE_EVENTS }];
    const r = await runHeldLoad(s, { ...base, apply: true, confirm: 'APPLY gifsy_staging' }, bad, () => undefined);
    expect(r.exitCode).toBe(3);
    expect(r.counts.INVALID).toBe(1);
    expect(s.inserted).toEqual([]);
  });

  it('EXPECTED_ROWS / EXPECTED_TOTAL / duplicate codes are hard stops', async () => {
    expect((await runHeldLoad(store(), { ...base, expectedRows: 40 }, manifest, () => undefined)).exitCode).toBe(3);
    expect((await runHeldLoad(store(), { ...base, expectedTotal: 1 }, manifest, () => undefined)).exitCode).toBe(3);
    expect((await runHeldLoad(store(), { ...base, expectedRows: 4, expectedTotal: 622 }, manifest, () => undefined)).exitCode).toBe(0);
    expect((await runHeldLoad(store(), base, [ONE('A', 1), ONE('A', 1)], () => undefined)).exitCode).toBe(3);
  });

  it('env: APPLY only on the exact string "true"', () => {
    expect(heldLoadConfigFromEnv({ HELD_APPLY: 'TRUE' }).apply).toBe(false);
    expect(heldLoadConfigFromEnv({ HELD_APPLY: '1' }).apply).toBe(false);
    expect(heldLoadConfigFromEnv({ HELD_APPLY: 'true', EXPECTED_ROWS: '40', EXPECTED_TOTAL: '122844' })).toEqual(
      expect.objectContaining({ apply: true, expectedRows: 40, expectedTotal: 122844 }),
    );
  });
});
