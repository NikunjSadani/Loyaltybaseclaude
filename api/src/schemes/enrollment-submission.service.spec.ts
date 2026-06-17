/**
 * enrollment-submission.service.spec.ts — P4.3
 *
 * Unit tests for SchemesService.submitEnrollment and getMyEnrollment.
 *
 * Covers:
 *   A) SELF happy path — partner enrolls, form values validated + CALCULATED recomputed.
 *   B) SALES on-behalf — assigned sales user succeeds; unassigned → Forbidden.
 *   C) Audience mismatch — LOYALTY_ONLY + non-KYC partner → Forbidden.
 *   D) Audience mismatch — OPEN_CAMPAIGN + KYC-approved partner → Forbidden.
 *   E) Missing required field → BadRequest.
 *   F) CALCULATED value tampered — server recompute wins (client value discarded).
 *   G) Re-enrollment — upsert updates formValues + status.
 *   H) Tenant scope — foreign scheme → NotFound.
 *   I) Tenant scope — SALES with foreign target partner → NotFound.
 *   J) Scheme not ACTIVE → BadRequest.
 *   K) Scheme outside date window → BadRequest.
 *   L) getMyEnrollment — returns enrollment when it exists.
 *   M) getMyEnrollment — 404 when not enrolled.
 *
 * Run: npx jest src/schemes/enrollment-submission.service.spec.ts
 */

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { SchemesService } from './schemes.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const PAST  = new Date('2020-01-01');
const NOW   = new Date();
const FUTURE = new Date('2099-12-31');

/** Builds a live, ACTIVE scheme with a LOYALTY_ONLY enrollment form. */
const makeScheme = (overrides: Record<string, unknown> = {}) => ({
  id: 'scheme1',
  clientId: 'deoleo',
  status: 'ACTIVE',
  startDate: PAST,
  endDate: FUTURE,
  deletedAt: null,
  enrollmentForm: {
    campaignType: 'LOYALTY_ONLY',
    formSchema: {
      captureGpsOnSubmit: false,
      requireOtp: false,
      fields: [
        {
          id: 'f1',
          type: 'TEXT',
          label: 'Shop name',
          required: true,
          autoFillFromExcel: false,
          autoFillEditable: false,
          order: 0,
        },
      ],
    },
  },
  ...overrides,
});

/** Builds an APPROVED ChannelPartner (KYC status APPROVED). */
const makeApprovedPartner = (userId = 'partner-user') => ({
  id: 'cp1',
  userId,
  clientId: 'deoleo',
  deletedAt: null,
  kycSubmissions: [{ status: 'APPROVED' }],
});

/** Builds a non-KYC ChannelPartner (no submissions). */
const makeNonKycPartner = (userId = 'partner-user') => ({
  id: 'cp1',
  userId,
  clientId: 'deoleo',
  deletedAt: null,
  kycSubmissions: [],
});

// ─────────────────────────────────────────────────────────────────────────────
// Mock Prisma
// ─────────────────────────────────────────────────────────────────────────────

const mockPrisma = {
  scheme: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  schemeEligibility: { findMany: jest.fn() },
  schemeEnrollmentForm: { upsert: jest.fn(), findUnique: jest.fn() },
  schemeEnrollment: {
    upsert: jest.fn(),
    findUnique: jest.fn(),
  },
  channelPartner: { findFirst: jest.fn() },
  salesUser: { findFirst: jest.fn() },
  salesUserAssignment: { findFirst: jest.fn() },
};

// ─────────────────────────────────────────────────────────────────────────────
// JWT fixtures
// ─────────────────────────────────────────────────────────────────────────────

const partnerUser: JwtPayload = {
  sub: 'partner-user',
  role: 'RETAILER',
  clientId: 'deoleo',
  phone: '',
  name: '',
};

const salesUser: JwtPayload = {
  sub: 'sales-user',
  role: 'SALES_SO',
  clientId: 'deoleo',
  phone: '',
  name: '',
};

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe('SchemesService — P4.3 enrollment submission', () => {
  let service: SchemesService;

  beforeEach(async () => {
    // resetAllMocks (not clearAllMocks) so mockResolvedValueOnce queues don't
    // leak across tests — early-throwing cases consume fewer Once values than
    // they queue, and clearAllMocks does not drain the once-queue.
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SchemesService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get(SchemesService);
  });

  // ── A) SELF happy path ────────────────────────────────────────────────────
  describe('A) SELF happy path', () => {
    it('enrolls the caller when all checks pass', async () => {
      // Partner exists in tenant.
      mockPrisma.channelPartner.findFirst
        .mockResolvedValueOnce({ id: 'cp1', userId: 'partner-user', deletedAt: null })
        // audience check — KYC-approved
        .mockResolvedValueOnce(makeApprovedPartner());

      // Scheme: LOYALTY_ONLY form, one required TEXT field.
      mockPrisma.scheme.findFirst.mockResolvedValue(makeScheme());

      const fakeEnrollment = { id: 'enr1', schemeId: 'scheme1', userId: 'partner-user', status: 'ACTIVE' };
      mockPrisma.schemeEnrollment.upsert.mockResolvedValue(fakeEnrollment);

      const result = await service.submitEnrollment(partnerUser, 'scheme1', {
        enrollmentMode: 'SELF',
        formValues: { f1: 'My Shop' },
      });

      expect(result).toEqual({ enrollment: fakeEnrollment });

      // Verify the upsert was called with the correct userId.
      const upsertCall = mockPrisma.schemeEnrollment.upsert.mock.calls[0][0];
      expect(upsertCall.where).toEqual({ schemeId_userId: { schemeId: 'scheme1', userId: 'partner-user' } });
      expect(upsertCall.create.enrollmentMode).toBe('SELF');
    });

    it('throws Forbidden when the caller has no ChannelPartner record', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);

      await expect(
        service.submitEnrollment(partnerUser, 'scheme1', { enrollmentMode: 'SELF' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ── B) SALES on-behalf ────────────────────────────────────────────────────
  describe('B) SALES on-behalf', () => {
    const salesDto = {
      enrollmentMode: 'SALES' as const,
      targetPartnerId: 'cp1',
      formValues: { f1: 'Target Shop' },
    };

    beforeEach(() => {
      // Target partner in tenant.
      mockPrisma.channelPartner.findFirst
        // target partner lookup
        .mockResolvedValueOnce({ id: 'cp1', userId: 'partner-user', clientId: 'deoleo', deletedAt: null })
        // audience check (approved)
        .mockResolvedValueOnce(makeApprovedPartner('partner-user'));

      mockPrisma.scheme.findFirst.mockResolvedValue(makeScheme());
      mockPrisma.schemeEnrollment.upsert.mockResolvedValue({ id: 'enr1', status: 'ACTIVE' });
    });

    it('succeeds when the sales user has an active assignment', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1' });
      mockPrisma.salesUserAssignment.findFirst.mockResolvedValue({ id: 'asgn1' });

      const result = await service.submitEnrollment(salesUser, 'scheme1', salesDto);
      expect(result.enrollment).toBeDefined();

      // Enrolled userId must be the TARGET partner's userId, not the sales user.
      const upsertCall = mockPrisma.schemeEnrollment.upsert.mock.calls[0][0];
      expect(upsertCall.create.userId).toBe('partner-user');
      expect(upsertCall.create.enrollmentMode).toBe('SALES');
    });

    it('throws Forbidden when the sales user has no assignment to the target partner', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1' });
      mockPrisma.salesUserAssignment.findFirst.mockResolvedValue(null); // no assignment

      await expect(
        service.submitEnrollment(salesUser, 'scheme1', salesDto),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws Forbidden when the caller is not a SalesUser', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue(null); // not a sales user

      await expect(
        service.submitEnrollment(salesUser, 'scheme1', salesDto),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws BadRequest when targetPartnerId is missing in SALES mode', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1' });

      await expect(
        service.submitEnrollment(salesUser, 'scheme1', { enrollmentMode: 'SALES' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── C) Audience mismatch: LOYALTY_ONLY + non-KYC ─────────────────────────
  describe('C) audience mismatch — LOYALTY_ONLY + non-KYC', () => {
    it('rejects enrollment with a clear 403', async () => {
      // Partner exists (SELF mode).
      mockPrisma.channelPartner.findFirst
        .mockResolvedValueOnce({ id: 'cp1', userId: 'partner-user', deletedAt: null })
        // audience check — non-KYC (no submissions)
        .mockResolvedValueOnce(makeNonKycPartner());

      mockPrisma.scheme.findFirst.mockResolvedValue(makeScheme({ /* campaignType: LOYALTY_ONLY */ }));

      await expect(
        service.submitEnrollment(partnerUser, 'scheme1', {
          enrollmentMode: 'SELF',
          formValues: { f1: 'Shop' },
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ── D) Audience mismatch: OPEN_CAMPAIGN + KYC-approved ───────────────────
  describe('D) audience mismatch — OPEN_CAMPAIGN + KYC-approved', () => {
    it('rejects a KYC-approved partner from OPEN_CAMPAIGN scheme', async () => {
      mockPrisma.channelPartner.findFirst
        .mockResolvedValueOnce({ id: 'cp1', userId: 'partner-user', deletedAt: null })
        .mockResolvedValueOnce(makeApprovedPartner());

      mockPrisma.scheme.findFirst.mockResolvedValue(
        makeScheme({
          enrollmentForm: {
            campaignType: 'OPEN_CAMPAIGN',
            formSchema: {
              captureGpsOnSubmit: false,
              requireOtp: false,
              fields: [
                {
                  id: 'f1', type: 'TEXT', label: 'Shop', required: false,
                  autoFillFromExcel: false, autoFillEditable: false, order: 0,
                },
              ],
            },
          },
        }),
      );

      await expect(
        service.submitEnrollment(partnerUser, 'scheme1', { enrollmentMode: 'SELF' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ── E) Missing required field ─────────────────────────────────────────────
  describe('E) missing required field', () => {
    it('throws BadRequest when a required field is absent', async () => {
      mockPrisma.channelPartner.findFirst
        .mockResolvedValueOnce({ id: 'cp1', userId: 'partner-user', deletedAt: null })
        .mockResolvedValueOnce(makeApprovedPartner());

      mockPrisma.scheme.findFirst.mockResolvedValue(makeScheme());

      await expect(
        service.submitEnrollment(partnerUser, 'scheme1', {
          enrollmentMode: 'SELF',
          formValues: {}, // f1 is required but missing
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Enrollment upsert must NOT be called.
      expect(mockPrisma.schemeEnrollment.upsert).not.toHaveBeenCalled();
    });
  });

  // ── F) CALCULATED field — server recompute wins ───────────────────────────
  describe('F) CALCULATED field — server recompute wins', () => {
    it('ignores the client-sent calculated value and uses server recompute', async () => {
      mockPrisma.channelPartner.findFirst
        .mockResolvedValueOnce({ id: 'cp1', userId: 'partner-user', deletedAt: null })
        .mockResolvedValueOnce(makeApprovedPartner());

      const schemeWithCalc = makeScheme({
        enrollmentForm: {
          campaignType: 'LOYALTY_ONLY',
          formSchema: {
            captureGpsOnSubmit: false,
            requireOtp: false,
            fields: [
              {
                id: 'qty',
                type: 'NUMBER',
                label: 'Quantity',
                required: true,
                autoFillFromExcel: false,
                autoFillEditable: false,
                order: 0,
              },
              {
                id: 'score',
                type: 'CALCULATED',
                label: 'Score',
                required: false,
                autoFillFromExcel: false,
                autoFillEditable: false,
                formula: '{qty} * 2',
                order: 1,
              },
            ],
          },
        },
      });
      mockPrisma.scheme.findFirst.mockResolvedValue(schemeWithCalc);
      mockPrisma.schemeEnrollment.upsert.mockResolvedValue({ id: 'enr1', status: 'ACTIVE' });

      await service.submitEnrollment(partnerUser, 'scheme1', {
        enrollmentMode: 'SELF',
        formValues: {
          qty: '5',
          score: '9999', // tampered — must be ignored; server should compute 10
        },
      });

      const upsertCall = mockPrisma.schemeEnrollment.upsert.mock.calls[0][0];
      // formValues merged: submitted qty preserved, score overwritten by server.
      const fv = upsertCall.create.formValues as Record<string, unknown>;
      expect(fv.qty).toBe('5');
      expect(fv.score).toBe(10); // 5 * 2 = 10
    });
  });

  // ── G) Re-enrollment — upsert updates ─────────────────────────────────────
  describe('G) re-enrollment', () => {
    it('calls upsert so a second enrollment updates the existing record', async () => {
      mockPrisma.channelPartner.findFirst
        .mockResolvedValueOnce({ id: 'cp1', userId: 'partner-user', deletedAt: null })
        .mockResolvedValueOnce(makeApprovedPartner());

      mockPrisma.scheme.findFirst.mockResolvedValue(makeScheme());
      mockPrisma.schemeEnrollment.upsert.mockResolvedValue({ id: 'enr1', status: 'ACTIVE', formValues: { f1: 'Updated' } });

      const result = await service.submitEnrollment(partnerUser, 'scheme1', {
        enrollmentMode: 'SELF',
        formValues: { f1: 'Updated' },
      });

      expect(result.enrollment.status).toBe('ACTIVE');

      const upsertCall = mockPrisma.schemeEnrollment.upsert.mock.calls[0][0];
      // Both create and update blocks must set status ACTIVE and the form values.
      expect(upsertCall.create.status).toBe('ACTIVE');
      expect(upsertCall.update.status).toBe('ACTIVE');
      // The unique key must match the Prisma compound unique name.
      expect(upsertCall.where).toEqual({
        schemeId_userId: { schemeId: 'scheme1', userId: 'partner-user' },
      });
    });
  });

  // ── H) Tenant scope — foreign scheme ─────────────────────────────────────
  describe('H) tenant scope — foreign scheme', () => {
    it('throws NotFound when the scheme belongs to a different tenant', async () => {
      // Partner check passes (SELF mode).
      mockPrisma.channelPartner.findFirst.mockResolvedValue({
        id: 'cp1',
        userId: 'partner-user',
        deletedAt: null,
      });

      // scheme.findFirst returns null because where includes clientId from JWT.
      mockPrisma.scheme.findFirst.mockResolvedValue(null);

      await expect(
        service.submitEnrollment(partnerUser, 'foreign-scheme', {
          enrollmentMode: 'SELF',
          formValues: {},
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── I) Tenant scope — SALES with foreign partner ──────────────────────────
  describe('I) tenant scope — SALES with foreign target partner', () => {
    it('throws NotFound when targetPartnerId belongs to another tenant', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1' });
      // The target partner lookup (tenant-scoped) returns null.
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);

      await expect(
        service.submitEnrollment(salesUser, 'scheme1', {
          enrollmentMode: 'SALES',
          targetPartnerId: 'foreign-partner',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── J) Scheme not ACTIVE ──────────────────────────────────────────────────
  describe('J) scheme not ACTIVE', () => {
    it('throws BadRequest when the scheme is PAUSED', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({
        id: 'cp1',
        userId: 'partner-user',
        deletedAt: null,
      });

      mockPrisma.scheme.findFirst.mockResolvedValue(
        makeScheme({ status: 'PAUSED' }),
      );

      await expect(
        service.submitEnrollment(partnerUser, 'scheme1', { enrollmentMode: 'SELF' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws NotFound when the scheme is soft-deleted', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({
        id: 'cp1',
        userId: 'partner-user',
        deletedAt: null,
      });

      mockPrisma.scheme.findFirst.mockResolvedValue(
        makeScheme({ deletedAt: new Date() }),
      );

      await expect(
        service.submitEnrollment(partnerUser, 'scheme1', { enrollmentMode: 'SELF' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── K) Scheme outside date window ─────────────────────────────────────────
  describe('K) scheme outside date window', () => {
    it('throws BadRequest when the scheme end date is in the past', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({
        id: 'cp1',
        userId: 'partner-user',
        deletedAt: null,
      });

      mockPrisma.scheme.findFirst.mockResolvedValue(
        makeScheme({
          startDate: new Date('2020-01-01'),
          endDate: new Date('2020-06-01'), // expired
        }),
      );

      await expect(
        service.submitEnrollment(partnerUser, 'scheme1', { enrollmentMode: 'SELF' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequest when the scheme start date is in the future', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({
        id: 'cp1',
        userId: 'partner-user',
        deletedAt: null,
      });

      mockPrisma.scheme.findFirst.mockResolvedValue(
        makeScheme({
          startDate: new Date('2099-01-01'), // not yet started
          endDate: new Date('2099-12-31'),
        }),
      );

      await expect(
        service.submitEnrollment(partnerUser, 'scheme1', { enrollmentMode: 'SELF' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── L) getMyEnrollment — success ─────────────────────────────────────────
  describe('L) getMyEnrollment — success', () => {
    it('returns the caller own enrollment', async () => {
      const fakeEnrollment = { id: 'enr1', schemeId: 'scheme1', userId: 'partner-user', status: 'ACTIVE' };

      // assertSchemeOwnership calls scheme.findFirst.
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 'scheme1', clientId: 'deoleo', deletedAt: null });
      mockPrisma.schemeEnrollment.findUnique.mockResolvedValue(fakeEnrollment);

      const result = await service.getMyEnrollment(partnerUser, 'scheme1');

      expect(result).toEqual({ enrollment: fakeEnrollment });
      expect(mockPrisma.schemeEnrollment.findUnique).toHaveBeenCalledWith({
        where: { schemeId_userId: { schemeId: 'scheme1', userId: 'partner-user' } },
      });
    });
  });

  // ── M) getMyEnrollment — 404 ─────────────────────────────────────────────
  describe('M) getMyEnrollment — not enrolled', () => {
    it('throws NotFoundException when no enrollment exists', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 'scheme1', clientId: 'deoleo', deletedAt: null });
      mockPrisma.schemeEnrollment.findUnique.mockResolvedValue(null);

      await expect(
        service.getMyEnrollment(partnerUser, 'scheme1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws NotFoundException for a scheme in a different tenant', async () => {
      // assertSchemeOwnership returns null → NotFoundException.
      mockPrisma.scheme.findFirst.mockResolvedValue(null);

      await expect(
        service.getMyEnrollment(partnerUser, 'foreign-scheme'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
