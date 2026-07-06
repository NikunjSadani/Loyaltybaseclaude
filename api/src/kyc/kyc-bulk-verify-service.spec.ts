/**
 * Service-level tests for KycService.bulkVerify (Task 3.4c).
 * Covers: dry-run/commit distinction, tenant scoping, all-7-APPROVE path,
 * REJECT→RE_UPLOAD path, idempotency, per-submission isolation.
 *
 * Mock style follows kyc.service.spec.ts.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, BadRequestException } from '@nestjs/common';
import * as XLSX from 'xlsx';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { KycService } from './kyc.service';
import { SalesNotificationsService } from '../notifications/sales-notifications.service';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Msg91Service } from '../notifications/msg91.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { StorageService } from '../storage/storage.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { KYC_FIELD_ORDER, kycFieldDecisionHeader, kycFieldRemarkHeader } from './kyc-review-dump';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Gifsy admin JWT payload */
const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '', name: '' };
/** Non-admin JWT payload */
const so: JwtPayload = { sub: 'so1', role: 'SALES_SO', clientId: 'deoleo', phone: '', name: '' };

const SUB_ID = 'sub-pending-001';
const SUB_ID_2 = 'sub-pending-002';

/** Build a minimal xlsx Buffer with the given rows. */
function makeXlsx(rows: Record<string, unknown>[]): Buffer {
  const headers: string[] = ['Submission ID'];
  for (const { label } of KYC_FIELD_ORDER) {
    headers.push(kycFieldDecisionHeader(label));
    headers.push(kycFieldRemarkHeader(label));
  }
  const data = rows.map((r) => {
    const out: Record<string, unknown> = { 'Submission ID': r['Submission ID'] ?? '' };
    for (const { label } of KYC_FIELD_ORDER) {
      out[kycFieldDecisionHeader(label)] = r[kycFieldDecisionHeader(label)] ?? '';
      out[kycFieldRemarkHeader(label)] = r[kycFieldRemarkHeader(label)] ?? '';
    }
    return out;
  });
  const ws = XLSX.utils.json_to_sheet(data, { header: headers });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'KYC');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/** A row with all 7 fields APPROVE */
function allApproveRow(submissionId: string): Record<string, unknown> {
  const row: Record<string, unknown> = { 'Submission ID': submissionId };
  for (const { label } of KYC_FIELD_ORDER) {
    row[kycFieldDecisionHeader(label)] = 'APPROVE';
    row[kycFieldRemarkHeader(label)] = '';
  }
  return row;
}

/** A row with OWNER_PHOTO REJECTED and the rest APPROVED */
function ownerRejectRow(submissionId: string): Record<string, unknown> {
  const row: Record<string, unknown> = { 'Submission ID': submissionId };
  for (const { label } of KYC_FIELD_ORDER) {
    if (label === 'Owner Photo') {
      row[kycFieldDecisionHeader(label)] = 'REJECT';
      row[kycFieldRemarkHeader(label)] = 'Photo is blurry';
    } else {
      row[kycFieldDecisionHeader(label)] = 'APPROVE';
      row[kycFieldRemarkHeader(label)] = '';
    }
  }
  return row;
}

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Shared transaction mock — methods are per-test via mockResolvedValue.
const mockTx = {
  kycSubmission: { findFirst: jest.fn(), updateMany: jest.fn() },
  kycVerificationItem: { upsert: jest.fn(), findMany: jest.fn() },
  kycStatusHistory: { create: jest.fn() },
  auditLog: { create: jest.fn() },
  user: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  channelPartner: { findUnique: jest.fn() },
  userSession: { updateMany: jest.fn() },
  wallet: { findFirst: jest.fn(), create: jest.fn() },
  outlet: { update: jest.fn(), updateMany: jest.fn() },
};

const mockPrisma = {
  kycSubmission: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    count: jest.fn(),
    groupBy: jest.fn(),
    update: jest.fn(),
  },
  kycVerificationItem: { upsert: jest.fn(), findMany: jest.fn() },
  kycStatusHistory: { create: jest.fn() },
  auditLog: { create: jest.fn() },
  user: { update: jest.fn() },
  wallet: { findFirst: jest.fn(), create: jest.fn() },
  outlet: { findUnique: jest.fn(), update: jest.fn() },
  $transaction: jest.fn(async (cb: (tx: typeof mockTx) => unknown) => cb(mockTx)),
};

const mockNotifications = { enqueue: jest.fn().mockResolvedValue({ id: 'n1' }) };
const mockStorage = {
  generateKey: jest.fn(),
  uploadFile: jest.fn(),
  getSignedUrl: jest.fn(),
  publicUrl: jest.fn(),
  deleteFile: jest.fn(),
};

// ─── Test suite ──────────────────────────────────────────────────────────────

describe('KycService.bulkVerify (Task 3.4c)', () => {
  let service: KycService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KycService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotifications },
        {
          provide: SalesNotificationsService,
          useValue: {
            outletsAssigned: jest.fn(),
            kycSubmittedForApproval: jest.fn(),
            kycBounced: jest.fn(),
            targetsUploaded: jest.fn(),
          },
        },
        { provide: Msg91Service, useValue: { sendOtp: jest.fn() } },
        { provide: TenantSettingsService, useValue: { getOtpTemplateId: jest.fn(async () => undefined) } },
        { provide: StorageService, useValue: mockStorage },
        { provide: JwtService, useValue: { sign: jest.fn(), verify: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn(() => 'test-secret') } },
      ],
    }).compile();
    service = module.get(KycService);
  });

  // ── Role gate ──────────────────────────────────────────────────────────────
  describe('role gate', () => {
    it('throws ForbiddenException for non-GIFSY_ADMIN', async () => {
      const file = { buffer: Buffer.from('x'), size: 1 } as Express.Multer.File;
      await expect(service.bulkVerify(so, file, false)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ── Empty / bad file ───────────────────────────────────────────────────────
  describe('bad file', () => {
    it('throws BadRequestException for missing file', async () => {
      await expect(
        service.bulkVerify(gifsy, undefined as unknown as Express.Multer.File, false),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequestException for empty buffer', async () => {
      const file = { buffer: Buffer.alloc(0), size: 0 } as Express.Multer.File;
      await expect(service.bulkVerify(gifsy, file, false)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── Dry-run: no DB writes ──────────────────────────────────────────────────
  describe('dry-run (apply=false)', () => {
    it('does NOT write to the DB and returns parse result', async () => {
      mockPrisma.kycSubmission.findMany.mockResolvedValueOnce([{ id: SUB_ID }]);
      const file = { buffer: makeXlsx([allApproveRow(SUB_ID)]), size: 1 } as Express.Multer.File;
      const result = await service.bulkVerify(gifsy, file, false);

      expect(result.committed).toBe(false);
      // No $transaction should have been called
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      // Should have queried for valid PENDING_GIFSY ids — cross-tenant for the Gifsy
      // operator (#38): no caller-tenant filter, bulk-validates every brand.
      const findManyArgs = mockPrisma.kycSubmission.findMany.mock.calls[0][0];
      expect(findManyArgs.where.status).toBe('PENDING_GIFSY');
      expect(findManyArgs.where.user).toBeUndefined();
    });

    it('returns updates and errors in dry-run mode', async () => {
      mockPrisma.kycSubmission.findMany.mockResolvedValueOnce([{ id: SUB_ID }]);
      const file = { buffer: makeXlsx([allApproveRow(SUB_ID)]), size: 1 } as Express.Multer.File;
      const result = await service.bulkVerify(gifsy, file, false) as { committed: false; updates: unknown[]; errors: unknown[] };

      expect(result.updates).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
    });
  });

  // ── Tenant scoping ─────────────────────────────────────────────────────────
  describe('tenant scoping', () => {
    it('only includes PENDING_GIFSY submissions for this tenant in validIds', async () => {
      // DB returns only 1 submission for this tenant
      mockPrisma.kycSubmission.findMany.mockResolvedValueOnce([{ id: SUB_ID }]);
      // The sheet includes a cross-tenant ID
      const file = { buffer: makeXlsx([allApproveRow('FOREIGN-TENANT-SUB')]), size: 1 } as Express.Multer.File;
      const result = await service.bulkVerify(gifsy, file, false) as { errors: Array<{ submissionId: string }> };

      // FOREIGN-TENANT-SUB is not in valid IDs → parse error
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].submissionId).toBe('FOREIGN-TENANT-SUB');
    });
  });

  // ── Commit: all 7 APPROVE → APPROVED + User ACTIVE + wallet + notify ───────
  describe('commit: all-7-APPROVE path', () => {
    beforeEach(() => {
      // Valid pending submission returned for ID load
      mockPrisma.kycSubmission.findMany.mockResolvedValueOnce([{ id: SUB_ID }]);
      // Inside the tx: submission found as PENDING_GIFSY
      mockTx.kycSubmission.findFirst.mockResolvedValue({
        id: SUB_ID,
        userId: 'user-1',
        partnerId: 'partner-1',
        status: 'PENDING_GIFSY',
        user: { name: 'Suresh', phone: '9820100001' },
        partner: {
          outlets: [{ id: 'outlet-1', isPrimary: true, deletedAt: null, reKycFlags: null }],
        },
      });
      // Upserts return mock items
      mockTx.kycVerificationItem.upsert.mockResolvedValue({});
      // After upserts, findMany returns all 7 APPROVED
      mockTx.kycVerificationItem.findMany.mockResolvedValue(
        KYC_FIELD_ORDER.map(({ key }) => ({ fieldKey: key, decision: 'APPROVED' })),
      );
      // Conditional flip succeeds (count=1)
      mockTx.kycSubmission.updateMany.mockResolvedValue({ count: 1 });
      mockTx.wallet.findFirst.mockResolvedValue(null); // no existing wallet
      mockTx.wallet.create.mockResolvedValue({ id: 'wallet-1' });
      mockTx.user.update.mockResolvedValue({});
      mockTx.kycStatusHistory.create.mockResolvedValue({});
      mockTx.auditLog.create.mockResolvedValue({});
    });

    it('calls $transaction once per submission', async () => {
      const file = { buffer: makeXlsx([allApproveRow(SUB_ID)]), size: 1 } as Express.Multer.File;
      await service.bulkVerify(gifsy, file, true);
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('returns outcome=approved', async () => {
      const file = { buffer: makeXlsx([allApproveRow(SUB_ID)]), size: 1 } as Express.Multer.File;
      const result = await service.bulkVerify(gifsy, file, true) as { committed: boolean; results: Array<{ outcome: string }> };
      expect(result.committed).toBe(true);
      expect(result.results[0].outcome).toBe('approved');
    });

    it('activates the user (User.status → ACTIVE)', async () => {
      const file = { buffer: makeXlsx([allApproveRow(SUB_ID)]), size: 1 } as Express.Multer.File;
      await service.bulkVerify(gifsy, file, true);
      expect(mockTx.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { status: 'ACTIVE' },
      });
    });

    it('creates a wallet when none exists', async () => {
      const file = { buffer: makeXlsx([allApproveRow(SUB_ID)]), size: 1 } as Express.Multer.File;
      await service.bulkVerify(gifsy, file, true);
      expect(mockTx.wallet.create).toHaveBeenCalledWith({ data: { partnerId: 'partner-1' } });
    });

    it('item #2: activates the partner\'s outlet(s) on approval (isActive=true)', async () => {
      const file = { buffer: makeXlsx([allApproveRow(SUB_ID)]), size: 1 } as Express.Multer.File;
      await service.bulkVerify(gifsy, file, true);
      expect(mockTx.outlet.updateMany).toHaveBeenCalledWith({
        where: {
          partnerId: 'partner-1',
          deletedAt: null,
          // null-intent (common case) OR not-declined — bare `{not}` excludes NULL rows.
          OR: [{ kycIntent: null }, { kycIntent: { not: 'NOT_INTERESTED' } }],
        },
        data: { isActive: true, reactivatedAt: expect.any(Date), reKycFlags: Prisma.DbNull },
      });
    });

    it('does NOT create a wallet when one already exists (idempotency)', async () => {
      mockTx.wallet.findFirst.mockResolvedValue({ id: 'existing-wallet' });
      const file = { buffer: makeXlsx([allApproveRow(SUB_ID)]), size: 1 } as Express.Multer.File;
      await service.bulkVerify(gifsy, file, true);
      expect(mockTx.wallet.create).not.toHaveBeenCalled();
    });

    it('enqueues a KYC_APPROVED notification (never sync)', async () => {
      const file = { buffer: makeXlsx([allApproveRow(SUB_ID)]), size: 1 } as Express.Multer.File;
      await service.bulkVerify(gifsy, file, true);
      expect(mockNotifications.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          variables: expect.objectContaining({ event: 'KYC_APPROVED' }),
        }),
      );
    });

    it('does NOT enqueue a notification when the commit tx fails (B1: enqueue is post-commit)', async () => {
      // The approved path reaches auditLog.create inside the tx; make it throw so the
      // whole tx would roll back. The notification intent is only returned on success,
      // so notify must never fire for a failed/rolled-back row.
      mockTx.auditLog.create.mockRejectedValueOnce(new Error('audit write failed'));
      const file = { buffer: makeXlsx([allApproveRow(SUB_ID)]), size: 1 } as Express.Multer.File;
      const result = (await service.bulkVerify(gifsy, file, true)) as {
        results: Array<{ outcome: string }>;
      };
      expect(result.results[0].outcome).toBe('error');
      expect(mockNotifications.enqueue).not.toHaveBeenCalled();
    });

    it('uses a conditional updateMany (count=0 → skipped, not double-fire)', async () => {
      // Second writer: count=0 (race loser)
      mockTx.kycSubmission.updateMany.mockResolvedValueOnce({ count: 0 });
      const file = { buffer: makeXlsx([allApproveRow(SUB_ID)]), size: 1 } as Express.Multer.File;
      const result = await service.bulkVerify(gifsy, file, true) as { results: Array<{ outcome: string }> };
      expect(result.results[0].outcome).toBe('skipped');
      // Side effects (user update, wallet create, notify) must NOT have fired
      expect(mockTx.user.update).not.toHaveBeenCalled();
      expect(mockTx.wallet.create).not.toHaveBeenCalled();
      expect(mockNotifications.enqueue).not.toHaveBeenCalled();
    });
  });

  // ── Commit: REJECT → RE_UPLOAD_REQUIRED + reKycFlags ──────────────────────
  describe('commit: rejected-field path', () => {
    beforeEach(() => {
      mockPrisma.kycSubmission.findMany.mockResolvedValueOnce([{ id: SUB_ID }]);
      mockTx.kycSubmission.findFirst.mockResolvedValue({
        id: SUB_ID,
        userId: 'user-1',
        partnerId: 'partner-1',
        status: 'PENDING_GIFSY',
        user: { name: 'Suresh', phone: '9820100001' },
        partner: {
          outlets: [{ id: 'outlet-1', isPrimary: true, deletedAt: null, reKycFlags: null }],
        },
      });
      mockTx.kycVerificationItem.upsert.mockResolvedValue({});
      // All 7 items with OWNER_PHOTO rejected
      mockTx.kycVerificationItem.findMany.mockResolvedValue(
        KYC_FIELD_ORDER.map(({ key }) => ({
          fieldKey: key,
          decision: key === 'OWNER_PHOTO' ? 'REJECTED' : 'APPROVED',
        })),
      );
      mockTx.kycSubmission.updateMany.mockResolvedValue({ count: 1 });
      mockTx.outlet.update.mockResolvedValue({});
      mockTx.kycStatusHistory.create.mockResolvedValue({});
      mockTx.auditLog.create.mockResolvedValue({});
    });

    it('returns outcome=reupload', async () => {
      const file = { buffer: makeXlsx([ownerRejectRow(SUB_ID)]), size: 1 } as Express.Multer.File;
      const result = await service.bulkVerify(gifsy, file, true) as { results: Array<{ outcome: string }> };
      expect(result.results[0].outcome).toBe('reupload');
    });

    it('sets reKycFlags on the primary outlet for the rejected field', async () => {
      const file = { buffer: makeXlsx([ownerRejectRow(SUB_ID)]), size: 1 } as Express.Multer.File;
      await service.bulkVerify(gifsy, file, true);
      const updateCall = mockTx.outlet.update.mock.calls[0][0];
      expect(updateCall.where.id).toBe('outlet-1');
      // ownerPhoto flag should be set
      expect(updateCall.data.reKycFlags).toMatchObject({ ownerPhoto: true });
    });

    it('does NOT activate the user or create a wallet for RE_UPLOAD_REQUIRED', async () => {
      const file = { buffer: makeXlsx([ownerRejectRow(SUB_ID)]), size: 1 } as Express.Multer.File;
      await service.bulkVerify(gifsy, file, true);
      expect(mockTx.user.update).not.toHaveBeenCalled();
      expect(mockTx.wallet.create).not.toHaveBeenCalled();
    });

    it('enqueues a KYC_RE_UPLOAD_REQUIRED notification', async () => {
      const file = { buffer: makeXlsx([ownerRejectRow(SUB_ID)]), size: 1 } as Express.Multer.File;
      await service.bulkVerify(gifsy, file, true);
      expect(mockNotifications.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: expect.objectContaining({ event: 'KYC_RE_UPLOAD_REQUIRED' }),
        }),
      );
    });

    it('throws → rolls back (NO status flip) and errors the row when no primary outlet found', async () => {
      // Override submission to have no primary outlet
      mockTx.kycSubmission.findFirst.mockResolvedValue({
        id: SUB_ID,
        userId: 'user-1',
        partnerId: 'partner-1',
        status: 'PENDING_GIFSY',
        user: { name: 'Suresh', phone: '9820100001' },
        partner: { outlets: [] }, // no primary outlet
      });
      const file = { buffer: makeXlsx([ownerRejectRow(SUB_ID)]), size: 1 } as Express.Multer.File;
      const result = await service.bulkVerify(gifsy, file, true) as { results: Array<{ outcome: string; detail?: string }> };
      expect(result.results[0].outcome).toBe('error');
      // item #1: applyBridgeOutcome now throws a clean ConflictException whose message
      // does not leak the internal submission id; the bulk path surfaces it as the row detail.
      expect(result.results[0].detail).toContain('no active outlet');
      expect(result.results[0].detail).not.toContain(SUB_ID);
      // S1 fix: the outlet is resolved BEFORE the flip, so no status mutation happened.
      expect(mockTx.kycSubmission.updateMany).not.toHaveBeenCalled();
      expect(mockNotifications.enqueue).not.toHaveBeenCalled();
    });
  });

  // ── Idempotency: already-APPROVED submission is skipped ───────────────────
  describe('idempotency', () => {
    it('skips a submission not found as PENDING_GIFSY (already APPROVED)', async () => {
      mockPrisma.kycSubmission.findMany.mockResolvedValueOnce([{ id: SUB_ID }]);
      // Inside tx: findFirst returns null (not PENDING_GIFSY)
      mockTx.kycSubmission.findFirst.mockResolvedValue(null);
      const file = { buffer: makeXlsx([allApproveRow(SUB_ID)]), size: 1 } as Express.Multer.File;
      const result = await service.bulkVerify(gifsy, file, true) as { results: Array<{ outcome: string }> };

      expect(result.results[0].outcome).toBe('skipped');
      expect(mockTx.user.update).not.toHaveBeenCalled();
      expect(mockNotifications.enqueue).not.toHaveBeenCalled();
    });
  });

  // ── Partial-batch isolation ─────────────────────────────────────────────────
  describe('per-submission isolation', () => {
    it('one submission erroring does not prevent others from committing', async () => {
      mockPrisma.kycSubmission.findMany.mockResolvedValueOnce([
        { id: SUB_ID },
        { id: SUB_ID_2 },
      ]);

      // First submission: throws inside tx
      let callCount = 0;
      mockPrisma.$transaction.mockImplementation(async (cb: (tx: typeof mockTx) => unknown) => {
        callCount++;
        if (callCount === 1) throw new Error('DB timeout on submission 1');
        // For the second submission: succeed with recorded
        mockTx.kycSubmission.findFirst.mockResolvedValue({
          id: SUB_ID_2,
          userId: 'user-2',
          partnerId: 'partner-2',
          status: 'PENDING_GIFSY',
          user: { name: 'B', phone: '9000000002' },
          partner: { outlets: [{ id: 'outlet-2', isPrimary: true, deletedAt: null, reKycFlags: null }] },
        });
        mockTx.kycVerificationItem.upsert.mockResolvedValue({});
        // Bridge returns PENDING_GIFSY (partial)
        mockTx.kycVerificationItem.findMany.mockResolvedValue([
          { fieldKey: 'PAYMENT', decision: 'APPROVED' },
        ]);
        return cb(mockTx);
      });

      // Both rows: APPROVE only the PAYMENT field (partial → recorded for SUB_ID_2)
      const makePartialRow = (id: string) => {
        const row: Record<string, unknown> = { 'Submission ID': id };
        for (const { label } of KYC_FIELD_ORDER) {
          row[kycFieldDecisionHeader(label)] = label === 'Payment (Bank/UPI)' ? 'APPROVE' : '';
          row[kycFieldRemarkHeader(label)] = '';
        }
        return row;
      };

      const file = {
        buffer: makeXlsx([makePartialRow(SUB_ID), makePartialRow(SUB_ID_2)]),
        size: 1,
      } as Express.Multer.File;
      const result = await service.bulkVerify(gifsy, file, true) as {
        results: Array<{ submissionId: string; outcome: string }>;
      };

      // First errored, second succeeded
      const r1 = result.results.find((r) => r.submissionId === SUB_ID);
      const r2 = result.results.find((r) => r.submissionId === SUB_ID_2);
      expect(r1?.outcome).toBe('error');
      expect(r2?.outcome).toBe('recorded');
    });
  });

  // ── Partial progress (PENDING_GIFSY) → recorded ────────────────────────────
  describe('partial progress', () => {
    it('returns outcome=recorded when not all 7 fields are terminal', async () => {
      mockPrisma.kycSubmission.findMany.mockResolvedValueOnce([{ id: SUB_ID }]);
      mockTx.kycSubmission.findFirst.mockResolvedValue({
        id: SUB_ID,
        userId: 'user-1',
        partnerId: 'partner-1',
        status: 'PENDING_GIFSY',
        user: { name: 'S', phone: '9820100001' },
        partner: { outlets: [] },
      });
      mockTx.kycVerificationItem.upsert.mockResolvedValue({});
      // Only 1 of 7 fields present → bridge stays PENDING_GIFSY
      mockTx.kycVerificationItem.findMany.mockResolvedValue([
        { fieldKey: 'PAYMENT', decision: 'APPROVED' },
      ]);

      const partialRow: Record<string, unknown> = { 'Submission ID': SUB_ID };
      for (const { label } of KYC_FIELD_ORDER) {
        partialRow[kycFieldDecisionHeader(label)] = label === 'Payment (Bank/UPI)' ? 'APPROVE' : '';
        partialRow[kycFieldRemarkHeader(label)] = '';
      }
      const file = { buffer: makeXlsx([partialRow]), size: 1 } as Express.Multer.File;
      const result = await service.bulkVerify(gifsy, file, true) as {
        results: Array<{ outcome: string }>;
      };
      expect(result.results[0].outcome).toBe('recorded');
      // No status flip
      expect(mockTx.kycSubmission.updateMany).not.toHaveBeenCalled();
    });
  });
});
