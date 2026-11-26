// Points rule DISPLAY NAME (owner-approved 2026-11-26, platform-wide).
// Proves: (1) the name is validated (trimmed, non-blank, ≤120) and carried to new versions; (2) a PUBLISHED rule can
// be renamed WITHOUT a new version — only `name` is written, every version of the logical rule, audited; (3) the name
// NEVER affects compute: identical points, rows (apart from the display-only ruleName), sourceKey, payoutKey and
// ruleVersionsUsed for a named vs an unnamed rule; (4) the reports carry a Rule Name column.
// Run: npx jest --no-coverage src/points-engine/points-rule-name.spec.ts

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PointsEngineService, normalizeRuleName } from './points-engine.service';
import { PointsComputeService } from './points-compute.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { CreditsService } from '../credits/credits.service';
import { TenantService } from '../tenant/tenant.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import type { PointsRule } from '@prisma/client';
import { PAYOUT_REPORT_COLUMNS, PREVIEW_REPORT_COLUMNS } from './points-compute-export.helper';

const clientAdmin: JwtPayload = { sub: 'u_client', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '1', name: 'CA' };
const owner: JwtPayload = { sub: 'u_owner', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '2', name: 'Owner' };

function ruleRow(partial: Partial<PointsRule> = {}): PointsRule {
  return {
    id: 'row_1',
    ruleId: 'rule_cases',
    name: null,
    clientId: 'deoleo',
    version: 3,
    status: 'published',
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    effectiveTo: null,
    evaluationBasis: 'PERIOD_AGGREGATE',
    attachsTo: { scope: 'program_kpi', program: 'GOLD', programCategory: null, kpiCode: 'CASES_SOLD' } as never,
    output: { awardType: 'POINTS', fieldId: 'cf1' } as never,
    rounding: { mode: 'half_up', scale: 0 } as never,
    inputs: [{ ref: 'value', kpiCode: 'CASES_SOLD', type: 'number', nullAs: 'reject' }] as never,
    pipeline: [{ type: 'rate', id: 'n1', measure: { var: 'value' }, rate: 2 }] as never,
    kpiCode: 'CASES_SOLD',
    program: 'GOLD',
    programCategory: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: 'u1',
    ...partial,
  } as PointsRule;
}

function validDto(over: Record<string, unknown> = {}) {
  return {
    effectiveFrom: '2026-02-01',
    attachsTo: { scope: 'program_kpi', program: 'GOLD', programCategory: null, kpiCode: 'CASES_SOLD' },
    output: { awardType: 'POINTS', fieldId: 'cf1' },
    rounding: { mode: 'half_up', scale: 0 },
    inputs: [{ ref: 'value', kpiCode: 'CASES_SOLD', type: 'number', nullAs: 'reject' }],
    pipeline: [{ type: 'rate', id: 'n1', measure: { var: 'value' }, rate: 2 }],
    ...over,
  } as never;
}

// ─── store: create / update / rename ──────────────────────────────────────────────────
describe('Points rule name — store', () => {
  const prisma = {
    pointsRule: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    auditLog: { create: jest.fn() },
    kpiDef: { findMany: jest.fn() },
    outlet: { findMany: jest.fn() },
    $transaction: jest.fn(),
    $executeRaw: jest.fn(),
  };
  let svc: PointsEngineService;

  /** The raw name UPDATE calls as { sql, values }. */
  const rawCalls = () =>
    prisma.$executeRaw.mock.calls.map(([strings, ...values]: [TemplateStringsArray, ...unknown[]]) => ({
      sql: strings.join('?'),
      values,
    }));

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(async (cb: (tx: typeof prisma) => unknown) => cb(prisma));
    prisma.pointsRule.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'row_new', ...data }));
    prisma.pointsRule.update.mockImplementation(async ({ data }: { data: unknown }) => data);
    prisma.$executeRaw.mockResolvedValue(1);
    svc = new PointsEngineService(prisma as unknown as PrismaService);
  });

  it('normalizeRuleName: trims + collapses spaces; null clears; blank / >120 rejected', () => {
    expect(normalizeRuleName('  Unnati –   ADHO 2.5%  ')).toBe('Unnati – ADHO 2.5%');
    expect(normalizeRuleName(null)).toBeNull();
    expect(() => normalizeRuleName('   ')).toThrow(BadRequestException);
    expect(normalizeRuleName('x'.repeat(120))).toHaveLength(120);
    expect(() => normalizeRuleName('x'.repeat(121))).toThrow(/limit is 120/);
  });

  it('createDraft stores the trimmed name on a brand-new rule; a blank name is a 400 before any write', async () => {
    await svc.createDraft(clientAdmin, validDto({ name: '  Unnati – ADHO 2.5% ' }));
    expect(prisma.pointsRule.create.mock.calls[0][0].data.name).toBe('Unnati – ADHO 2.5%');
    expect(prisma.auditLog.create).not.toHaveBeenCalled(); // a brand-new rule is not a rename

    await expect(svc.createDraft(clientAdmin, validDto({ name: '  ' }))).rejects.toThrow(BadRequestException);
    expect(prisma.pointsRule.create).toHaveBeenCalledTimes(1);
  });

  it('a new rule without a name is still accepted by the API (null) — the builder enforces the soft requirement', async () => {
    await svc.createDraft(clientAdmin, validDto());
    expect(prisma.pointsRule.create.mock.calls[0][0].data.name).toBeNull();
  });

  it('a NEW VERSION inherits the rule name; a DIFFERENT supplied name renames every version (audited, same tx)', async () => {
    prisma.pointsRule.findMany
      .mockResolvedValueOnce([
        { version: 1, status: 'archived', evaluationBasis: 'PERIOD_AGGREGATE', name: 'Unnati – ADHO 2.5%' },
        { version: 2, status: 'published', evaluationBasis: 'PERIOD_AGGREGATE', name: 'Unnati – ADHO 2.5%' },
      ]);
    await svc.createDraft(clientAdmin, validDto({ ruleId: 'rule_cases' }));
    const data = prisma.pointsRule.create.mock.calls[0][0].data;
    expect(data.version).toBe(3);
    expect(data.name).toBe('Unnati – ADHO 2.5%');
    expect(prisma.$executeRaw).not.toHaveBeenCalled();

    prisma.pointsRule.findMany
      .mockResolvedValueOnce([{ version: 2, status: 'published', evaluationBasis: 'PERIOD_AGGREGATE', name: 'Old' }])
      .mockResolvedValueOnce([{ id: 'row_2', version: 2, name: 'Old' }, { id: 'row_new', version: 3, name: 'Old' }]);
    const out = await svc.createDraft(clientAdmin, validDto({ ruleId: 'rule_cases', name: 'New name' }));
    expect(out.name).toBe('New name');
    expect(rawCalls()[0].values).toEqual(['New name', 'deoleo', 'rule_cases']);
    expect(prisma.auditLog.create.mock.calls[0][0].data.metadata.via).toBe('new_version');
  });

  it('updateDraft: omitted name → config only (no rename); a CHANGED name renames ALL versions (audited); null clears', async () => {
    const draft = ruleRow({ id: 'row_3', version: 3, status: 'draft', name: 'Keep me' });
    prisma.pointsRule.findFirst.mockResolvedValue(draft);
    prisma.pointsRule.findMany.mockResolvedValue([
      { id: 'row_3', version: 3, name: 'Keep me' },
      { id: 'row_2', version: 2, name: 'Keep me' },
    ]);

    await svc.updateDraft(clientAdmin, 'row_3', validDto());
    expect('name' in prisma.pointsRule.update.mock.calls[0][0].data).toBe(false);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();

    // Same name re-sent → nothing to rename, no audit row.
    await svc.updateDraft(clientAdmin, 'row_3', validDto({ name: ' Keep me ' }));
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();

    await svc.updateDraft(clientAdmin, 'row_3', validDto({ name: ' Edited ' }));
    expect('name' in prisma.pointsRule.update.mock.calls[2][0].data).toBe(false); // name never via the config update
    expect(rawCalls()[0]).toMatchObject({ values: ['Edited', 'deoleo', 'rule_cases'] });
    expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
      entityType: 'POINTS_RULE_RENAME', newValues: { name: 'Edited' }, metadata: { via: 'draft_save', versions: 2 },
    });

    await svc.updateDraft(clientAdmin, 'row_3', validDto({ name: null }));
    expect(rawCalls()[1].values).toEqual([null, 'deoleo', 'rule_cases']);
  });

  it('a PUBLISHED rule CAN be renamed — no new version, only `name` written (updatedAt untouched), audited', async () => {
    const published = ruleRow({ id: 'row_3', version: 3, status: 'published', name: null });
    prisma.pointsRule.findFirst
      .mockResolvedValueOnce(published) // loadForWrite
      .mockResolvedValueOnce({ ...published, name: 'Unnati – ADHO 2.5%' }); // re-read after rename
    prisma.pointsRule.findMany.mockResolvedValue([
      { id: 'row_3', version: 3, name: null },
      { id: 'row_2', version: 2, name: 'Legacy' },
    ]);

    const out = await svc.rename(clientAdmin, 'row_3', '  Unnati – ADHO 2.5% ');

    expect(out.version).toBe(3);
    expect(out.ruleId).toBe('rule_cases');
    expect(out.status).toBe('published');
    expect(prisma.pointsRule.create).not.toHaveBeenCalled();
    expect(prisma.pointsRule.update).not.toHaveBeenCalled();
    expect(prisma.pointsRule.updateMany).not.toHaveBeenCalled(); // Prisma would bump @updatedAt
    const [call] = rawCalls();
    expect(call.sql).toMatch(/UPDATE "points_rules" SET "name" = \? WHERE "clientId" = \? AND "ruleId" = \?/);
    expect(call.sql).not.toMatch(/updatedAt/);
    expect(call.values).toEqual(['Unnati – ADHO 2.5%', 'deoleo', 'rule_cases']);
    const audit = prisma.auditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({
      action: 'UPDATE',
      entityType: 'POINTS_RULE_RENAME',
      entityId: 'rule_cases',
      actorId: 'u_client',
      newValues: { name: 'Unnati – ADHO 2.5%' },
      metadata: { via: 'rename' },
    });
    expect(audit.oldValues.names).toEqual([{ version: 3, name: null }, { version: 2, name: 'Legacy' }]);
  });

  it('"Remove name": rename to null clears every version and is audited', async () => {
    const r = ruleRow({ name: 'Old' });
    prisma.pointsRule.findFirst.mockResolvedValueOnce(r).mockResolvedValueOnce({ ...r, name: null });
    prisma.pointsRule.findMany.mockResolvedValue([{ id: 'row_1', version: 3, name: 'Old' }]);
    const out = await svc.rename(clientAdmin, 'row_1', null);
    expect(out.name).toBeNull();
    expect(rawCalls()[0].values).toEqual([null, 'deoleo', 'rule_cases']);
    expect(prisma.auditLog.create.mock.calls[0][0].data.newValues).toEqual({ name: null });
  });

  it('rename is tenant-scoped (another tenant’s rule → 404, no write) and requires a name field', async () => {
    prisma.pointsRule.findFirst.mockResolvedValue(null);
    await expect(svc.rename(clientAdmin, 'other_tenant_row', 'X')).rejects.toThrow(NotFoundException);
    expect(prisma.pointsRule.findFirst.mock.calls[0][0].where).toEqual({ id: 'other_tenant_row', clientId: 'deoleo' });
    await expect(svc.rename(clientAdmin, 'row_1', undefined)).rejects.toThrow(BadRequestException);
    await expect(svc.rename(clientAdmin, 'row_1', '   ')).rejects.toThrow(BadRequestException);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('an un-assumed Gifsy admin can rename any tenant’s rule; the write stays pinned to that rule’s tenant', async () => {
    const r = ruleRow({ clientId: 'bajaj' });
    prisma.pointsRule.findFirst.mockResolvedValueOnce(r).mockResolvedValueOnce({ ...r, name: 'N' });
    prisma.pointsRule.findMany.mockResolvedValue([{ id: 'row_1', version: 3, name: null }]);
    await svc.rename(owner, 'row_1', 'N');
    expect(prisma.pointsRule.findFirst.mock.calls[0][0].where).toEqual({ id: 'row_1' });
    expect(rawCalls()[0].values).toEqual(['N', 'bajaj', 'rule_cases']);
  });
});

// ─── compute: the name never affects compute / keys ───────────────────────────────────
describe('Points rule name — never affects compute', () => {
  const prisma = {
    pointsRule: { findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
    outlet: { findMany: jest.fn() },
    outletSalesRecord: { findMany: jest.fn() },
    outletTarget: { findMany: jest.fn() },
    creditBatch: { create: jest.fn(), update: jest.fn(), findFirst: jest.fn(), count: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    wallet: { update: jest.fn() },
    creditField: { findMany: jest.fn() },
    kpiDef: { findMany: jest.fn() },
    visibilityCapture: { findMany: jest.fn() },
    outletVisibilityRecord: { findMany: jest.fn() },
    $queryRaw: jest.fn(),
    auditLog: { create: jest.fn(), findFirst: jest.fn() },
    $transaction: jest.fn(),
  };
  const engine = { getActiveForAttachment: jest.fn() };
  const settings = {
    getEffectiveSettings: jest.fn(),
    getPointsEngineFlagsUncached: jest.fn(),
    getPointsEngineFirstLiveMonthUncached: jest.fn().mockResolvedValue(null),
  };
  let svc: PointsComputeService;

  beforeEach(() => {
    jest.clearAllMocks();
    settings.getEffectiveSettings.mockResolvedValue({ pointsEngine: { enabled: true, directCreditEnabled: false } });
    settings.getPointsEngineFlagsUncached.mockResolvedValue({ enabled: true, directCreditEnabled: false });
    settings.getPointsEngineFirstLiveMonthUncached.mockResolvedValue(null);
    prisma.pointsRule.findMany.mockResolvedValue([{ kpiCode: 'CASES_SOLD' }]);
    prisma.outlet.findMany.mockResolvedValue([
      { outletCode: 'O1', name: 'Outlet O1', programName: 'GOLD', programCategory: null, metro: null, outletType: { code: 'SSS' } },
      { outletCode: 'O2', name: 'Outlet O2', programName: 'GOLD', programCategory: null, metro: null, outletType: { code: 'SSS' } },
    ]);
    prisma.outletSalesRecord.findMany.mockResolvedValue([
      { outletCode: 'O1', kpiValues: { CASES_SOLD: 100 } },
      { outletCode: 'O2', kpiValues: { CASES_SOLD: 37 } },
    ]);
    prisma.outletTarget.findMany.mockResolvedValue([]);
    prisma.kpiDef.findMany.mockResolvedValue([]);
    prisma.creditField.findMany.mockResolvedValue([{ id: 'cf1', name: 'Q1 Reward', isActive: true, outletTypeAwards: { SSS: 'POINTS' } }]);
    prisma.creditBatch.findFirst.mockResolvedValue(null);
    prisma.creditBatch.count.mockResolvedValue(0);
    svc = new PointsComputeService(
      prisma as unknown as PrismaService,
      engine as unknown as PointsEngineService,
      settings as unknown as TenantSettingsService,
      { createBatch: jest.fn() } as unknown as CreditsService,
      { resolveVisibilityEnabled: jest.fn(), resolveVisibilityCaptureMode: jest.fn() } as unknown as TenantService,
    );
  });

  async function run(name: string | null) {
    engine.getActiveForAttachment.mockResolvedValue(ruleRow({ name }));
    return svc.previewCompute(clientAdmin, { period: '2026-02' });
  }

  it('named vs unnamed rule → identical points, keys, versions and rows (bar the display-only ruleName)', async () => {
    const unnamed = await run(null);
    const named = await run('Unnati – ADHO 2.5%');
    const renamed = await run('Something else entirely');

    expect(unnamed.rows.every((r) => r.status === 'OK')).toBe(true);
    expect(unnamed.totalPoints).toBe(274); // (100 + 37) × 2
    for (const p of [named, renamed]) {
      expect(p.totalPoints).toBe(unnamed.totalPoints);
      expect(p.counts).toEqual(unnamed.counts);
      expect(p.sourceKey).toBe(unnamed.sourceKey);
      expect(p.payoutKey).toBe(unnamed.payoutKey);
      expect(p.ruleVersionsUsed).toEqual(unnamed.ruleVersionsUsed);
      expect(PointsComputeService.mapPreviewToUploadRows(p)).toEqual(PointsComputeService.mapPreviewToUploadRows(unnamed));
      // Strip the display-only field → rows byte-identical.
      expect(p.rows.map(({ ruleName: _n, ...rest }) => rest)).toEqual(unnamed.rows);
    }
    expect(unnamed.sourceKey).toMatch(/^pe_/);
  });

  it('an unnamed rule adds NO new field to rows / preview (byte-identical to before); a named rule shows its name', async () => {
    const unnamed = await run(null);
    expect(unnamed.rows.some((r) => 'ruleName' in r)).toBe(false);
    expect('ruleNames' in unnamed).toBe(false);

    const named = await run('  Unnati – ADHO 2.5% ');
    expect(named.rows.every((r) => r.ruleName === 'Unnati – ADHO 2.5%')).toBe(true);
    expect(named.ruleNames).toEqual({ rule_cases: 'Unnati – ADHO 2.5%' });
  });

  it('the rule name is never read by the evaluator / key functions (source check)', () => {
    const src = readFileSync(join(__dirname, 'points-compute.service.ts'), 'utf8');
    for (const fn of ['computeSourceKey', 'computePayoutKey', 'importedConfirmKey']) {
      const start = src.indexOf(`function ${fn}(`);
      expect(start).toBeGreaterThan(-1);
      const body = src.slice(start, src.indexOf('\n}\n', start));
      expect(body).not.toMatch(/ruleName|\.name\b/);
    }
  });

  it('the preview + payout reports carry a Rule Name column next to Rule ID', () => {
    for (const cols of [PREVIEW_REPORT_COLUMNS as readonly string[], PAYOUT_REPORT_COLUMNS as readonly string[]]) {
      const i = cols.indexOf('Rule Name');
      expect(i).toBeGreaterThan(-1);
      expect(cols[i + 1]).toBe('Rule ID');
    }
  });
});

// ─── migration ─────────────────────────────────────────────────────────────────────────
describe('Points rule name — migration', () => {
  const sql = readFileSync(
    join(__dirname, '..', '..', 'prisma', 'migrations', '20261126140000_points_rule_name', 'migration.sql'),
    'utf8',
  );
  it('is additive, nullable, re-runnable and lock-bounded', () => {
    expect(sql).toMatch(/SET lock_timeout = '5s';/);
    expect(sql).toMatch(/ALTER TABLE "points_rules" ADD COLUMN IF NOT EXISTS "name" TEXT;/);
    const code = sql.split(/\r?\n/).filter((l) => !l.trim().startsWith('--')).join(' ');
    expect(code).not.toMatch(/NOT NULL|DEFAULT|UPDATE |DROP /i);
    expect(sql).toMatch(/RESET lock_timeout;/);
  });
  it('the schema declares the column as a nullable String', () => {
    const schema = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
    const model = schema.slice(schema.indexOf('model PointsRule {'), schema.indexOf('@@map("points_rules")'));
    expect(model).toMatch(/\n\s+name\s+String\?\n/);
  });
});
