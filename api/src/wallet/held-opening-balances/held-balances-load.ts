/**
 * HELD OPENING BALANCES — LOADER (pure runner + Prisma store). Inserts PENDING held rows from a manifest; never
 * touches a wallet. Entrypoint: held-balances-load.main.ts (Cloud Run JOB, same image as the API).
 *
 * Manifest: JSON array of { outletCode, closingPoints, events:[{d,t,p,l}] } (see held-balance-events.ts).
 * DRY RUN by default (reads only, prints the plan). APPLY only with HELD_APPLY=true AND
 * HELD_CONFIRM="APPLY <database>" AND EXPECTED_DB matching current_database() (same guard style as the WP6
 * backfill runner). Any invalid manifest row → the whole APPLY is refused (exit 3) — never a partial load.
 *
 * Per row the plan says (loudly — owner rule: no silent pass-through):
 *   INSERT          new PENDING row (outlet not on the portal yet / no wallet yet / empty wallet);
 *   INSERT_APPLY_NOW new PENDING row whose outlet ALREADY has a wallet with activity → needs a Gifsy "Apply now";
 *   ALREADY_LOADED  a row for (tenant, outlet, source) exists → skipped (idempotent re-run);
 *   REFUSED_IMPORTED the outlet's wallet already carries a vendor passbook (VENDOR_IMPORT ':tl:' lots) → loading it
 *                   again would double the balance → refused, listed;
 *   INVALID         the passbook does not tie out (reason) → APPLY refused.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { HeldEvent, planHeldPassbook, totalsOf } from './held-balance-events';
import { heldOutletFacts, walletHasActivity } from './held-balance-facts';

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
}

export type HeldLoadAction = 'INSERT' | 'INSERT_APPLY_NOW' | 'ALREADY_LOADED' | 'REFUSED_IMPORTED' | 'INVALID';

export interface HeldLoadStore {
  currentDatabase(): Promise<string>;
  clientExists(clientId: string): Promise<boolean>;
  /** per outlet code: on the portal? wallet? activity? already carries a vendor passbook? */
  outletFacts(clientId: string, codes: string[]): Promise<Map<string, { onPortal: boolean; hasWallet: boolean; activity: boolean; imported: boolean }>>;
  /** existing held rows of the tenant for these codes (any source) */
  existingHeld(clientId: string, codes: string[]): Promise<Array<{ outletCode: string; source: string; status: string }>>;
  /** insert (skip duplicates) in ONE transaction + one audit row; returns inserted count */
  insert(clientId: string, source: string, rows: HeldManifestRow[], createdBy: string | null): Promise<number>;
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
    rows.push({ outletCode: r.outletCode.trim(), closingPoints: r.closingPoints, events: r.events as HeldEvent[] });
  }
  return { ok: true, rows };
}

export async function runHeldLoad(store: HeldLoadStore, cfg: HeldLoadConfig, manifest: unknown, log: (l: string) => void): Promise<HeldLoadReport> {
  const actions: HeldLoadAction[] = ['INSERT', 'INSERT_APPLY_NOW', 'ALREADY_LOADED', 'REFUSED_IMPORTED', 'INVALID'];
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
  if (!(await store.clientExists(cfg.clientId))) return refuse(`no client program "${cfg.clientId}"`);

  const parsed = parseManifest(manifest);
  if (!parsed.ok) return refuse(parsed.reason, 3);
  const rows = parsed.rows;
  const total = rows.reduce((s, r) => s + r.closingPoints, 0);
  log(`manifest rows: ${inr(rows.length)}  Σ closing: ${inr(total)} pts`);
  if (cfg.expectedRows !== undefined && cfg.expectedRows !== rows.length) return refuse(`EXPECTED_ROWS=${cfg.expectedRows} but the manifest has ${rows.length}`, 3);
  if (cfg.expectedTotal !== undefined && cfg.expectedTotal !== total) return refuse(`EXPECTED_TOTAL=${cfg.expectedTotal} but Σ closing is ${total}`, 3);
  const seen = new Set<string>();
  const dups = rows.filter((r) => (seen.has(r.outletCode) ? true : (seen.add(r.outletCode), false))).map((r) => r.outletCode);
  if (dups.length) return refuse(`duplicate outlet codes in the manifest: ${dups.slice(0, 10).join(', ')}`, 3);

  const codes = rows.map((r) => r.outletCode);
  const [facts, existing] = await Promise.all([store.outletFacts(cfg.clientId, codes), store.existingHeld(cfg.clientId, codes)]);
  const toInsert: HeldManifestRow[] = [];
  for (const r of rows) {
    const add = (action: HeldLoadAction, note?: string) => {
      report.counts[action] += 1;
      report.points[action] += r.closingPoints;
      report.lines.push({ outletCode: r.outletCode, closingPoints: r.closingPoints, action, ...(note ? { note } : {}) });
    };
    const plan = planHeldPassbook(r.outletCode, r.closingPoints, r.events);
    if (!plan.ok) { add('INVALID', plan.reason); continue; }
    const mine = existing.filter((e) => e.outletCode === r.outletCode);
    if (mine.some((e) => e.source === cfg.source)) { add('ALREADY_LOADED'); continue; }
    const f = facts.get(r.outletCode);
    if (f?.imported) { add('REFUSED_IMPORTED', 'wallet already carries a vendor passbook — loading again would double the balance'); continue; }
    const other = mine.filter((e) => e.status === 'PENDING' || e.status === 'APPLIED');
    const note = [
      !f?.onPortal ? 'outlet not on the portal yet' : !f.hasWallet ? 'no wallet yet (applied at KYC approval)' : null,
      other.length ? `ALSO has held row(s) from ${other.map((o) => `${o.source} (${o.status})`).join(', ')}` : null,
    ].filter(Boolean).join('; ');
    if (f?.hasWallet && f.activity) add('INSERT_APPLY_NOW', `wallet already has activity — needs a Gifsy "Apply now"${note ? `; ${note}` : ''}`);
    else add('INSERT', note || undefined);
    toInsert.push(r);
  }

  log('\n=== PLAN ===');
  for (const a of actions) log(`  ${a.padEnd(17)} ${inr(report.counts[a]).padStart(6)} rows  ${inr(report.points[a]).padStart(12)} pts`);
  for (const l of report.lines.filter((x) => x.action !== 'INSERT')) log(`  · ${l.outletCode}  ${inr(l.closingPoints)} pts  ${l.action}${l.note ? ` — ${l.note}` : ''}`);
  if (report.counts.INVALID > 0) {
    log(`\n${report.counts.INVALID} invalid row(s) — fix the manifest; ${cfg.apply ? 'APPLY refused, nothing written' : 'an APPLY would be refused'}.`);
    report.exitCode = 3;
    return report;
  }
  if (!cfg.apply) {
    log('\nDRY_RUN — no writes. Re-run with HELD_APPLY=true HELD_CONFIRM="APPLY <db>" to insert the PENDING rows.');
    return report;
  }
  report.inserted = await store.insert(cfg.clientId, cfg.source, toInsert, cfg.createdBy ?? null);
  log(`\n=== APPLIED === inserted ${inr(report.inserted)} PENDING row(s) (${inr(toInsert.length - report.inserted)} already present).`);
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
    const out = new Map<string, { onPortal: boolean; hasWallet: boolean; activity: boolean; imported: boolean }>();
    for (let i = 0; i < codes.length; i += 1000) {
      const chunk = codes.slice(i, i + 1000);
      const facts = await heldOutletFacts(this.prisma, clientId, chunk);
      const walletIds = [...facts.values()].map((f) => f.wallet?.id).filter((x): x is string => !!x);
      const imported = walletIds.length
        ? new Set(
            (
              await this.prisma.pointsLedger.findMany({
                where: { walletId: { in: walletIds }, sourceType: 'VENDOR_IMPORT', sourceId: { contains: ':tl:' } },
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
          hasWallet: !!f?.wallet,
          activity: f?.wallet ? walletHasActivity(f.wallet) : false,
          imported: !!f?.wallet && imported.has(f.wallet.id),
        });
      }
    }
    return out;
  }

  async existingHeld(clientId: string, codes: string[]) {
    const rows: Array<{ outletCode: string; source: string; status: string }> = [];
    for (let i = 0; i < codes.length; i += 1000) {
      const r = await this.prisma.heldOpeningBalance.findMany({
        where: { clientId, outletCode: { in: codes.slice(i, i + 1000) } },
        select: { outletCode: true, source: true, status: true },
      });
      rows.push(...r.map((x) => ({ ...x, status: String(x.status) })));
    }
    return rows;
  }

  async insert(clientId: string, source: string, rows: HeldManifestRow[], createdBy: string | null): Promise<number> {
    if (rows.length === 0) return 0;
    return this.prisma.$transaction(
      async (tx) => {
        const r = await tx.heldOpeningBalance.createMany({
          data: rows.map((x) => ({
            clientId,
            outletCode: x.outletCode,
            source,
            closingPoints: x.closingPoints,
            events: x.events as unknown as Prisma.InputJsonValue,
            eventTotals: totalsOf(x.events) as unknown as Prisma.InputJsonValue,
            status: 'PENDING' as const,
            createdBy,
          })),
          skipDuplicates: true,
        });
        await tx.auditLog.create({
          data: {
            action: 'IMPORT',
            entityType: 'HELD_OPENING_BALANCE',
            entityId: clientId,
            actorId: null,
            metadata: {
              source,
              inserted: r.count,
              rows: rows.length,
              totalClosing: rows.reduce((s, x) => s + x.closingPoints, 0),
              by: createdBy,
            } as Prisma.InputJsonValue,
          },
        });
        return r.count;
      },
      { timeout: 120_000, maxWait: 30_000 },
    );
  }
}
