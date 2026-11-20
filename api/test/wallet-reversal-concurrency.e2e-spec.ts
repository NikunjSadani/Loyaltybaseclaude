/**
 * WP7 — Wallet Reversal Engine × REAL Postgres concurrency (WALLET-REVERSAL-ENGINE-DESIGN.md §5, §6, §8, §13 WP7,
 * §15 T-e1..3 / T-pay3). MONEY code: every scenario ends by replaying the wallet's committed seq history through the
 * WP0 oracle (reversal-model.ts) and requiring an exact match (see support/wallet-oracle-check.ts).
 *
 * HOW TO RUN (never against a shared DB — the harness refuses non-localhost hosts and never reads DATABASE_URL):
 *   # real concurrency (the proof): any throw-away local Postgres ≥ 13, e.g.
 *   #   docker run --rm -d -p 55432:5432 -e POSTGRES_PASSWORD=wre postgres:16
 *   WRE_PG_ADMIN_URL=postgresql://postgres:wre@localhost:55432/postgres \
 *     npx jest --config ./test/jest-e2e.json wallet-reversal-concurrency --maxWorkers=1
 *   # suite self-check only (PGlite from node_modules in a child process, in-memory, SERIALISED — NOT concurrency evidence;
 *   #   storm + pool tests skip):
 *   WRE_PG_EMBEDDED=pglite npx jest --config ./test/jest-e2e.json wallet-reversal-concurrency --maxWorkers=1
 * Neither variable set → the whole suite is skipped.
 *
 * Races: with a real server each race is GATED — the test holds the wallet row lock (SELECT … FOR UPDATE on its own
 * connection), starts the operations one by one and waits until pg_stat_activity shows each blocked on a lock, then
 * releases. Every operation is therefore provably in flight at the same time, and the start order fixes the order
 * Postgres grants the lock, so both interleavings of every pair are exercised (and asserted to have happened).
 * Storm tests additionally fire many operations with no gate at all. On PGlite the same ops run serially in each order.
 *
 * Every scenario runs on a V2 tenant (program_settings.reversalEngine = 'V2') and has a LEGACY-tenant control.
 * Pending (it.skip + TODO) until the parallel work packages land: WP4 (credits.service V2 approve path) and WP5
 * (payout reservations vs bank download).
 */
import { randomBytes } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { Client } from 'pg';
import { PrismaService } from '../src/prisma/prisma.service';
import { TenantSettingsService } from '../src/tenant/tenant-settings.service';
import {
  WalletService,
  DEBT_REVERSAL_PAUSED_MESSAGE,
} from '../src/wallet/wallet.service';
import { CreditsService } from '../src/credits/credits.service';
import { ReversalAction } from '../src/credits/dto/credits.dto';
import type { JwtPayload } from '../src/common/decorators/current-user.decorator';
import {
  DisposableDb,
  disposableMode,
  startDisposableDb,
} from './support/disposable-postgres';
import {
  replayWalletThroughOracle,
  SEED_DEBT_REFERENCE,
} from './support/wallet-oracle-check';

jest.setTimeout(180_000);

const MODE = disposableMode();
const d = MODE ? describe : describe.skip;
/** Needs truly parallel sessions (real server) — a storm / pool test on serialised PGlite proves nothing. */
const itServer = MODE === 'server' ? it : it.skip;

// ─── outcome helpers ────────────────────────────────────────────────────────────────────────────────────────────
type Outcome<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: Error };
const settle = <T>(fn: () => Promise<T>): Promise<Outcome<T>> =>
  fn().then(
    (value) => ({ ok: true as const, value }),
    (error: Error) => ({ ok: false as const, error }),
  );
const oks = (os: Outcome[]) => os.filter((o) => o.ok).length;
const errs = (os: Outcome[]) =>
  os.filter((o): o is { ok: false; error: Error } => !o.ok).map((o) => o.error);
const rid = () => randomBytes(4).toString('hex');

d(
  `Wallet reversal engine × real Postgres concurrency (WP7) [${MODE ?? 'skipped'}]`,
  () => {
    let db: DisposableDb;
    let prisma: PrismaClient;
    let wallet: WalletService;
    let credits: CreditsService;
    const tenantModes = new Map<string, 'V2' | 'LEGACY'>();
    let holder: Client | null = null; // holds the gate lock (server mode)
    let monitor: Client | null = null; // watches pg_stat_activity (server mode)

    beforeAll(async () => {
      db = await startDisposableDb({ poolSize: 40 }); // > any burst below: these scenarios test LOCKS, not pool size
      prisma = db.prisma();
      const ps = prisma as unknown as PrismaService;
      // The real TenantSettingsService in BOTH modes (reads program_settings — production behaviour). Since policy
      // round A, WalletService.movementPath / reverseCreditBatchPoints (and the credits POINTS-reversal pause gate)
      // read the flags through the CALLER's transaction, so PGlite (one transaction at a time) no longer deadlocks on
      // a nested read — before the fix, the PGlite run had to answer the flag from `tenantModes` (kept as the
      // fixtures' record of what they wrote). See the pool-starvation test below.
      const tenantSettings = new TenantSettingsService(ps);
      wallet = new WalletService(ps, tenantSettings);
      // patchReversal (POINTS) only touches prisma + walletService; the other collaborators are never reached.
      credits = new CreditsService(
        ps,
        {} as never,
        {} as never,
        wallet,
        tenantSettings,
        {} as never,
        {} as never,
      );
      if (db.concurrent) {
        holder = await db.rawClient();
        monitor = await db.rawClient();
      }

      console.log(
        `[WP7] ${db.mode} database ${db.databaseName}: ${db.migrationsApplied} migrations applied`,
      );
    });

    afterAll(async () => {
      if (db) await db.dispose();
    });

    // ─── race machinery ────────────────────────────────────────────────────────────────────────────────────────────
    async function lockWaiters(): Promise<number> {
      const { rows } = await monitor!.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      return rows[0].n;
    }

    /**
     * Run `ops` against one wallet so that they genuinely overlap: hold the wallet row lock, start op i, wait until
     * i+1 sessions are blocked on a lock (minus ops that already finished — e.g. a pre-lock refusal), …, release.
     * PGlite (single session): run them serially in the given order.
     */
    async function race(
      walletId: string,
      ops: Array<() => Promise<unknown>>,
    ): Promise<Outcome[]> {
      if (!db.concurrent) {
        const out: Outcome[] = [];
        for (const op of ops) out.push(await settle(op));
        return out;
      }
      await holder!.query('BEGIN');
      await holder!.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [
        walletId,
      ]);
      const running: Promise<Outcome>[] = [];
      let done = 0;
      try {
        for (let i = 0; i < ops.length; i++) {
          running.push(
            settle(ops[i]).finally(() => {
              done += 1;
            }),
          );
          const deadline = Date.now() + 20_000;
          while ((await lockWaiters()) < i + 1 - done) {
            if (Date.now() > deadline)
              throw new Error(
                `race: op ${i} never blocked on a lock (waiters < ${i + 1 - done})`,
              );
            await new Promise((r) => setTimeout(r, 15));
          }
        }
      } finally {
        await holder!.query('COMMIT');
      }
      return Promise.all(running);
    }

    /** Ungated burst — real server only. */
    async function storm(
      ops: Array<() => Promise<unknown>>,
    ): Promise<Outcome[]> {
      return Promise.all(ops.map((op) => settle(op)));
    }

    // ─── fixtures ──────────────────────────────────────────────────────────────────────────────────────────────────
    interface Tenant {
      clientId: string;
      mode: 'V2' | 'LEGACY';
      outletTypeId: string;
    }
    interface W {
      walletId: string;
      partnerId: string;
      outletCode: string;
    }
    interface Rev {
      id: string;
      batchId: string;
      points: number;
      fieldId: string;
      outletCode: string;
    }
    const FIELD = 'F-WRE';

    async function tenant(mode: 'V2' | 'LEGACY'): Promise<Tenant> {
      const clientId = `wre-${mode.toLowerCase()}-${rid()}`;
      if (mode === 'V2') {
        await prisma.programSetting.create({
          data: { clientId, settingKey: 'reversalEngine', settingValue: 'V2' },
        });
      }
      tenantModes.set(clientId, mode);
      const type = await prisma.outletType.create({
        data: { code: `WRE_${rid()}`, name: 'WRE e2e' },
      });
      return { clientId, mode, outletTypeId: type.id };
    }

    async function newWallet(
      t: Tenant,
      opts: { debt?: number } = {},
    ): Promise<W> {
      const outletCode = `O-${rid()}`;
      const partner = await prisma.channelPartner.create({
        data: {
          clientId: t.clientId,
          partnerCode: `P-${rid()}`,
          businessName: 'WRE',
          ownerName: 'WRE',
        },
      });
      const w = await prisma.wallet.create({ data: { partnerId: partner.id } });
      await prisma.outlet.create({
        data: {
          clientId: t.clientId,
          partnerId: partner.id,
          outletTypeId: t.outletTypeId,
          outletCode,
          name: outletCode,
          city: 'X',
          state: 'Y',
        },
      });
      if (opts.debt) await seedDebt(w.id, opts.debt);
      return { walletId: w.id, partnerId: partner.id, outletCode };
    }

    /**
     * A wallet as the WP6 backfill leaves a vendor-import negative wallet: seq 1 = the debt-creating debit,
     * B = −debt, D = debt (H = 0), movementSeq 1. (No runtime v2 path creates debt — only history does.)
     */
    async function seedDebt(walletId: string, debt: number): Promise<void> {
      await prisma.$transaction(async (tx) => {
        const lot = await tx.pointsLedger.create({
          data: {
            walletId,
            transactionType: 'ADJUST',
            points: -debt,
            remainingPoints: 0,
          },
        });
        await tx.walletTransaction.create({
          data: {
            walletId,
            transactionType: 'DEBIT_ADJUSTMENT',
            points: -debt,
            balanceBefore: 0,
            balanceAfter: -debt,
            balanceType: 'REDEEMABLE',
            referenceType: SEED_DEBT_REFERENCE,
            description: 'vendor import debt (seed)',
            seq: 1,
            pointsDelta: -debt,
            pointsLedgerId: lot.id,
          },
        });
        await tx.wallet.update({
          where: { id: walletId },
          data: { redeemablePoints: -debt, debtPoints: debt, movementSeq: 1 },
        });
      });
    }

    async function batch(
      t: Tenant,
      rows: Array<{ outletCode: string; amount: number }>,
    ): Promise<string> {
      const b = await prisma.creditBatch.create({
        data: {
          clientId: t.clientId,
          batchCode: `CB-${rid()}`,
          period: '2026-11',
          status: 'CONFIRMED',
          uploadedBy: 'wre-e2e',
          rows: rows.map((r) => ({
            outletId: r.outletCode,
            fieldId: FIELD,
            amount: r.amount,
            awardType: 'POINTS',
            status: 'OK',
          })),
        },
      });
      return b.id;
    }

    /** A credit-batch POINTS credit exactly as confirmBatch posts it (reversible → position on a tracked wallet). */
    function batchCredit(t: Tenant, w: W, batchId: string, amount: number) {
      return wallet.creditEarn(w.partnerId, t.clientId, amount, {
        referenceType: 'CREDIT_BATCH',
        referenceId: batchId,
        metadata: { fieldId: FIELD, outletCode: w.outletCode },
      });
    }

    /**
     * A CreditReversal row. NB: `credit_reversals_pending_unique` allows ONE PENDING_GIFSY reversal per (batch, outlet,
     * field) — a second one for the same credit must carry another status (the engine itself never reads the status).
     */
    async function reversal(
      t: Tenant,
      w: W,
      batchId: string,
      points: number,
      status: 'PENDING_GIFSY' | 'APPROVED' = 'PENDING_GIFSY',
    ): Promise<Rev> {
      const r = await prisma.creditReversal.create({
        data: {
          clientId: t.clientId,
          batchId,
          outletId: w.outletCode,
          outletName: w.outletCode,
          fieldId: FIELD,
          fieldName: 'WRE',
          period: '2026-11',
          awardType: 'POINTS',
          originalPaise: BigInt(points),
          requestedPaise: BigInt(points),
          requestedBy: 'wre-e2e',
          status,
          ...(status === 'APPROVED' ? { approvedPaise: BigInt(points) } : {}),
        },
      });
      return {
        id: r.id,
        batchId,
        points,
        fieldId: FIELD,
        outletCode: w.outletCode,
      };
    }

    /**
     * The §6 approve contract the credits service (WP4) wraps around the engine: credit_batches row lock → guarded
     * PENDING_GIFSY → APPROVED flip (never twice) → reverseCreditBatchPoints (per-tenant dispatcher) → shortfall.
     */
    function approve(t: Tenant, r: Rev, opts: { batchLock?: boolean } = {}) {
      return prisma.$transaction(async (tx) => {
        if (opts.batchLock !== false)
          await tx.$queryRaw`SELECT id FROM credit_batches WHERE id = ${r.batchId} FOR UPDATE`;
        const claimed = await tx.creditReversal.updateMany({
          where: { id: r.id, status: 'PENDING_GIFSY' },
          data: {
            status: 'APPROVED',
            approvedPaise: BigInt(r.points),
            approvedBy: 'wre-e2e',
            approvedAt: new Date(),
          },
        });
        if (claimed.count !== 1)
          throw new BadRequestException('Reversal already processed');
        const res = await wallet.reverseCreditBatchPoints(tx, {
          clientId: t.clientId,
          batchId: r.batchId,
          outletCode: r.outletCode,
          fieldId: r.fieldId,
          creditReversalId: r.id,
          points: r.points,
        });
        if (res.shortfall > 0)
          await tx.creditReversal.update({
            where: { id: r.id },
            data: { shortfallPaise: BigInt(res.shortfall) },
          });
        return res;
      });
    }

    /** The v2 engine alone (no status flip), optionally under the credit_batches lock. */
    function engineApply(r: Rev, opts: { batchLock?: boolean } = {}) {
      return prisma.$transaction(async (tx) => {
        if (opts.batchLock)
          await tx.$queryRaw`SELECT id FROM credit_batches WHERE id = ${r.batchId} FOR UPDATE`;
        return wallet.applyCreditReversal(tx, {
          batchId: r.batchId,
          outletCode: r.outletCode,
          fieldId: r.fieldId,
          creditReversalId: r.id,
          points: r.points,
        });
      });
    }

    const gifsy = (t: Tenant): JwtPayload => ({
      sub: 'wre-e2e-approver',
      role: 'GIFSY_ADMIN',
      clientId: t.clientId,
      phone: '0',
      name: 'WRE',
    });
    const patchApprove = (t: Tenant, r: Rev) =>
      credits.patchReversal(gifsy(t), r.id, {
        action: ReversalAction.approve,
        approvedPaise: r.points,
      });

    function redeem(w: W, amount: number) {
      return wallet.debitRedeem(w.partnerId, amount, {
        referenceId: `RO-${rid()}`,
      });
    }

    /** Make the credit's own lot due, so the sweep picks it (no tenant has an expiry config → no other lot is due). */
    async function makeDue(ledgerId: string) {
      await prisma.pointsLedger.update({
        where: { id: ledgerId },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
    }
    const sweep = () => wallet.expireDuePoints({ now: new Date() });

    // ─── state assertions ──────────────────────────────────────────────────────────────────────────────────────────
    async function expectOracle(walletId: string) {
      const rep = await replayWalletThroughOracle(prisma, walletId);
      expect(rep.mismatches).toEqual([]);
      return rep;
    }

    /** LEGACY wallets: no v2 column written; the before/after pairs chain exactly from 0 to the balance; lots = B. */
    async function expectLegacyChain(walletId: string) {
      const w = await prisma.wallet.findUniqueOrThrow({
        where: { id: walletId },
      });
      const rows = await prisma.walletTransaction.findMany({
        where: { walletId },
      });
      expect(w.movementSeq).toBe(0);
      expect(w.debtPoints).toBe(0);
      expect(rows.every((r) => r.seq === null && r.pointsDelta === null)).toBe(
        true,
      );
      expect(
        await prisma.walletCreditPosition.count({ where: { walletId } }),
      ).toBe(0);
      const left = [...rows];
      let cur = 0;
      while (left.length) {
        const i = left.findIndex((r) => r.balanceBefore === cur);
        if (i < 0)
          throw new Error(
            `legacy chain broken at balance ${cur}: ${JSON.stringify(left.map((r) => [r.balanceBefore, r.balanceAfter]))}`,
          );
        cur = left[i].balanceAfter;
        left.splice(i, 1);
      }
      expect(cur).toBe(w.redeemablePoints);
      const lots = await prisma.pointsLedger.aggregate({
        where: { walletId, isExpired: false, points: { gt: 0 } },
        _sum: { remainingPoints: true },
      });
      expect(lots._sum.remainingPoints ?? 0).toBe(w.redeemablePoints);
      return w;
    }

    async function walletRow(walletId: string) {
      return prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });
    }
    async function allocations(reversalId: string) {
      return prisma.creditReversalAllocation.findMany({
        where: { creditReversalId: reversalId },
      });
    }
    async function clawbackRows(walletId: string, reversalId: string) {
      return prisma.walletTransaction.findMany({
        where: {
          walletId,
          referenceType: 'CREDIT_REVERSAL',
          referenceId: reversalId,
        },
      });
    }
    async function minBalanceAfter(walletId: string) {
      const r = await prisma.walletTransaction.aggregate({
        where: { walletId },
        _min: { balanceAfter: true },
      });
      return r._min.balanceAfter ?? 0;
    }

    // ═══ T-e1 — concurrent credits on one wallet ══════════════════════════════════════════════════════════════════
    describe('T-e1 concurrent credits on one wallet', () => {
      const N = 12;
      const amounts = Array.from({ length: N }, (_, i) => 101 + i * 7); // distinct → the LEGACY chain is unambiguous

      it('V2, pristine wallet: seq 1..N contiguous, no gaps / dupes, B = Σ, one position per batch credit, = oracle', async () => {
        const t = await tenant('V2');
        const w = await newWallet(t);
        const b = await batch(t, [
          {
            outletCode: w.outletCode,
            amount: amounts.reduce((s, a) => s + a, 0),
          },
        ]);
        const out = await race(
          w.walletId,
          amounts.map(
            (a, i) => () =>
              i % 2 === 0
                ? batchCredit(t, w, b, a)
                : wallet.creditEarn(w.partnerId, t.clientId, a, {
                    description: 'manual',
                  }),
          ),
        );
        expect(errs(out)).toEqual([]);
        const rep = await expectOracle(w.walletId);
        const row = await walletRow(w.walletId);
        expect(row.movementSeq).toBe(N);
        expect(row.redeemablePoints).toBe(amounts.reduce((s, a) => s + a, 0));
        expect(row.debtPoints).toBe(0);
        expect(rep.kinds).toHaveLength(N);
        expect(
          await prisma.walletCreditPosition.count({
            where: { walletId: w.walletId },
          }),
        ).toBe(N / 2);
      });

      it('V2, wallet with debt 250: credits repay the debt first (Σ offsets = 250 whatever the order), = oracle', async () => {
        const t = await tenant('V2');
        const w = await newWallet(t, { debt: 250 });
        const b = await batch(t, [{ outletCode: w.outletCode, amount: 600 }]);
        const out = await race(
          w.walletId,
          Array.from({ length: 6 }, () => () => batchCredit(t, w, b, 100)),
        );
        expect(errs(out)).toEqual([]);
        await expectOracle(w.walletId);
        const row = await walletRow(w.walletId);
        expect([row.redeemablePoints, row.debtPoints, row.movementSeq]).toEqual(
          [350, 0, 7],
        );
        const pos = await prisma.walletCreditPosition.findMany({
          where: { walletId: w.walletId },
        });
        expect(pos.reduce((s, p) => s + p.offsetPoints, 0)).toBe(250);
        expect(pos.map((p) => p.offsetPoints).sort((a, b2) => a - b2)).toEqual([
          0, 0, 0, 50, 100, 100,
        ]);
      });

      itServer(
        'V2 storm: 30 ungated credits → seq contiguous, = oracle',
        async () => {
          const t = await tenant('V2');
          const w = await newWallet(t, { debt: 75 });
          const b = await batch(t, [
            { outletCode: w.outletCode, amount: 3000 },
          ]);
          const out = await storm(
            Array.from(
              { length: 30 },
              (_, i) => () => batchCredit(t, w, b, 50 + i),
            ),
          );
          expect(errs(out)).toEqual([]);
          await expectOracle(w.walletId);
          expect((await walletRow(w.walletId)).movementSeq).toBe(31);
        },
      );

      it('LEGACY control: B = Σ, exact before/after chain, lots = B, no v2 column written', async () => {
        const t = await tenant('LEGACY');
        const w = await newWallet(t);
        const b = await batch(t, [
          {
            outletCode: w.outletCode,
            amount: amounts.reduce((s, a) => s + a, 0),
          },
        ]);
        const out = await race(
          w.walletId,
          amounts.map((a) => () => batchCredit(t, w, b, a)),
        );
        expect(errs(out)).toEqual([]);
        const row = await expectLegacyChain(w.walletId);
        expect(row.redeemablePoints).toBe(amounts.reduce((s, a) => s + a, 0));
        if (db.concurrent) {
          const storm2 = await storm(
            amounts.map((a) => () => batchCredit(t, w, b, a + 1000)),
          );
          expect(errs(storm2)).toEqual([]);
          await expectLegacyChain(w.walletId);
        }
      });
    });

    // ═══ connection pool — production sizing ════════════════════════════════════════════════════════════════════
    describe('connection pool at production sizing', () => {
      /**
       * PrismaService builds `new Pool({ connectionString })` (pg default max 10) and Prisma's interactive-transaction
       * timeout defaults to 5 s. WalletService.applyMovement → movementPath reads the tenant flag through
       * TenantSettingsService.getReversalEngineModeUncached, i.e. `this.prisma` — a SECOND pool connection, requested
       * while the transaction (holding the wallet row lock) still holds its own. Once ≥ pool-size wallet transactions are
       * in flight, the lock holder waits for a free connection that only its own lock-waiters can release → every one
       * of them times out. Applies to EVERY tenant (LEGACY wallets with movementSeq 0 take the same read).
       * Was RED (WP7 finding); FIXED in policy round A: movementPath / reverseCreditBatchPoints / the pause gate read
       * through the caller's `tx` (getReversalEngineModeUncached(clientId, tx)) → expected GREEN; regression guard.
       */
      itServer(
        'pool 4, tx timeout 5 s: 6 concurrent credits on one LEGACY wallet all complete',
        async () => {
          const small = db.prisma({ poolSize: 4, txTimeoutMs: 5_000 });
          const ps = small as unknown as PrismaService;
          const svc = new WalletService(ps, new TenantSettingsService(ps));
          const t = await tenant('LEGACY');
          const w = await newWallet(t);
          await holder!.query('BEGIN');
          await holder!.query(
            'SELECT id FROM wallets WHERE id = $1 FOR UPDATE',
            [w.walletId],
          );
          const running = Array.from({ length: 6 }, (_, i) =>
            settle(() =>
              svc.creditEarn(w.partnerId, t.clientId, 10 + i, {
                description: 'pool',
              }),
            ),
          );
          const deadline = Date.now() + 20_000;
          while ((await lockWaiters()) < 4 && Date.now() < deadline)
            await new Promise((r) => setTimeout(r, 15));
          await holder!.query('COMMIT'); // 4 transactions now hold all 4 connections, queued on the wallet lock
          const out = await Promise.all(running);
          expect(errs(out).map((e) => e.message)).toEqual([]);
          expect((await walletRow(w.walletId)).redeemablePoints).toBe(
            10 + 11 + 12 + 13 + 14 + 15,
          );
        },
      );
    });

    // ═══ T-e2 — reversal vs redemption racing ═════════════════════════════════════════════════════════════════════
    describe('T-e2 reversal vs redemption racing', () => {
      /**
       * T-c: −100, E +500 (B 400, O_E 100), then redeem 400 ∥ reverse E 500. Reversal first → B −100, D 100 (the redeem is
       * refused). Redeem first → the 400 were spent: owner decision 2026-11-19 books them as debt → B −500, D 500.
       */
      it.each([['redeem first'], ['reversal first']])(
        'V2 debt wallet (T-c), %s: = oracle; what was spent first is owed as debt (owner 2026-11-19)',
        async (order) => {
          const t = await tenant('V2');
          const w = await newWallet(t, { debt: 100 });
          const b = await batch(t, [{ outletCode: w.outletCode, amount: 500 }]);
          await batchCredit(t, w, b, 500);
          const r = await reversal(t, w, b, 500);
          const ops = [() => redeem(w, 400), () => approve(t, r)];
          const out = await race(
            w.walletId,
            order === 'redeem first' ? ops : [ops[1], ops[0]],
          );
          const [redeemOut, approveOut] =
            order === 'redeem first' ? out : [out[1], out[0]];

          expect(approveOut.ok).toBe(true); // the reversal always goes through (debt if needed)
          const rep = await expectOracle(w.walletId);
          const row = await walletRow(w.walletId);
          const [alloc] = await allocations(r.id);
          const redeemedFirst =
            rep.kinds.indexOf('REDEEM') >= 0 &&
            rep.kinds.indexOf('REDEEM') < rep.kinds.indexOf('REVERSAL');
          if (db.concurrent)
            expect(redeemedFirst).toBe(order === 'redeem first'); // the gate fixed the lock order
          if (redeemedFirst) {
            expect(redeemOut.ok).toBe(true);
            expect([row.redeemablePoints, row.debtPoints]).toEqual([-500, 500]);
            expect([
              alloc.debtRestored,
              alloc.recovered,
              alloc.owed,
              alloc.overReversalDebt,
              alloc.shortfall,
            ]).toEqual([100, 0, 400, true, 0]);
          } else {
            expect(redeemOut.ok).toBe(false); // B −100 < 400 — refused under the lock, never overdrawn
            expect([row.redeemablePoints, row.debtPoints]).toEqual([-100, 100]);
            expect([
              alloc.debtRestored,
              alloc.recovered,
              alloc.owed,
              alloc.overReversalDebt,
              alloc.shortfall,
            ]).toEqual([100, 400, 0, false, 0]);
          }
          // never below the no-new-debt floor −(D0 + O_E) = −100 except by the part owed
          expect(await minBalanceAfter(w.walletId)).toBeGreaterThanOrEqual(-100 - alloc.owed);
          const cr = await prisma.creditReversal.findUniqueOrThrow({
            where: { id: r.id },
          });
          expect(Number(cr.shortfallPaise)).toBe(0); // nothing written off
        },
      );

      it.each([['redeem first'], ['reversal first']])(
        'V2 never-negative wallet, %s: reversal first → B 0 (redeem refused); redeem first → the spent 400 owed as debt (owner 2026-11-19)',
        async (order) => {
          const t = await tenant('V2');
          const w = await newWallet(t);
          const b = await batch(t, [{ outletCode: w.outletCode, amount: 500 }]);
          await batchCredit(t, w, b, 500);
          const r = await reversal(t, w, b, 500);
          const ops = [() => redeem(w, 400), () => approve(t, r)];
          const out = await race(
            w.walletId,
            order === 'redeem first' ? ops : [ops[1], ops[0]],
          );
          expect(out.filter((o) => o.ok).length).toBeGreaterThanOrEqual(1);
          await expectOracle(w.walletId);
          const row = await walletRow(w.walletId);
          const [alloc] = await allocations(r.id);
          const redeemed = out.filter((o) => o.ok).length === 2;
          expect([row.redeemablePoints, row.debtPoints]).toEqual(redeemed ? [-400, 400] : [0, 0]);
          expect([alloc.recovered, alloc.owed, alloc.shortfall]).toEqual(redeemed ? [100, 400, 0] : [500, 0, 0]);
          if (db.concurrent) expect(redeemed).toBe(order === 'redeem first');
          expect(await minBalanceAfter(w.walletId)).toBeGreaterThanOrEqual(-alloc.owed);
        },
      );

      itServer(
        'V2 storm: 8 × redeem 100 ∥ reverse 1000 on a +1000 wallet → Σ redeemed + recovered = 1000, the redeemed part owed as debt (owner 2026-11-19), = oracle',
        async () => {
          const t = await tenant('V2');
          const w = await newWallet(t);
          const b = await batch(t, [
            { outletCode: w.outletCode, amount: 1000 },
          ]);
          await batchCredit(t, w, b, 1000);
          const r = await reversal(t, w, b, 1000);
          const out = await storm([
            ...Array.from({ length: 8 }, () => () => redeem(w, 100)),
            () => approve(t, r),
          ]);
          expect(out[8].ok).toBe(true);
          await expectOracle(w.walletId);
          const [alloc] = await allocations(r.id);
          expect(oks(out.slice(0, 8)) * 100 + alloc.recovered).toBe(1000);
          // what was redeemed before the reversal is owed; no redemption gets through after it (B ≤ 0)
          expect(alloc.owed).toBe(1000 - alloc.recovered);
          const row = await walletRow(w.walletId);
          expect([row.redeemablePoints, row.debtPoints]).toEqual([-alloc.owed, alloc.owed]);
          expect(await minBalanceAfter(w.walletId)).toBeGreaterThanOrEqual(-alloc.owed);
        },
      );

      it.each([['redeem first'], ['reversal first']])(
        'LEGACY control, %s: B 0, never negative, shortfall only when redeemed first',
        async (order) => {
          const t = await tenant('LEGACY');
          const w = await newWallet(t);
          const b = await batch(t, [{ outletCode: w.outletCode, amount: 500 }]);
          await batchCredit(t, w, b, 500);
          const r = await reversal(t, w, b, 500);
          const ops = [() => redeem(w, 400), () => approve(t, r)];
          const out = await race(
            w.walletId,
            order === 'redeem first' ? ops : [ops[1], ops[0]],
          );
          const [redeemOut, approveOut] =
            order === 'redeem first' ? out : [out[1], out[0]];
          expect(approveOut.ok).toBe(true);
          await expectLegacyChain(w.walletId);
          expect((await walletRow(w.walletId)).redeemablePoints).toBe(0); // = V2 oracle on a never-negative wallet (R2)
          expect(await minBalanceAfter(w.walletId)).toBeGreaterThanOrEqual(0);
          const cr = await prisma.creditReversal.findUniqueOrThrow({
            where: { id: r.id },
          });
          if (redeemOut.ok) expect(Number(cr.shortfallPaise)).toBe(400);
          else expect(Number(cr.shortfallPaise)).toBe(0);
          if (db.concurrent)
            expect(redeemOut.ok).toBe(order === 'redeem first');
        },
      );
    });

    // ═══ T-e3 — double approval of the same reversal ══════════════════════════════════════════════════════════════
    describe('T-e3 double approval of the same reversal → exactly one allocation', () => {
      it.each([['with the batch lock'], ['flip only (no batch lock)']])(
        'V2 debt wallet, 4 concurrent approvals %s',
        async (variant) => {
          const t = await tenant('V2');
          const w = await newWallet(t, { debt: 100 });
          const b = await batch(t, [{ outletCode: w.outletCode, amount: 500 }]);
          await batchCredit(t, w, b, 500);
          const r = await reversal(t, w, b, 300);
          const batchLock = variant === 'with the batch lock';
          const out = await race(
            w.walletId,
            Array.from({ length: 4 }, () => () => approve(t, r, { batchLock })),
          );
          expect(oks(out)).toBe(1);
          expect(
            errs(out).every((e) => /already processed/.test(e.message)),
          ).toBe(true);
          const allocs = await allocations(r.id);
          expect(allocs).toHaveLength(1);
          expect([
            allocs[0].debtRestored,
            allocs[0].recovered,
            allocs[0].shortfall,
          ]).toEqual([100, 200, 0]);
          expect(await clawbackRows(w.walletId, r.id)).toHaveLength(1);
          await expectOracle(w.walletId);
          expect([
            (await walletRow(w.walletId)).redeemablePoints,
            (await walletRow(w.walletId)).debtPoints,
          ]).toEqual([100, 100]);
        },
      );

      it('V2 engine alone (no status flip): 3 concurrent applyCreditReversal with one id → the (reversal, position) unique index admits one', async () => {
        const t = await tenant('V2');
        const w = await newWallet(t);
        const b = await batch(t, [{ outletCode: w.outletCode, amount: 500 }]);
        await batchCredit(t, w, b, 500);
        const r = await reversal(t, w, b, 200); // 3 × 200 > 500 would ALSO hit the cap; 200 + 200 fits — only the unique index stops #2
        const op = () =>
          prisma.$transaction((tx) =>
            wallet.applyCreditReversal(tx, {
              batchId: b,
              outletCode: w.outletCode,
              fieldId: FIELD,
              creditReversalId: r.id,
              points: 200,
            }),
          );
        const out = await race(w.walletId, [op, op, op]);
        expect(oks(out)).toBe(1);
        expect(await allocations(r.id)).toHaveLength(1);
        expect(await clawbackRows(w.walletId, r.id)).toHaveLength(1);
        await expectOracle(w.walletId);
        expect((await walletRow(w.walletId)).redeemablePoints).toBe(300);
      });

      it('LEGACY control (engine dispatcher): exactly one clawback', async () => {
        const t = await tenant('LEGACY');
        const w = await newWallet(t);
        const b = await batch(t, [{ outletCode: w.outletCode, amount: 500 }]);
        await batchCredit(t, w, b, 500);
        const r = await reversal(t, w, b, 300);
        const out = await race(
          w.walletId,
          Array.from({ length: 4 }, () => () => approve(t, r)),
        );
        expect(oks(out)).toBe(1);
        expect(await clawbackRows(w.walletId, r.id)).toHaveLength(1);
        expect((await expectLegacyChain(w.walletId)).redeemablePoints).toBe(
          200,
        );
      });

      it.each([['LEGACY'], ['V2']] as const)(
        'credits.service patchReversal, %s tenant (never-negative wallet): 3 concurrent approvals → exactly one',
        async (mode) => {
          const t = await tenant(mode);
          const w = await newWallet(t);
          const b = await batch(t, [{ outletCode: w.outletCode, amount: 500 }]);
          await batchCredit(t, w, b, 500);
          const r = await reversal(t, w, b, 300);
          const out = await race(w.walletId, [
            () => patchApprove(t, r),
            () => patchApprove(t, r),
            () => patchApprove(t, r),
          ]);
          expect(oks(out)).toBe(1);
          expect(
            errs(out).every((e) =>
              /already (processed|APPROVED)/.test(e.message),
            ),
          ).toBe(true);
          expect(await clawbackRows(w.walletId, r.id)).toHaveLength(1);
          expect((await walletRow(w.walletId)).redeemablePoints).toBe(200);
          if (mode === 'V2') {
            // Today's credits path (LEGACY math on a tracked wallet) still keeps ρ + allocations in step — B-neutral.
            expect(await allocations(r.id)).toHaveLength(1);
            await expectOracle(w.walletId);
          } else {
            await expectLegacyChain(w.walletId);
          }
        },
      );

      // TODO(WP4): un-skip once credits.service approve routes POINTS through reverseCreditBatchPoints (V2 math on debt
      // wallets). Today patchReversal calls the LEGACY assertPointsReversalAllowed + clawbackAward directly, which
      // refuses every debt wallet (DEBT_REVERSAL_PAUSED_MESSAGE) — expected after WP4: exactly one approval, T-c result.
      it.skip('[pending WP4] credits.service patchReversal, V2 debt wallet (T-c): 3 concurrent approvals → one allocation, B −500 (the spent 400 owed — owner 2026-11-19)', async () => {
        const t = await tenant('V2');
        const w = await newWallet(t, { debt: 100 });
        const b = await batch(t, [{ outletCode: w.outletCode, amount: 500 }]);
        await batchCredit(t, w, b, 500);
        await redeem(w, 400);
        const r = await reversal(t, w, b, 500);
        const out = await race(w.walletId, [
          () => patchApprove(t, r),
          () => patchApprove(t, r),
          () => patchApprove(t, r),
        ]);
        expect(errs(out).map((e) => e.message)).not.toContain(
          DEBT_REVERSAL_PAUSED_MESSAGE,
        );
        expect(oks(out)).toBe(1);
        const allocs = await allocations(r.id);
        expect(allocs).toHaveLength(1);
        expect([
          allocs[0].debtRestored,
          allocs[0].recovered,
          allocs[0].owed,
          allocs[0].shortfall,
        ]).toEqual([100, 0, 400, 0]);
        expect(
          Number(
            (
              await prisma.creditReversal.findUniqueOrThrow({
                where: { id: r.id },
              })
            ).shortfallPaise,
          ),
        ).toBe(0);
        await expectOracle(w.walletId);
        expect((await walletRow(w.walletId)).redeemablePoints).toBe(-500);
      });
    });

    // ═══ two reversals on the same credit at once (R5 cap) ══════════════════════════════════════════════════════
    // Production allows ONE pending reversal per (batch, outlet, field) (credit_reversals_pending_unique) and serialises
    // create/approve on the batch row, so two reversals of one credit meet as "approve R1 ∥ create R2" (credits.service).
    // Below that, the engine must still hold the cap on its own: two reversal ids applied at once, with and without the
    // batch lock (position + wallet locks alone).
    describe('two reversals of the same credit at once → cap a − ρ respected', () => {
      it.each([
        ['with the batch lock'],
        ['engine only (no batch lock — wallet + position locks alone)'],
      ])(
        'V2 engine, credit 500, reversals 300 ∥ 300 %s → exactly one, ρ 300',
        async (variant) => {
          const t = await tenant('V2');
          const w = await newWallet(t, { debt: 100 });
          const b = await batch(t, [{ outletCode: w.outletCode, amount: 500 }]);
          await batchCredit(t, w, b, 500);
          const r1 = await reversal(t, w, b, 300);
          const r2 = await reversal(t, w, b, 300, 'APPROVED');
          const batchLock = variant === 'with the batch lock';
          const out = await race(w.walletId, [
            () => engineApply(r1, { batchLock }),
            () => engineApply(r2, { batchLock }),
          ]);
          expect(oks(out)).toBe(1);
          expect(errs(out)[0].message).toMatch(
            /exceeds what is still reversible/,
          );
          const pos = await prisma.walletCreditPosition.findFirstOrThrow({
            where: { walletId: w.walletId },
          });
          expect(pos.reversedPoints).toBe(300);
          expect(
            await prisma.creditReversalAllocation.count({
              where: { positionId: pos.id },
            }),
          ).toBe(1);
          await expectOracle(w.walletId);
        },
      );

      it.each([['300 then 200'], ['200 then 300']])(
        'V2 engine, debt wallet, reversals %s at once → both, ρ 500, B −100 D 100 (R3)',
        async (order) => {
          const t = await tenant('V2');
          const w = await newWallet(t, { debt: 100 });
          const b = await batch(t, [{ outletCode: w.outletCode, amount: 500 }]);
          await batchCredit(t, w, b, 500);
          const r300 = await reversal(t, w, b, 300);
          const r200 = await reversal(t, w, b, 200, 'APPROVED');
          const pair = order === '300 then 200' ? [r300, r200] : [r200, r300];
          const out = await race(
            w.walletId,
            pair.map((r) => () => engineApply(r)),
          );
          expect(errs(out)).toEqual([]);
          const rep = await expectOracle(w.walletId);
          const row = await walletRow(w.walletId);
          expect([row.redeemablePoints, row.debtPoints]).toEqual([-100, 100]);
          expect(
            (
              await prisma.walletCreditPosition.findFirstOrThrow({
                where: { walletId: w.walletId },
              })
            ).reversedPoints,
          ).toBe(500);
          if (db.concurrent) {
            const firstRev = await prisma.walletTransaction.findFirstOrThrow({
              where: { id: rep.txIds[rep.kinds.indexOf('REVERSAL')] },
            });
            expect(firstRev.creditReversalId).toBe(pair[0].id);
          }
        },
      );

      it.each([['LEGACY'], ['V2']] as const)(
        'credits.service, %s tenant: approve R1 300 ∥ createReversal R2 (300 / 200) on credit 500 → Σ approved + pending ≤ 500',
        async (mode) => {
          for (const second of [300, 200]) {
            const t = await tenant(mode);
            const w = await newWallet(t);
            const b = await batch(t, [
              { outletCode: w.outletCode, amount: 500 },
            ]);
            await batchCredit(t, w, b, 500);
            const r1 = await reversal(t, w, b, 300);
            const create = () =>
              credits.createReversal(gifsy(t), b, {
                outletId: w.outletCode,
                outletName: w.outletCode,
                fieldId: FIELD,
                fieldName: 'WRE',
                awardType: 'POINTS',
                originalPaise: 500,
                requestedPaise: second,
              });
            const out = await race(w.walletId, [
              () => patchApprove(t, r1),
              create,
            ]);
            expect(out[0].ok).toBe(true);
            const live = await prisma.creditReversal.findMany({
              where: {
                batchId: b,
                outletId: w.outletCode,
                fieldId: FIELD,
                status: { in: ['PENDING_GIFSY', 'APPROVED', 'PARTIAL'] },
              },
            });
            const committed = live.reduce(
              (s, x) =>
                s +
                Number(
                  x.status === 'PENDING_GIFSY'
                    ? x.requestedPaise
                    : (x.approvedPaise ?? 0n),
                ),
              0,
            );
            expect(committed).toBeLessThanOrEqual(500);
            if (second === 300) expect(out[1].ok).toBe(false); // 300 + 300 > 500, whichever order
            expect((await walletRow(w.walletId)).redeemablePoints).toBe(200);
            if (mode === 'V2') await expectOracle(w.walletId);
            else await expectLegacyChain(w.walletId);
          }
        },
      );
    });

    // ═══ expiry sweep vs reversal ═══════════════════════════════════════════════════════════════════════════════
    describe('expiry sweep vs reversal', () => {
      // Owner decision 1 (2026-11-19): the reversed credit's OWN already-expired points count as already recovered —
      // never taken twice, never owed. So the order does not change the end state: B −100 / D 100 either way (the 100
      // of earlier debt the credit had repaid comes back). Expiry first: those 400 pts left as EXPIRY (lifetimeExpired
      // 400) and the allocation books them as alreadyExpired (q = 400), recovered 0, owed 0. Reversal first: the 400
      // are recovered from the balance and nothing is left to expire.
      it.each([['expiry first'], ['reversal first']])(
        'V2 debt wallet, %s → B −100 / D 100 either way; expiry first the expired 400 are alreadyExpired, never owed (owner decision 1, 2026-11-19); = oracle',
        async (order) => {
          const t = await tenant('V2');
          const w = await newWallet(t, { debt: 100 });
          const b = await batch(t, [{ outletCode: w.outletCode, amount: 500 }]);
          const c = await batchCredit(t, w, b, 500);
          await makeDue(c.ledgerId);
          const r = await reversal(t, w, b, 500);
          const ops = [() => sweep(), () => approve(t, r)];
          const out = await race(
            w.walletId,
            order === 'expiry first' ? ops : [ops[1], ops[0]],
          );
          expect(errs(out)).toEqual([]);
          const rep = await expectOracle(w.walletId);
          const row = await walletRow(w.walletId);
          const expiredFirst = rep.kinds.includes('EXPIRY');
          if (db.concurrent)
            expect(expiredFirst).toBe(order === 'expiry first');
          expect([row.redeemablePoints, row.debtPoints]).toEqual([-100, 100]);
          expect(row.lifetimeExpired).toBe(expiredFirst ? 400 : 0);
          const [alloc] = await allocations(r.id);
          expect([
            alloc.debtRestored,
            alloc.alreadyExpired,
            alloc.recovered,
            alloc.owed,
            alloc.shortfall,
          ]).toEqual(expiredFirst ? [100, 400, 0, 0, 0] : [100, 0, 400, 0, 0]);
          expect(await minBalanceAfter(w.walletId)).toBeGreaterThanOrEqual(
            -100 - alloc.owed,
          );
        },
      );

      it.each([['expiry first'], ['reversal first']])(
        'LEGACY control, %s → B 0, never negative',
        async (order) => {
          const t = await tenant('LEGACY');
          const w = await newWallet(t);
          const b = await batch(t, [{ outletCode: w.outletCode, amount: 500 }]);
          const c = await batchCredit(t, w, b, 500);
          await makeDue(c.ledgerId);
          const r = await reversal(t, w, b, 500);
          const ops = [() => sweep(), () => approve(t, r)];
          const out = await race(
            w.walletId,
            order === 'expiry first' ? ops : [ops[1], ops[0]],
          );
          expect(errs(out)).toEqual([]);
          const row = await expectLegacyChain(w.walletId);
          expect(row.redeemablePoints).toBe(0);
          expect(await minBalanceAfter(w.walletId)).toBeGreaterThanOrEqual(0);
          const cr = await prisma.creditReversal.findUniqueOrThrow({
            where: { id: r.id },
          });
          expect(row.lifetimeExpired + (500 - Number(cr.shortfallPaise))).toBe(
            500,
          ); // each point leaves exactly once
          if (db.concurrent)
            expect(row.lifetimeExpired).toBe(
              order === 'expiry first' ? 500 : 0,
            );
        },
      );
    });

    // ═══ T-pay3 — payout reservations (§8, WP5) ═════════════════════════════════════════════════════════════════
    describe('T-pay3 payout reservation vs bank download (§8)', () => {
      async function payoutFixture() {
        const t = await tenant('V2');
        const w = await newWallet(t);
        const b = await prisma.creditBatch.create({
          data: {
            clientId: t.clientId,
            batchCode: `CB-${rid()}`,
            period: '2026-11',
            status: 'CONFIRMED',
            uploadedBy: 'wre-e2e',
            rows: [],
          },
        });
        const entry = await prisma.creditPayoutEntry.create({
          data: {
            clientId: t.clientId,
            batchId: b.id,
            outletId: w.outletCode,
            outletName: w.outletCode,
            fieldId: FIELD,
            fieldName: 'WRE',
            period: '2026-11',
            amountPaise: 50_000n,
          },
        });
        // Only one PENDING_GIFSY reversal per (batch, outlet, field) can exist (credit_reversals_pending_unique); the
        // second contender is an already-APPROVED one (e.g. a WP5 backfill of a legacy approval racing a new reservation).
        const mk = (status: 'PENDING_GIFSY' | 'APPROVED') =>
          prisma.creditReversal.create({
            data: {
              clientId: t.clientId,
              batchId: b.id,
              outletId: w.outletCode,
              outletName: w.outletCode,
              fieldId: FIELD,
              fieldName: 'WRE',
              period: '2026-11',
              awardType: 'PAYOUT',
              originalPaise: 50_000n,
              requestedPaise: 50_000n,
              requestedBy: 'wre-e2e',
              status,
            },
          });
        return {
          t,
          w,
          batchId: b.id,
          entry,
          r1: await mk('PENDING_GIFSY'),
          r2: await mk('APPROVED'),
        };
      }

      it('schema (WP1): two reversals reserving one entry at once → the live-state partial unique index admits one; RELEASED frees it', async () => {
        const { entry, r1, r2 } = await payoutFixture();
        const reserve = (crId: string) => () =>
          prisma.payoutReversalAllocation.create({
            data: {
              creditReversalId: crId,
              payoutEntryId: entry.id,
              amountPaise: 50_000n,
            },
          });
        const out = await Promise.all([
          settle(reserve(r1.id)),
          settle(reserve(r2.id)),
        ]);
        expect(oks(out)).toBe(1);
        expect(errs(out)[0].message).toMatch(/Unique constraint|unique/i);
        const live = await prisma.payoutReversalAllocation.findMany({
          where: { payoutEntryId: entry.id },
        });
        expect(live).toHaveLength(1);
        // reject → RELEASED: the entry becomes reservable again (P2)
        await prisma.payoutReversalAllocation.update({
          where: { id: live[0].id },
          data: { state: 'RELEASED' },
        });
        const loser = live[0].creditReversalId === r1.id ? r2.id : r1.id;
        await expect(reserve(loser)()).resolves.toBeTruthy();
      });

      // TODO(WP5): un-skip and adapt to the real WP5 interface once it lands (being built in parallel in
      // .claude/worktrees/reversal-engine). Written against §8: createReversal takes the selected entry ids (P1) and
      // inserts a RESERVED PayoutReversalAllocation (P2); createPayoutDownload must skip entries with a live RESERVED
      // allocation (P3/Q10) — whichever of (create-reservation, download) wins the race, the entry is EITHER in the bank
      // file (download first → reservation refused or approval refused while PROCESSING) OR reserved and absent from
      // it — never both.
      it.skip('[pending WP5] createReversal(reservation) ∥ createPayoutDownload → entry in the file XOR reserved', async () => {
        const svc = credits as unknown as {
          createReversal(
            u: JwtPayload,
            batchId: string,
            dto: Record<string, unknown>,
          ): Promise<{ id: string }>;
          createPayoutDownload(
            u: JwtPayload,
            dto: Record<string, unknown>,
          ): Promise<{ heldEntries: unknown[]; downloadId: string }>;
        };
        for (const order of ['reserve first', 'download first'] as const) {
          const { t, entry } = await payoutFixture();
          const user = gifsy(t);
          const reserveOp = () =>
            svc.createReversal(user, entry.batchId, {
              outletId: entry.outletId,
              fieldId: entry.fieldId,
              awardType: 'PAYOUT',
              payoutEntryIds: [entry.id],
              remarks: 'wp7',
            });
          const downloadOp = () =>
            svc.createPayoutDownload(user, {
              period: entry.period,
              groupType: 'STANDARD',
            });
          const ops: Array<() => Promise<unknown>> =
            order === 'reserve first'
              ? [reserveOp, downloadOp]
              : [downloadOp, reserveOp];
          // No wallet lock is involved here; WP5's batch/entry locks are the serialisation point → ungated burst.
          if (db.concurrent) await storm(ops);
          else for (const op of ops) await settle(op);
          const e = await prisma.creditPayoutEntry.findUniqueOrThrow({
            where: { id: entry.id },
          });
          const reserved = await prisma.payoutReversalAllocation.count({
            where: { payoutEntryId: entry.id, state: 'RESERVED' },
          });
          const inFile = e.downloadId !== null || e.status === 'PROCESSING';
          expect(inFile && reserved > 0).toBe(false);
          expect(inFile || reserved > 0).toBe(true);
        }
      });
    });
  },
);
