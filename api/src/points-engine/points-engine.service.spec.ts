// Unit tests for PointsEngineService (Points Compute Engine — Wave 0 rule store).
// Focus: version immutability on publish (publish → next version, prior untouched unless its
// window overlaps), validateRule rejection surfaces a 400, tenant READ scoping (a CLIENT_ADMIN
// cannot reach another tenant's rules), and getActiveForAttachment effective-window resolution.
// Run: npx jest --no-coverage src/points-engine/points-engine.service.spec.ts

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PointsEngineService } from './points-engine.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import type { PointsRule } from '@prisma/client';

// The shared contract validator is written by a sibling agent — mock it here so these tests
// exercise the STORE behaviour (not the validator). Default: valid (returns no errors).
jest.mock('./points-engine.helper', () => ({ validateRule: jest.fn(() => []) }));
import { validateRule } from './points-engine.helper';
const mockValidate = validateRule as jest.Mock;

// ── Prisma mock ────────────────────────────────────────────────────────────────
const mockPrisma = {
  pointsRule: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  // $transaction(cb) runs the callback with a tx that reuses the same mocks.
  $transaction: jest.fn(),
};

// ── JWT fixtures ─────────────────────────────────────────────────────────────────
const clientAdmin: JwtPayload = {
  sub: 'u_client', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '1', name: 'CA',
};
// Un-assumed GIFSY_ADMIN → platformWide (no clientId scoping on reads).
const owner: JwtPayload = {
  sub: 'u_owner', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '2', name: 'Owner',
};

// ── helpers ──────────────────────────────────────────────────────────────────────
function validDto(overrides: Record<string, unknown> = {}) {
  return {
    effectiveFrom: '2026-02-01',
    attachsTo: { scope: 'program_kpi', program: 'GOLD', programCategory: null, kpiCode: 'CASES_SOLD' },
    output: { awardType: 'POINTS', fieldId: 'cf_q1' },
    rounding: { mode: 'half_up', scale: 0 },
    inputs: [{ ref: 'value', kpiCode: 'CASES_SOLD', type: 'number', nullAs: 'reject' }],
    pipeline: [{ type: 'rate', id: 'n1', measure: { var: 'value' }, rate: 2 }],
    ...overrides,
  } as never;
}

function row(partial: Partial<PointsRule>): PointsRule {
  return {
    id: 'row_1',
    ruleId: 'rule_1',
    clientId: 'deoleo',
    version: 1,
    status: 'draft',
    effectiveFrom: new Date('2026-02-01T00:00:00.000Z'),
    effectiveTo: null,
    evaluationBasis: 'PERIOD_AGGREGATE',
    attachsTo: { scope: 'program_kpi', program: 'GOLD', programCategory: null, kpiCode: 'CASES_SOLD' } as never,
    output: { awardType: 'POINTS', fieldId: 'cf_q1' } as never,
    rounding: { mode: 'half_up', scale: 0 } as never,
    inputs: [] as never,
    pipeline: [] as never,
    kpiCode: 'CASES_SOLD',
    program: 'GOLD',
    programCategory: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: 'u_client',
    ...partial,
  } as PointsRule;
}

describe('PointsEngineService', () => {
  let service: PointsEngineService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockValidate.mockReturnValue([]);
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: typeof mockPrisma) => unknown) => cb(mockPrisma));
    service = new PointsEngineService(mockPrisma as unknown as PrismaService);
  });

  // ── createDraft ──────────────────────────────────────────────────────────────
  describe('createDraft', () => {
    it('creates a brand-new rule at version 1 (draft), denormalizing attachsTo', async () => {
      mockPrisma.pointsRule.create.mockResolvedValue(row({ version: 1 }));
      await service.createDraft(clientAdmin, validDto());

      expect(mockPrisma.pointsRule.create).toHaveBeenCalledTimes(1);
      const data = mockPrisma.pointsRule.create.mock.calls[0][0].data;
      expect(data.version).toBe(1);
      expect(data.status).toBe('draft');
      expect(data.clientId).toBe('deoleo');
      expect(data.kpiCode).toBe('CASES_SOLD'); // denormalized from attachsTo
      expect(data.program).toBe('GOLD');
      expect(data.createdBy).toBe('u_client');
      expect(typeof data.ruleId).toBe('string');
    });

    it('adds the NEXT version when ruleId already has published versions', async () => {
      mockPrisma.pointsRule.findMany.mockResolvedValue([{ version: 1, status: 'published' }]);
      mockPrisma.pointsRule.create.mockResolvedValue(row({ version: 2 }));

      await service.createDraft(clientAdmin, validDto({ ruleId: 'rule_1' }));
      const data = mockPrisma.pointsRule.create.mock.calls[0][0].data;
      expect(data.version).toBe(2);
      expect(data.ruleId).toBe('rule_1');
    });

    it('rejects a SECOND open draft for the same ruleId', async () => {
      mockPrisma.pointsRule.findMany.mockResolvedValue([{ version: 1, status: 'draft' }]);
      await expect(service.createDraft(clientAdmin, validDto({ ruleId: 'rule_1' })))
        .rejects.toBeInstanceOf(ConflictException);
      expect(mockPrisma.pointsRule.create).not.toHaveBeenCalled();
    });

    it('surfaces a validateRule rejection as a 400 and does NOT persist', async () => {
      mockValidate.mockReturnValue(['slab bands overlap']);
      await expect(service.createDraft(clientAdmin, validDto())).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.pointsRule.create).not.toHaveBeenCalled();
    });
  });

  // ── updateDraft ──────────────────────────────────────────────────────────────
  describe('updateDraft', () => {
    it('updates a draft in place (re-denormalizing) and re-validates', async () => {
      mockPrisma.pointsRule.findFirst.mockResolvedValue(row({ status: 'draft' }));
      mockPrisma.pointsRule.update.mockResolvedValue(row({ status: 'draft' }));

      await service.updateDraft(clientAdmin, 'row_1', validDto({
        attachsTo: { scope: 'program_kpi', program: 'SILVER', programCategory: 'Premium', kpiCode: 'LITRES' },
      }));
      const data = mockPrisma.pointsRule.update.mock.calls[0][0].data;
      expect(data.kpiCode).toBe('LITRES');
      expect(data.program).toBe('SILVER');
      expect(data.programCategory).toBe('Premium');
      expect(data.status).toBeUndefined(); // status/version are not editable here
      expect(mockValidate).toHaveBeenCalled();
    });

    it('refuses to edit a PUBLISHED version (immutable)', async () => {
      mockPrisma.pointsRule.findFirst.mockResolvedValue(row({ status: 'published' }));
      await expect(service.updateDraft(clientAdmin, 'row_1', validDto()))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.pointsRule.update).not.toHaveBeenCalled();
    });
  });

  // ── publish ──────────────────────────────────────────────────────────────────
  describe('publish', () => {
    it('promotes a draft to published WITHOUT mutating its version', async () => {
      mockPrisma.pointsRule.findFirst.mockResolvedValue(row({ id: 'row_v2', version: 2, status: 'draft' }));
      mockPrisma.pointsRule.findMany.mockResolvedValue([]); // no prior published
      mockPrisma.pointsRule.update.mockResolvedValue(row({ id: 'row_v2', version: 2, status: 'published' }));

      const res = await service.publish(clientAdmin, 'row_v2');
      expect(mockPrisma.pointsRule.update).toHaveBeenCalledWith({
        where: { id: 'row_v2' },
        data: { status: 'published' }, // only status — version untouched
      });
      expect(res.version).toBe(2);
    });

    it('supersedes a prior published version whose window OVERLAPS (archive + close effectiveTo)', async () => {
      const draftV2 = row({ id: 'row_v2', version: 2, status: 'draft', effectiveFrom: new Date('2026-03-01T00:00:00.000Z') });
      const priorV1 = row({ id: 'row_v1', version: 1, status: 'published', effectiveFrom: new Date('2026-01-01T00:00:00.000Z'), effectiveTo: null });
      mockPrisma.pointsRule.findFirst.mockResolvedValue(draftV2);
      // publish() queries findMany twice: 1st = other-ruleId clashes (none here), 2nd = same-ruleId priors.
      mockPrisma.pointsRule.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([priorV1]);
      mockPrisma.pointsRule.update.mockResolvedValue(row({ id: 'row_v2', version: 2, status: 'published' }));

      await service.publish(clientAdmin, 'row_v2');
      const priorUpdate = mockPrisma.pointsRule.update.mock.calls.find((c) => c[0].where.id === 'row_v1');
      expect(priorUpdate).toBeDefined();
      expect(priorUpdate![0].data.status).toBe('archived');
      // effectiveTo closed to the day before the new rule's effectiveFrom (2026-02-28).
      expect((priorUpdate![0].data.effectiveTo as Date).toISOString().slice(0, 10)).toBe('2026-02-28');
    });

    it('leaves a prior published version UNTOUCHED when windows do NOT overlap', async () => {
      const draftV2 = row({ id: 'row_v2', version: 2, status: 'draft', effectiveFrom: new Date('2026-03-01T00:00:00.000Z') });
      // v1 ends BEFORE v2 begins → no overlap.
      const priorV1 = row({ id: 'row_v1', version: 1, status: 'published', effectiveFrom: new Date('2026-01-01T00:00:00.000Z'), effectiveTo: new Date('2026-02-01T00:00:00.000Z') });
      mockPrisma.pointsRule.findFirst.mockResolvedValue(draftV2);
      // publish() queries findMany twice: 1st = other-ruleId clashes (none here), 2nd = same-ruleId priors.
      mockPrisma.pointsRule.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([priorV1]);
      mockPrisma.pointsRule.update.mockResolvedValue(row({ id: 'row_v2', status: 'published' }));

      await service.publish(clientAdmin, 'row_v2');
      const priorUpdate = mockPrisma.pointsRule.update.mock.calls.find((c) => c[0].where.id === 'row_v1');
      expect(priorUpdate).toBeUndefined(); // v1 is immutable + untouched
    });

    it('HIGH-2: refuses to publish when a DIFFERENT ruleId already governs the same attachment+window', async () => {
      const draftB = row({ id: 'row_b', ruleId: 'rule_2', version: 1, status: 'draft', effectiveFrom: new Date('2026-02-01T00:00:00.000Z') });
      const otherA = row({ id: 'row_a', ruleId: 'rule_1', version: 1, status: 'published', effectiveFrom: new Date('2026-01-01T00:00:00.000Z'), effectiveTo: null });
      mockPrisma.pointsRule.findFirst.mockResolvedValue(draftB);
      // 1st findMany = the other-ruleId clash query → returns the conflicting published rule.
      mockPrisma.pointsRule.findMany.mockResolvedValueOnce([otherA]);
      await expect(service.publish(clientAdmin, 'row_b')).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses to publish an already-published rule', async () => {
      mockPrisma.pointsRule.findFirst.mockResolvedValue(row({ status: 'published' }));
      await expect(service.publish(clientAdmin, 'row_1')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── tenant scoping ─────────────────────────────────────────────────────────────
  describe('tenant scope', () => {
    it('pins a CLIENT_ADMIN list to their own clientId', async () => {
      mockPrisma.pointsRule.findMany.mockResolvedValue([]);
      await service.list(clientAdmin, {});
      expect(mockPrisma.pointsRule.findMany.mock.calls[0][0].where.clientId).toBe('deoleo');
    });

    it('lets an un-assumed GIFSY_ADMIN read platform-wide (no clientId filter)', async () => {
      mockPrisma.pointsRule.findMany.mockResolvedValue([]);
      await service.list(owner, {});
      expect(mockPrisma.pointsRule.findMany.mock.calls[0][0].where.clientId).toBeUndefined();
    });

    it('a CLIENT_ADMIN cannot GET another tenant\'s rule (scoped findFirst → 404)', async () => {
      // findFirst is called with the clientId filter, so a cross-tenant id returns null.
      mockPrisma.pointsRule.findFirst.mockResolvedValue(null);
      await expect(service.get(clientAdmin, 'row_other')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPrisma.pointsRule.findFirst.mock.calls[0][0].where.clientId).toBe('deoleo');
    });
  });

  // ── getActiveForAttachment ───────────────────────────────────────────────────────
  describe('getActiveForAttachment', () => {
    it('queries published rules within the effective window and returns the single match', async () => {
      const match = row({ id: 'active', status: 'published' });
      mockPrisma.pointsRule.findMany.mockResolvedValue([match]);

      const res = await service.getActiveForAttachment('deoleo', 'GOLD', null, 'CASES_SOLD', new Date('2026-02-15T00:00:00.000Z'));
      expect(res?.id).toBe('active');
      const where = mockPrisma.pointsRule.findMany.mock.calls[0][0].where;
      expect(where.clientId).toBe('deoleo');
      expect(where.status).toBe('published');
      expect(where.kpiCode).toBe('CASES_SOLD');
      expect(where.effectiveFrom.lte).toBeInstanceOf(Date);
    });

    it('prefers the most SPECIFIC match (exact program over a wildcard), then recency', async () => {
      const wildcard = row({ id: 'wild', program: null, programCategory: null, effectiveFrom: new Date('2026-02-01T00:00:00.000Z') });
      const specific = row({ id: 'spec', program: 'GOLD', programCategory: null, effectiveFrom: new Date('2026-01-01T00:00:00.000Z') });
      mockPrisma.pointsRule.findMany.mockResolvedValue([wildcard, specific]);

      const res = await service.getActiveForAttachment('deoleo', 'GOLD', null, 'CASES_SOLD', new Date('2026-02-15T00:00:00.000Z'));
      expect(res?.id).toBe('spec'); // exact program beats the wildcard even though it is older
    });

    it('returns null when nothing is effective', async () => {
      mockPrisma.pointsRule.findMany.mockResolvedValue([]);
      const res = await service.getActiveForAttachment('deoleo', 'GOLD', null, 'CASES_SOLD', new Date('2026-02-15T00:00:00.000Z'));
      expect(res).toBeNull();
    });
  });
});
