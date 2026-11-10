/**
 * Cross-module pin (Phase 2): the hash the WORKER stamps on `SalesImport.rosterHash` (ingest/roster.ts `loadRoster`)
 * must equal the hash the PREVIEW/APPLY recomputes for the ROSTER_CHANGED check (kpi/sales-import-data.ts
 * `loadRosterMeta` + `rosterHashOfMap`) for the same roster — same function, same outlet set, same code field.
 * A divergence would flag every month ROSTER_CHANGED and block apply for every tenant.
 */
import { loadRoster, rosterHashOf } from './ingest/roster';
import { loadRosterMeta, rosterHashOfMap } from './kpi/sales-import-data';

interface FakeOutlet {
  clientId: string;
  outletCode: string;
  name: string;
  programName: string | null;
  deletedAt: Date | null;
  outletType: { code: string } | null;
}

/** A tiny in-memory `outlet.findMany` that honours `where.clientId` / `where.deletedAt: null` and `select`. */
function fakeDb(rows: FakeOutlet[]) {
  const findMany = jest.fn(async (args: { where: Record<string, unknown>; select: Record<string, unknown> }) => {
    const { where, select } = args;
    // Fail loudly if a call site ever filters on something the fake does not understand (a silent divergence).
    for (const k of Object.keys(where)) if (k !== 'clientId' && k !== 'deletedAt') throw new Error(`unexpected where.${k}`);
    return rows
      .filter((r) => r.clientId === where.clientId && (where.deletedAt === null ? r.deletedAt === null : true))
      .map((r) => {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(select)) out[k] = (r as unknown as Record<string, unknown>)[k];
        return out;
      });
  });
  return { outlet: { findMany } };
}

const o = (clientId: string, outletCode: string, extra: Partial<FakeOutlet> = {}): FakeOutlet => ({
  clientId,
  outletCode,
  name: `n-${outletCode}`,
  programName: 'P1',
  deletedAt: null,
  outletType: { code: 'T1' },
  ...extra,
});

describe('roster hash parity: worker (loadRoster) === preview/apply (loadRosterMeta)', () => {
  const ROWS: FakeOutlet[] = [
    o('t1', '327852'),
    o('t1', ' 0012 '), // stored with stray spaces: hashed RAW on both sides
    o('t1', 'A1', { outletType: null, programName: null }),
    o('t1', '10'),
    o('t1', '9'), // string order, not numeric: '10' < '327852' < '9'
    o('t1', 'GONE', { deletedAt: new Date() }), // soft-deleted: out of the roster on both sides
    o('t2', 'OTHER-TENANT'), // tenant isolation
  ];

  it('produces the identical hash for the same roster', async () => {
    const db = fakeDb(ROWS);
    const worker = await loadRoster(db as never, 't1');
    const preview = rosterHashOfMap(await loadRosterMeta(db as never, 't1'));
    expect(preview).toBe(worker.rosterHash);
    expect(worker.rosterHash).toBe(rosterHashOf(['327852', ' 0012 ', 'A1', '10', '9']));
  });

  it('both call sites query the same outlet set (same where clause)', async () => {
    const db = fakeDb(ROWS);
    await loadRoster(db as never, 't1');
    await loadRosterMeta(db as never, 't1');
    const [w1, w2] = db.outlet.findMany.mock.calls.map((c) => c[0].where);
    expect(w1).toEqual({ clientId: 't1', deletedAt: null });
    expect(w2).toEqual(w1);
  });

  it('a roster change after processing is detected by the preview (hash mismatch)', async () => {
    const stamped = (await loadRoster(fakeDb(ROWS) as never, 't1')).rosterHash;
    const added = rosterHashOfMap(await loadRosterMeta(fakeDb([...ROWS, o('t1', 'NEW')]) as never, 't1'));
    const removed = rosterHashOfMap(
      await loadRosterMeta(fakeDb(ROWS.map((r) => (r.outletCode === 'A1' ? { ...r, deletedAt: new Date() } : r))) as never, 't1'),
    );
    expect(added).not.toBe(stamped);
    expect(removed).not.toBe(stamped);
  });

  it('another tenant’s outlets never affect the hash', async () => {
    const a = (await loadRoster(fakeDb(ROWS) as never, 't1')).rosterHash;
    const b = rosterHashOfMap(await loadRosterMeta(fakeDb([...ROWS, o('t2', 'X9')]) as never, 't1'));
    expect(b).toBe(a);
  });
});
