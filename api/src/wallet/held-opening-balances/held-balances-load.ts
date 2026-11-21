/**
 * HELD OPENING BALANCES — LOADER (pure runner + Prisma store). Inserts PENDING held rows from a manifest; never
 * touches a wallet. Entrypoint: held-balances-load.main.ts (Cloud Run JOB, same image as the API).
 *
 * Manifest: JSON array of { outletCode, closingPoints, events:[{d,t,p,l}] } (see held-balance-events.ts).
 * DRY RUN by default (reads only, prints the plan). APPLY only with HELD_APPLY=true AND
 * HELD_CONFIRM="APPLY <database>" AND EXPECTED_DB matching current_database() AND EXPECTED_ROWS + EXPECTED_TOTAL
 * (both REQUIRED for APPLY, compared with the manifest's closings AND, independently, with Σ of its event deltas)
 * AND AS_OF (YYYY-MM-DD, the vendor closing's date). Any invalid / refused row → the whole APPLY is refused
 * (exit 3) — never a partial load. Outlet codes are normalised (trim, upper-case, no internal spaces; leading
 * zeros kept) exactly as the apply side matches them.
 *
 * Per row the plan says (loudly — owner rule: no silent pass-through):
 *   INSERT          new PENDING row (outlet not on the portal yet / no wallet yet / empty wallet);
 *   INSERT_APPLY_NOW new PENDING row whose outlet ALREADY has a wallet with activity → needs a Gifsy "Apply now";
 *   SUPERSEDE       (SUPERSEDE=true only) a live PENDING / FAILED row of another source is CANCELLED (audited) in the
 *                   same transaction as the insert. An APPLIED row is never superseded;
 *   ALREADY_LOADED  the SAME row (tenant, outlet, source, closing) exists → skipped (idempotent re-run);
 *   REFUSED_EXISTING the outlet already has a live held row (PENDING / FAILED / APPLIED, any source) → refused;
 *   REFUSED_IMPORTED the outlet's wallet already carries a vendor balance (VENDOR_IMPORT lots ':tl:' / ':held-open:'
 *                   / bulk ':opening-earn' / ':opening-net') → loading it again would double the balance → refused;
 *   INVALID         the passbook does not tie out (reason).
 * The database enforces the same: ONE live held row per (tenant, outlet) (partial unique index).
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { HeldEvent, planHeldPassbook, totalsOf } from './held-balance-events';
import { heldOutletFacts, normOutletCode, walletHasActivity } from './held-balance-facts';

export interface HeldManifestRow {
  outletCode: string;
  closingPoints: number;
  events: HeldEvent[];
}

export interface HeldLoadConfig {
  expectedDb?: string;
  clientId?: string;
  source?: string;
  apply: boolean;
  confirm?: string;
  expectedRows?: number;
  expectedTotal?: number;
  createdBy?: string;
  /** YYYY-MM-DD — the vendor closing's as-of date (REQUIRED for APPLY) */
  asOf?: string;
  /** cancel a live PENDING / FAILED row of another source for the same outlet, in the same transaction */
  supersede?: boolean;
}

export type HeldLoadAction = 'INSERT' | 'INSERT_APPLY_NOW' | 'SUPERSEDE' | 'ALREADY_LOADED' | 'REFUSED_EXISTING' | 'REFUSED_IMPORTED' | 'INVALID';

export interface HeldLoadStore {
  currentDatabase(): Promise<string>;
  clientExists(clientId: string): Promise<boolean>;
  /** per outlet code: on the portal? wallet? activity? already carries a vendor passbook? */
  outletFacts(clientId: string, codes: string[]): Promise<Map<string, { onPortal: boolean; hasWallet: boolean; activity: boolean; imported: boolean; ambiguous?: boolean }>>;
  /** existing held rows of the tenant for these codes (any source, any status) */
  existingHeld(clientId: string, codes: string[]): Promise<Array<{ id: string; outletCode: string; source: string; status: string; closingPoints: number }>>;
  /** cancel the superseded rows + insert, in ONE transaction + an audit row; returns inserted count (throws if short) */
  insert(clientId: string, source: string, rows: HeldManifestRow[], a: { createdBy: string | null; asOf: string; supersedeIds: string[] }): Promise<number>;
}

export interface HeldLoadReport {
  exitCode: number;
  mode: 'DRY_RUN' | 'APPLY';
  counts: Record<HeldLoadAction, number>;
  points: Record<HeldLoadAction, number>;
  inserted: number;
  lines: Array<{ outletCode: string; closingPoints: number; action: HeldLoadAction; note?: string }>;
}

const inr = (n: number) => n.toLocaleString('en-IN');

export function parseManifest(raw: unknown): { ok: true; rows: HeldManifestRow[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw)) return { ok: false, reason: 'manifest must be a JSON array of { outletCode, closingPoints, events }' };
  const rows: HeldManifestRow[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] as Record<string, unknown>;
    if (!r || typeof r.outletCode !== 'string' || r.outletCode.trim() === '') return { ok: false, reason: `row ${i + 1}: outletCode missing` };
    if (typeof r.closingPoints !== 'number') return { ok: false, reason: `row ${i + 1} (${r.outletCode}): closingPoints missing` };
    const code = normOutletCode(r.outletCode);
    if (!code) return { ok: false, reason: `row ${i + 1}: outletCode empty after normalising` };
    rows.push({ outletCode: code, closingPoints: r.closingPoints, events: r.events as HeldEvent[] });
  }
  return { ok: true, rows };
}

export async function runHeldLoad(store: HeldLoadStore, cfg: HeldLoadConfig, manifest: unknown, log: (l: string) => void): Promise<HeldLoadReport> {
  const actions: HeldLoadAction[] = ['INSERT', 'INSERT_APPLY_NOW', 'SUPERSEDE', 'ALREADY_LOADED', 'REFUSED_EXISTING', 'REFUSED_IMPORTED', 'INVALID'];
  const report: HeldLoadReport = {
    exitCode: 0,
    mode: cfg.apply ? 'APPLY' : 'DRY_RUN',
    counts: Object.fromEntries(actions.map((a) => [a, 0])) as Record<HeldLoadAction, number>,
    points: Object.fromEntries(actions.map((a) => [a, 0])) as Record<HeldLoadAction, number>,
    inserted: 0,
    lines: [],
  };
  const refuse = (msg: string, code = 2) => {
    log(`ABORT: ${msg}`);
    report.exitCode = code;
    return report;
  };

  // ── guards ──
  if (!cfg.expectedDb) return refuse('EXPECTED_DB is required');
  const db = await store.currentDatabase();
  log(`MODE=${report.mode}  DB=${db}  tenant=${cfg.clientId ?? '?'}  source=${cfg.source ?? '?'}`);
  if (db !== cfg.expectedDb) return refuse(`connected to ${db}, EXPECTED_DB=${cfg.expectedDb}`);
  if (!cfg.clientId) return refuse('TENANT is required');
  if (!cfg.source || !/^[a-z0-9][a-z0-9._-]{2,80}$/i.test(cfg.source)) return refuse('SOURCE is required (e.g. vendor-earnburn-2026-11-11)');
  if (cfg.apply && cfg.confirm !== `APPLY ${db}`) return refuse(`HELD_CONFIRM must be exactly "APPLY ${db}"`);
  if (cfg.apply && (cfg.expectedRows === undefined || cfg.expectedTotal === undefined)) return refuse('EXPECTED_ROWS and EXPECTED_TOTAL are REQUIRED for APPLY');
  if (cfg.apply && (!cfg.asOf || !/^\d{4}-\d{2}-\d{2}$/.test(cfg.asOf) || Number.isNaN(Date.parse(`${cfg.asOf}T00:00:00Z`)))) {
    return refuse('AS_OF (YYYY-MM-DD, the vendor closing date) is REQUIRED for APPLY');
  }
  if (!(await store.clientExists(cfg.clientId))) return refuse(`no client program "${cfg.clientId}"`);

  const parsed = parseManifest(manifest);
  if (!parsed.ok) return refuse(parsed.reason, 3);
  const rows = parsed.rows;
  const total = rows.reduce((s, r) => s + r.closingPoints, 0);
  // INDEPENDENT computation: Σ of every event delta (not the declared closings)
  const eventTotal = rows.reduce(
    (s, r) => s + (Array.isArray(r.events) ? r.events.reduce((x, e) => x + (typeof e?.p === 'number' && Number.isFinite(e.p) ? e.p : 0), 0) : 0),
    0,
  );
  log(`manifest rows: ${inr(rows.length)}  Σ closing: ${inr(total)} pts  Σ event deltas: ${inr(eventTotal)} pts`);
  if (eventTotal !== total) return refuse(`Σ closing ${total} ≠ Σ event deltas ${eventTotal} — the manifest does not tie out`, 3);
  if (cfg.expectedRows !== undefined && cfg.expectedRows !== rows.length) return refuse(`EXPECTED_ROWS=${cfg.expectedRows} but the manifest has ${rows.length}`, 3);
  if (cfg.expectedTotal !== undefined && (cfg.expectedTotal !== total || cfg.expectedTotal !== eventTotal)) {
    return refuse(`EXPECTED_TOTAL=${cfg.expectedTotal} but Σ closing is ${total} and Σ event deltas ${eventTotal}`, 3);
  }
  const seen = new Set<string>();
  const dups = rows.filter((r) => (seen.has(r.outletCode) ? true : (seen.add(r.outletCode), false))).map((r) => r.outletCode);
  if (dups.length) return refuse(`duplicate outlet codes in the manifest: ${dups.slice(0, 10).join(', ')}`, 3);

  const codes = rows.map((r) => r.outletCode);
  const [facts, existing] = await Promise.all([store.outletFacts(cfg.clientId, codes), store.existingHeld(cfg.clientId, codes)]);
  const toInsert: HeldManifestRow[] = [];
  const supersedeIds: string[] = [];
  for (const r of rows) {
    const add = (action: HeldLoadAction, note?: string) => {
      report.counts[action] += 1;
      report.points[action] += r.closingPoints;
      report.lines.push({ outletCode: r.outletCode, closingPoints: r.closingPoints, action, ...(note ? { note } : {}) });
    };
    const plan = planHeldPassbook(r.outletCode, r.closingPoints, r.events);
    if (!plan.ok) { add('INVALID', plan.reason); continue; }
    const mine = existing.filter((e) => e.outletCode === r.outletCode);
    const same = mine.find((e) => e.source === cfg.source);
    if (same && same.status !== 'CANCELLED' && same.closingPoints === r.closingPoints) { add('ALREADY_LOADED'); continue; }
    const f = facts.get(r.outletCode);
    if (f?.imported) { add('REFUSED_IMPORTED', 'wallet already carries a vendor balance — loading again would double it'); continue; }
    const live = mine.filter((e) => e.status === 'PENDING' || e.status === 'FAILED' || e.status === 'APPLIED');
    const desc = (xs: typeof mine) => xs.map((e) => `${e.source} ${e.status} ${e.closingPoints} pts`).join(', ');
    if (live.some((e) => e.status === 'APPLIED')) { add('REFUSED_EXISTING', `an APPLIED held balance exists (${desc(live)}) — never superseded`); continue; }
    if (same && same.status !== 'CANCELLED') {
      add('REFUSED_EXISTING', `a row from the same source exists (${desc([same])}) — cancel it in the console and load under a new SOURCE`);
      continue;
    }
    if (same) { add('REFUSED_EXISTING', `a CANCELLED row from the same source exists (${desc([same])}) — load under a new SOURCE`); continue; }
    if (live.length) {
      if (!cfg.supersede) { add('REFUSED_EXISTING', `a live held balance exists (${desc(live)}) — re-run with SUPERSEDE=true to cancel it in the same transaction`); continue; }
      supersedeIds.push(...live.map((e) => e.id));
      add('SUPERSEDE', `cancels ${desc(live)}`);
      toInsert.push(r);
      continue;
    }
    const note = !f?.onPortal ? 'outlet not on the portal yet' : f.ambiguous ? 'MORE THAN ONE outlet matches this code' : !f.hasWallet ? 'no wallet yet (applied at KYC approval)' : null;
    if (f?.hasWallet && f.activity) add('INSERT_APPLY_NOW', 'wallet already has activity — needs a Gifsy "Apply now"');
    else add('INSERT', note || undefined);
    toInsert.push(r);
  }

  log('\n=== PLAN ===');
  for (const a of actions) log(`  ${a.padEnd(17)} ${inr(report.counts[a]).padStart(6)} rows  ${inr(report.points[a]).padStart(12)} pts`);
  for (const l of report.lines.filter((x) => x.action !== 'INSERT')) log(`  · ${l.outletCode}  ${inr(l.closingPoints)} pts  ${l.action}${l.note ? ` — ${l.note}` : ''}`);
  const blocking = report.counts.INVALID + report.counts.REFUSED_EXISTING + report.counts.REFUSED_IMPORTED;
  if (blocking > 0) {
    log(`\n${blocking} invalid / refused row(s) — fix the manifest; ${cfg.apply ? 'APPLY refused, nothing written' : 'an APPLY would be refused'}.`);
    report.exitCode = 3;
    return report;
  }
  if (!cfg.apply) {
    log('\nDRY_RUN — no writes. Re-run with HELD_APPLY=true HELD_CONFIRM="APPLY <db>" to insert the PENDING rows.');
    return report;
  }
  report.inserted = await store.insert(cfg.clientId, cfg.source, toInsert, { createdBy: cfg.createdBy ?? null, asOf: cfg.asOf!, supersedeIds });
  log(`\n=== APPLIED === inserted ${inr(report.inserted)} PENDING row(s)${supersedeIds.length ? `, cancelled ${supersedeIds.length} superseded row(s)` : ''}.`);
  return report;
}

/** Prisma store (the job). */
export class PrismaHeldLoadStore implements HeldLoadStore {
  constructor(private readonly prisma: PrismaClient) {}

  async currentDatabase(): Promise<string> {
    const r = await this.prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
    return r[0]?.db ?? '';
  }

  async clientExists(clientId: string): Promise<boolean> {
    return !!(await this.prisma.client.findFirst({ where: { id: clientId }, select: { id: true } }));
  }

  async outletFacts(clientId: string, codes: string[]) {
    const out = new Map<string, { onPortal: boolean; hasWallet: boolean; activity: boolean; imported: boolean; ambiguous: boolean }>();
    for (let i = 0; i < codes.length; i += 1000) {
      const chunk = codes.slice(i, i + 1000);
      const facts = await heldOutletFacts(this.prisma, clientId, chunk);
      const walletIds = [...facts.values()].map((f) => f.wallet?.id).filter((x): x is string => !!x);
      const imported = walletIds.length
        ? new Set(
            (
              await this.prisma.pointsLedger.findMany({
                where: {
                  walletId: { in: walletIds },
                  sourceType: 'VENDOR_IMPORT',
                  OR: [':tl:', ':held-open:', ':opening-earn', ':opening-net'].map((x) => ({ sourceId: { contains: x } })),
                },
                select: { walletId: true },
                distinct: ['walletId'],
              })
            ).map((r) => r.walletId),
          )
        : new Set<string>();
      for (const c of chunk) {
        const f = facts.get(c);
        out.set(c, {
          onPortal: !!f,
          ambiguous: !!f?.ambiguous,
          hasWallet: !!f?.wallet,
          activity: f?.wallet ? walletHasActivity(f.wallet) : false,
          imported: !!f?.wallet && imported.has(f.wallet.id),
        });
      }
    }
    return out;
  }

  async existingHeld(clientId: string, codes: string[]) {
    const rows: Array<{ id: string; outletCode: string; source: string; status: string; closingPoints: number }> = [];
    for (let i = 0; i < codes.length; i += 1000) {
      const r = await this.prisma.heldOpeningBalance.findMany({
        where: { clientId, outletCode: { in: codes.slice(i, i + 1000) } },
        select: { id: true, outletCode: true, source: true, status: true, closingPoints: true },
      });
      rows.push(...r.map((x) => ({ ...x, status: String(x.status) })));
    }
    return rows;
  }

  async insert(clientId: string, source: string, rows: HeldManifestRow[], a: { createdBy: string | null; asOf: string; supersedeIds: string[] }): Promise<number> {
    if (rows.length === 0) return 0;
    return this.prisma.$transaction(
      async (tx) => {
        if (a.supersedeIds.length) {
          const c = await tx.heldOpeningBalance.updateMany({
            where: { id: { in: a.supersedeIds }, clientId, status: { in: ['PENDING', 'FAILED'] } },
            data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: a.createdBy ?? 'held-loader', cancelReason: `superseded by source ${source}` },
          });
          if (c.count !== a.supersedeIds.length) throw new Error(`supersede: only ${c.count}/${a.supersedeIds.length} rows were still PENDING/FAILED — nothing written, re-run the dry run`);
        }
        const r = await tx.heldOpeningBalance.createMany({
          data: rows.map((x) => ({
            clientId,
            outletCode: normOutletCode(x.outletCode),
            source,
            asOfDate: new Date(`${a.asOf}T00:00:00.000Z`),
            closingPoints: x.closingPoints,
            events: x.events as unknown as Prisma.InputJsonValue,
            eventTotals: totalsOf(x.events) as unknown as Prisma.InputJsonValue,
            status: 'PENDING' as const,
            createdBy: a.createdBy,
          })),
          skipDuplicates: true,
        });
        // A short insert = a live row appeared meanwhile (DB one-live-row index) → roll back the WHOLE load.
        if (r.count !== rows.length) throw new Error(`inserted ${r.count}/${rows.length} rows — a live held row appeared meanwhile; nothing written, re-run the dry run`);
        await tx.auditLog.create({
          data: {
            action: 'IMPORT',
            entityType: 'HELD_OPENING_BALANCE',
            entityId: clientId,
            actorId: null,
            metadata: {
              source,
              asOf: a.asOf,
              inserted: r.count,
              superseded: a.supersedeIds,
              totalClosing: rows.reduce((t, x) => t + x.closingPoints, 0),
              by: a.createdBy,
            } as Prisma.InputJsonValue,
          },
        });
        return r.count;
      },
      { timeout: 120_000, maxWait: 30_000 },
    );
  }
}
