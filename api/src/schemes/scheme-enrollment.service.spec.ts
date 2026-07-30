/**
 * scheme-enrollment.service.spec.ts — Scheme Data-Collection (Wave-0/W1)
 *
 * Unit tests (mocked Prisma) for the roster-anchored enrollment engine:
 *   - SELF lazy-create (Mode-A live-rule) happy path + append-only versioning + invariant
 *   - SALES via an existing standalone roster row (tagged-downline reach)
 *   - SALES out-of-reach → Forbidden
 *   - standalone row self-enroll → Forbidden (D19)
 *   - self-enroll disabled (D21) → Forbidden
 *   - frozen roster lazy-create → BadRequest
 *   - PHONE_OTP required: no verified OTP → Forbidden; verified → writes the number
 *   - already-SUBMITTED enroll → BadRequest (immutability, D10)
 *   - reject (admin only) → REJECTED + reason
 *   - resubmit: only a REJECTED enrollment; bumps the version (supersede)
 *   - tenant scope: foreign scheme → NotFound
 *   - admin-list gate
 *
 * Run: npx jest src/schemes/scheme-enrollment.service.spec.ts
 */

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SchemeEnrollmentService } from './scheme-enrollment.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { Msg91Service } from '../notifications/msg91.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const PAST = new Date('2020-01-01');
const FUTURE = new Date('2099-12-31');

const makeScheme = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  clientId: 'deoleo',
  status: 'ACTIVE',
  startDate: PAST,
  endDate: FUTURE,
  deletedAt: null,
  audienceConfig: null,
  enrollmentForm: {
    version: 1,
    campaignType: 'MIXED',
    formSchema: {
      captureGpsOnSubmit: false,
      requireOtp: false,
      fields: [
        { id: 'f1', type: 'TEXT', label: 'Shop', required: true, order: 0 },
      ],
    },
  },
  ...over,
});

const mockPrisma = {
  scheme: { findFirst: jest.fn(), findMany: jest.fn() },
  schemeOutlet: { findFirst: jest.fn(), findMany: jest.fn(), upsert: jest.fn(), count: jest.fn() },
  schemeEnrollment: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  schemeSubmission: { create: jest.fn() },
  schemeEnrollmentForm: { findUnique: jest.fn() },
  schemeEnrollmentFormVersion: { findFirst: jest.fn() },
  channelPartner: { findFirst: jest.fn(), findMany: jest.fn() },
  salesUser: { findFirst: jest.fn(), findMany: jest.fn() },
  salesUserAssignment: { findFirst: jest.fn(), findMany: jest.fn() },
  outlet: { findMany: jest.fn(), findFirst: jest.fn() },
  otpCode: { findFirst: jest.fn(), create: jest.fn(), deleteMany: jest.fn(), update: jest.fn() },
  $transaction: jest.fn(),
};

const mockStorage = { generateKey: jest.fn(), uploadFile: jest.fn(), downloadBytes: jest.fn() };
const mockMsg91 = { sendOtp: jest.fn() };

const partnerUser: JwtPayload = { sub: 'u-partner', role: 'SSS', clientId: 'deoleo', phone: '9990001111', name: '' };
const salesUser: JwtPayload = { sub: 'u-sales', role: 'SALES_SO', clientId: 'deoleo', phone: '', name: '' };
const adminUser: JwtPayload = { sub: 'u-admin', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '', name: '' };

describe('SchemeEnrollmentService', () => {
  let service: SchemeEnrollmentService;

  beforeEach(async () => {
    jest.resetAllMocks();
    // Default: $transaction runs the callback against the same mock (tx === prisma).
    mockPrisma.$transaction.mockImplementation((cb: (tx: typeof mockPrisma) => unknown) => cb(mockPrisma));
    // Dual-source prefill (loadOutletFieldContext) loads matched partners for the approval
    // pre-pin hint; default to none unless a test primes it.
    mockPrisma.channelPartner.findMany.mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SchemeEnrollmentService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StorageService, useValue: mockStorage },
        { provide: Msg91Service, useValue: mockMsg91 },
      ],
    }).compile();
    service = module.get(SchemeEnrollmentService);
  });

  // ── SELF lazy-create happy path ───────────────────────────────────────────
  describe('enroll SELF (lazy-create, no audience)', () => {
    it('creates enrollment v1 + an immutable submission v1 with consistent invariant fields', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(makeScheme());
      // resolveActivePartnerId → own partner
      mockPrisma.channelPartner.findFirst.mockResolvedValueOnce({ id: 'cp1', groupId: null });
      mockPrisma.outlet.findMany.mockResolvedValue([
        { id: 'o1', name: 'Shop', partnerId: 'cp1', outletTypeId: 't', programName: null, programCategory: null, zone: null, state: null },
      ]);
      mockPrisma.schemeOutlet.upsert.mockResolvedValue({ id: 'ro1', schemeId: 's1', clientId: 'deoleo', matchedPartnerId: 'cp1', matchedOutletId: 'o1', outletRef: 'o1', outletName: 'Shop', taggedSalesUserId: null });
      mockPrisma.schemeEnrollment.findUnique.mockResolvedValue(null);
      mockPrisma.schemeEnrollment.create.mockResolvedValue({ id: 'enr1', schemeId: 's1', schemeOutletId: 'ro1', currentVersion: 1 });
      mockPrisma.schemeSubmission.create.mockResolvedValue({ id: 'sub1', version: 1 });

      const res = await service.enroll(partnerUser, 's1', { enrollmentMode: 'SELF', formValues: { f1: 'My Shop' } });

      expect(res.enrollment.id).toBe('enr1');
      const enrData = mockPrisma.schemeEnrollment.create.mock.calls[0][0].data;
      expect(enrData.schemeOutletId).toBe('ro1');
      expect(enrData.currentVersion).toBe(1);
      expect(enrData.formVersion).toBe(1);
      expect(enrData.status).toBe('SUBMITTED');
      // Invariant (§13.3): submission denormalizes schemeId/schemeOutletId/enrollmentId from the enrollment.
      const subData = mockPrisma.schemeSubmission.create.mock.calls[0][0].data;
      expect(subData).toMatchObject({ schemeId: 's1', schemeOutletId: 'ro1', enrollmentId: 'enr1', version: 1, status: 'SUBMITTED' });
    });

    it('rejects a missing required field', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(makeScheme());
      mockPrisma.channelPartner.findFirst.mockResolvedValueOnce({ id: 'cp1', groupId: null });
      mockPrisma.outlet.findMany.mockResolvedValue([{ id: 'o1', name: 'Shop', partnerId: 'cp1', outletTypeId: 't', programName: null, programCategory: null, zone: null, state: null }]);
      mockPrisma.schemeOutlet.upsert.mockResolvedValue({ id: 'ro1', schemeId: 's1', matchedPartnerId: 'cp1', matchedOutletId: 'o1' });
      mockPrisma.schemeEnrollment.findUnique.mockResolvedValue(null);

      await expect(service.enroll(partnerUser, 's1', { enrollmentMode: 'SELF', formValues: {} })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('blocks re-enroll of an already-SUBMITTED outlet (immutability, D10)', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(makeScheme());
      mockPrisma.channelPartner.findFirst.mockResolvedValueOnce({ id: 'cp1', groupId: null });
      mockPrisma.outlet.findMany.mockResolvedValue([{ id: 'o1', name: 'Shop', partnerId: 'cp1', outletTypeId: 't', programName: null, programCategory: null, zone: null, state: null }]);
      mockPrisma.schemeOutlet.upsert.mockResolvedValue({ id: 'ro1', schemeId: 's1', matchedPartnerId: 'cp1', matchedOutletId: 'o1' });
      mockPrisma.schemeEnrollment.findUnique.mockResolvedValue({ id: 'enr1', status: 'SUBMITTED' });

      await expect(service.enroll(partnerUser, 's1', { enrollmentMode: 'SELF', formValues: { f1: 'x' } })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── Tenant scope ──────────────────────────────────────────────────────────
  it('throws NotFound for a scheme outside the caller tenant', async () => {
    mockPrisma.scheme.findFirst.mockResolvedValue(null);
    await expect(service.enroll(partnerUser, 'sX', { enrollmentMode: 'SELF' })).rejects.toBeInstanceOf(NotFoundException);
  });

  // ── Audience: self-enroll disabled + frozen roster ─────────────────────────
  it('forbids self-enroll when the scheme disables it (D21)', async () => {
    mockPrisma.scheme.findFirst.mockResolvedValue(makeScheme({ audienceConfig: { mode: 'FILTER', selfEnrollAllowed: false, frozen: false } }));
    mockPrisma.channelPartner.findFirst.mockResolvedValueOnce({ id: 'cp1', groupId: null });
    mockPrisma.outlet.findMany.mockResolvedValue([{ id: 'o1', name: 'Shop', partnerId: 'cp1', outletTypeId: 't', programName: null, programCategory: null, zone: null, state: null }]);

    await expect(service.enroll(partnerUser, 's1', { enrollmentMode: 'SELF', formValues: { f1: 'x' } })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('requires targetSchemeOutletId for a frozen/Excel roster (no lazy rows)', async () => {
    mockPrisma.scheme.findFirst.mockResolvedValue(makeScheme({ audienceConfig: { mode: 'EXCEL', selfEnrollAllowed: true, frozen: true } }));

    await expect(service.enroll(partnerUser, 's1', { enrollmentMode: 'SELF', formValues: { f1: 'x' } })).rejects.toBeInstanceOf(BadRequestException);
  });

  // ── SALES via existing standalone roster row ───────────────────────────────
  describe('enroll SALES (existing roster row)', () => {
    const standaloneRow = { id: 'ro9', schemeId: 's1', clientId: 'deoleo', outletRef: 'EXT-42', outletName: 'Kirana', matchedOutletId: null, matchedPartnerId: null, taggedSalesUserId: 'su-child' };

    it('succeeds when the tagged employee is in the caller downline', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(makeScheme());
      mockPrisma.schemeOutlet.findFirst.mockResolvedValue(standaloneRow);
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su-caller' }); // requireCallerSalesUser
      mockPrisma.salesUser.findMany.mockResolvedValue([
        { id: 'su-caller', reportingToId: null },
        { id: 'su-child', reportingToId: 'su-caller' },
      ]);
      mockPrisma.schemeEnrollment.findUnique.mockResolvedValue(null);
      mockPrisma.schemeEnrollment.create.mockResolvedValue({ id: 'enr9', schemeId: 's1', schemeOutletId: 'ro9', currentVersion: 1 });
      mockPrisma.schemeSubmission.create.mockResolvedValue({ id: 'sub9' });

      const res = await service.enroll(salesUser, 's1', { enrollmentMode: 'SALES', targetSchemeOutletId: 'ro9', formValues: { f1: 'Kirana' } });
      expect(res.enrollment.id).toBe('enr9');
      expect(mockPrisma.schemeEnrollment.create.mock.calls[0][0].data.enrollmentMode).toBe('SALES');
    });

    it('forbids a caller who cannot reach the row', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(makeScheme());
      mockPrisma.schemeOutlet.findFirst.mockResolvedValue({ ...standaloneRow, taggedSalesUserId: 'su-other' });
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su-caller' });
      mockPrisma.salesUser.findMany.mockResolvedValue([
        { id: 'su-caller', reportingToId: null },
        { id: 'su-other', reportingToId: null },
      ]);

      await expect(service.enroll(salesUser, 's1', { enrollmentMode: 'SALES', targetSchemeOutletId: 'ro9', formValues: { f1: 'x' } })).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('forbids self-enroll of a standalone row (D19)', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(makeScheme());
      mockPrisma.schemeOutlet.findFirst.mockResolvedValue(standaloneRow);

      await expect(service.enroll(partnerUser, 's1', { enrollmentMode: 'SELF', targetSchemeOutletId: 'ro9', formValues: { f1: 'x' } })).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ── PHONE_OTP consent gate (D16) ───────────────────────────────────────────
  describe('PHONE_OTP required', () => {
    const otpScheme = () =>
      makeScheme({
        enrollmentForm: {
          version: 1,
          campaignType: 'MIXED',
          formSchema: {
            captureGpsOnSubmit: false,
            requireOtp: false,
            fields: [
              { id: 'ph', type: 'PHONE_OTP', label: 'Phone', required: true, otpRequired: true, order: 0 },
            ],
          },
        },
      });

    const primeLazySelf = () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(otpScheme());
      mockPrisma.channelPartner.findFirst
        .mockResolvedValueOnce({ id: 'cp1', groupId: null }) // resolveActivePartnerId
        .mockResolvedValueOnce({ phone: null, kycSubmissions: [] }); // resolveOtpTarget → not approved → typed
      mockPrisma.outlet.findMany.mockResolvedValue([{ id: 'o1', name: 'Shop', partnerId: 'cp1', outletTypeId: 't', programName: null, programCategory: null, zone: null, state: null }]);
      mockPrisma.schemeOutlet.upsert.mockResolvedValue({ id: 'ro1', schemeId: 's1', matchedPartnerId: 'cp1', matchedOutletId: 'o1' });
      mockPrisma.schemeEnrollment.findUnique.mockResolvedValue(null);
    };

    it('blocks submit when no verified OTP exists', async () => {
      primeLazySelf();
      mockPrisma.otpCode.findFirst.mockResolvedValue(null); // hasVerifiedOtp → false

      await expect(service.enroll(partnerUser, 's1', { enrollmentMode: 'SELF', formValues: { ph: '9900000041' }, mobile: '9900000041' })).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('accepts submit with a verified OTP and writes the verified number into formValues', async () => {
      primeLazySelf();
      mockPrisma.otpCode.findFirst.mockResolvedValue({ id: 'otp1' }); // hasVerifiedOtp → true
      mockPrisma.schemeEnrollment.create.mockResolvedValue({ id: 'enrO', schemeId: 's1', schemeOutletId: 'ro1', currentVersion: 1 });
      mockPrisma.schemeSubmission.create.mockResolvedValue({ id: 'subO' });

      const res = await service.enroll(partnerUser, 's1', { enrollmentMode: 'SELF', formValues: { ph: '9900000041' }, mobile: '9900000041' });
      expect(res.enrollment.id).toBe('enrO');
      const enrData = mockPrisma.schemeEnrollment.create.mock.calls[0][0].data;
      expect((enrData.formValues as Record<string, unknown>).ph).toBe('9900000041');
    });

    it('overwrites an EDITABLE phone-OTP field with the verified number even when the field value differs (A-MED-1)', async () => {
      primeLazySelf();
      mockPrisma.otpCode.findFirst.mockResolvedValue({ id: 'otp1' }); // hasVerifiedOtp → true
      mockPrisma.schemeEnrollment.create.mockResolvedValue({ id: 'enrO', schemeId: 's1', schemeOutletId: 'ro1', currentVersion: 1 });
      mockPrisma.schemeSubmission.create.mockResolvedValue({ id: 'subO' });

      // The client verified `dto.mobile` (9900000041) but typed a DIFFERENT number into the
      // field (8000000000). The recorded field value MUST equal the OTP-verified number.
      const res = await service.enroll(partnerUser, 's1', { enrollmentMode: 'SELF', formValues: { ph: '8000000000' }, mobile: '9900000041' });
      expect(res.enrollment.id).toBe('enrO');
      const enrData = mockPrisma.schemeEnrollment.create.mock.calls[0][0].data;
      expect((enrData.formValues as Record<string, unknown>).ph).toBe('9900000041');
    });
  });

  // ── Prefilled Excel variables + Editable/Locked (D13 / D13a) ────────────────
  describe('prefill pins (Locked)', () => {
    const lockedTextScheme = () =>
      makeScheme({
        enrollmentForm: {
          version: 1,
          campaignType: 'MIXED',
          formSchema: {
            captureGpsOnSubmit: false,
            requireOtp: false,
            fields: [
              { id: 'f1', type: 'TEXT', label: 'Shop', required: true, order: 0 },
              { id: 'slab', type: 'TEXT', label: 'Slab', required: true, locked: true, prefillKey: 'Slab', order: 1 },
            ],
          },
        },
      });

    const primeSalesStandalone = (row: Record<string, unknown>) => {
      mockPrisma.schemeOutlet.findFirst.mockResolvedValue(row);
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su-caller' }); // requireCallerSalesUser
      mockPrisma.salesUser.findMany.mockResolvedValue([
        { id: 'su-caller', reportingToId: null },
        { id: 'su-child', reportingToId: 'su-caller' },
      ]);
    };

    it('pins a LOCKED prefill field to its roster value in persisted formValues (client value discarded)', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(lockedTextScheme());
      primeSalesStandalone({
        id: 'ro9', schemeId: 's1', clientId: 'deoleo', outletRef: 'EXT-42', outletName: 'Kirana',
        matchedOutletId: null, matchedPartnerId: null, taggedSalesUserId: 'su-child',
        prefillValues: { Slab: 'Gold' },
      });
      mockPrisma.schemeEnrollment.findUnique.mockResolvedValue(null);
      mockPrisma.schemeEnrollment.create.mockResolvedValue({ id: 'enr9', schemeId: 's1', schemeOutletId: 'ro9', currentVersion: 1 });
      mockPrisma.schemeSubmission.create.mockResolvedValue({ id: 'sub9' });

      await service.enroll(salesUser, 's1', {
        enrollmentMode: 'SALES', targetSchemeOutletId: 'ro9',
        formValues: { f1: 'Kirana', slab: 'Bronze (client typed)' },
      });

      const persisted = mockPrisma.schemeEnrollment.create.mock.calls[0][0].data.formValues as Record<string, unknown>;
      expect(persisted.slab).toBe('Gold'); // pinned — the client value is discarded
      expect(persisted.f1).toBe('Kirana');
    });

    it('does NOT pin (and does not block) a locked field when the roster has no value for the key', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(lockedTextScheme());
      primeSalesStandalone({
        id: 'ro9', schemeId: 's1', clientId: 'deoleo', outletRef: 'EXT-42', outletName: 'Kirana',
        matchedOutletId: null, matchedPartnerId: null, taggedSalesUserId: 'su-child',
        prefillValues: { Other: 'x' }, // no "Slab" key
      });
      mockPrisma.schemeEnrollment.findUnique.mockResolvedValue(null);
      mockPrisma.schemeEnrollment.create.mockResolvedValue({ id: 'enr9', schemeId: 's1', schemeOutletId: 'ro9', currentVersion: 1 });
      mockPrisma.schemeSubmission.create.mockResolvedValue({ id: 'sub9' });

      await service.enroll(salesUser, 's1', {
        enrollmentMode: 'SALES', targetSchemeOutletId: 'ro9',
        formValues: { f1: 'Kirana', slab: 'Editable client value' },
      });

      const persisted = mockPrisma.schemeEnrollment.create.mock.calls[0][0].data.formValues as Record<string, unknown>;
      expect(persisted.slab).toBe('Editable client value'); // graceful fall-back — not forced
    });
  });

  // ── Locked PHONE_OTP → roster-number OTP target (D13a + D16) ────────────────
  describe('locked PHONE_OTP → roster number', () => {
    const lockedPhoneScheme = () =>
      makeScheme({
        enrollmentForm: {
          version: 1,
          campaignType: 'MIXED',
          formSchema: {
            captureGpsOnSubmit: false,
            requireOtp: false,
            fields: [
              { id: 'ph', type: 'PHONE_OTP', label: 'Phone', required: true, otpRequired: true, locked: true, prefillKey: 'Owner Phone', order: 0 },
            ],
          },
        },
      });

    const primeSalesStandalone = (row: Record<string, unknown>) => {
      mockPrisma.scheme.findFirst.mockResolvedValue(lockedPhoneScheme());
      mockPrisma.schemeOutlet.findFirst.mockResolvedValue(row);
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su-caller' });
      mockPrisma.salesUser.findMany.mockResolvedValue([
        { id: 'su-caller', reportingToId: null },
        { id: 'su-child', reportingToId: 'su-caller' },
      ]);
    };

    it('send OTP targets the roster number, ignoring the client-typed mobile', async () => {
      primeSalesStandalone({
        id: 'ro9', schemeId: 's1', clientId: 'deoleo', outletRef: 'EXT-42', outletName: 'Kirana',
        matchedOutletId: null, matchedPartnerId: null, taggedSalesUserId: 'su-child',
        prefillValues: { 'Owner Phone': '9812345678' },
      });
      mockPrisma.otpCode.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otpX' });
      mockMsg91.sendOtp.mockResolvedValue(undefined);

      const res = await service.sendEnrollOtp(salesUser, 's1', {
        enrollmentMode: 'SALES', targetSchemeOutletId: 'ro9', mobile: '8000000000',
      });

      expect(res.locked).toBe(true);
      expect(mockPrisma.otpCode.create.mock.calls[0][0].data.phone).toBe('9812345678');
      expect(res.phoneMasked).toBe('******5678');
    });

    it('submit records the roster number (a client-typed field/mobile is ignored)', async () => {
      primeSalesStandalone({
        id: 'ro9', schemeId: 's1', clientId: 'deoleo', outletRef: 'EXT-42', outletName: 'Kirana',
        matchedOutletId: null, matchedPartnerId: null, taggedSalesUserId: 'su-child',
        prefillValues: { 'Owner Phone': '9812345678' },
      });
      mockPrisma.schemeEnrollment.findUnique.mockResolvedValue(null);
      // hasVerifiedOtp checks a verified OTP for (row, '9812345678') — a verified rec exists.
      mockPrisma.otpCode.findFirst.mockResolvedValue({ id: 'otp1' });
      mockPrisma.schemeEnrollment.create.mockResolvedValue({ id: 'enr9', schemeId: 's1', schemeOutletId: 'ro9', currentVersion: 1 });
      mockPrisma.schemeSubmission.create.mockResolvedValue({ id: 'sub9' });

      await service.enroll(salesUser, 's1', {
        enrollmentMode: 'SALES', targetSchemeOutletId: 'ro9',
        formValues: { ph: '8000000000' }, mobile: '8000000000',
      });

      const persisted = mockPrisma.schemeEnrollment.create.mock.calls[0][0].data.formValues as Record<string, unknown>;
      expect(persisted.ph).toBe('9812345678'); // server-authoritative roster number
    });

    it('falls back to the typed number when the field is EDITABLE (locked !== true)', async () => {
      const editableScheme = makeScheme({
        enrollmentForm: {
          version: 1, campaignType: 'MIXED',
          formSchema: {
            captureGpsOnSubmit: false, requireOtp: false,
            fields: [
              { id: 'ph', type: 'PHONE_OTP', label: 'Phone', required: true, otpRequired: true, order: 0 },
            ],
          },
        },
      });
      mockPrisma.scheme.findFirst.mockResolvedValue(editableScheme);
      mockPrisma.schemeOutlet.findFirst.mockResolvedValue({
        id: 'ro9', schemeId: 's1', clientId: 'deoleo', outletRef: 'EXT-42', outletName: 'Kirana',
        matchedOutletId: null, matchedPartnerId: null, taggedSalesUserId: 'su-child',
        prefillValues: { 'Owner Phone': '9812345678' },
      });
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su-caller' });
      mockPrisma.salesUser.findMany.mockResolvedValue([
        { id: 'su-caller', reportingToId: null },
        { id: 'su-child', reportingToId: 'su-caller' },
      ]);
      mockPrisma.otpCode.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otpX' });
      mockMsg91.sendOtp.mockResolvedValue(undefined);

      const res = await service.sendEnrollOtp(salesUser, 's1', {
        enrollmentMode: 'SALES', targetSchemeOutletId: 'ro9', mobile: '8000000000',
      });

      expect(res.locked).toBe(false);
      expect(mockPrisma.otpCode.create.mock.calls[0][0].data.phone).toBe('8000000000'); // typed number
    });
  });

  // ── A-LOW-6: unknown keys are projected out before persist ──────────────────
  it('drops client-sent keys that are not in the form schema (A-LOW-6)', async () => {
    mockPrisma.scheme.findFirst.mockResolvedValue(makeScheme());
    mockPrisma.channelPartner.findFirst.mockResolvedValueOnce({ id: 'cp1', groupId: null });
    mockPrisma.outlet.findMany.mockResolvedValue([
      { id: 'o1', name: 'Shop', partnerId: 'cp1', outletTypeId: 't', programName: null, programCategory: null, zone: null, state: null },
    ]);
    mockPrisma.schemeOutlet.upsert.mockResolvedValue({ id: 'ro1', schemeId: 's1', clientId: 'deoleo', matchedPartnerId: 'cp1', matchedOutletId: 'o1', outletRef: 'o1', outletName: 'Shop', taggedSalesUserId: null });
    mockPrisma.schemeEnrollment.findUnique.mockResolvedValue(null);
    mockPrisma.schemeEnrollment.create.mockResolvedValue({ id: 'enr1', schemeId: 's1', schemeOutletId: 'ro1', currentVersion: 1 });
    mockPrisma.schemeSubmission.create.mockResolvedValue({ id: 'sub1', version: 1 });

    await service.enroll(partnerUser, 's1', { enrollmentMode: 'SELF', formValues: { f1: 'My Shop', evil: 'x', __proto__hack: 1 } });

    const enrData = mockPrisma.schemeEnrollment.create.mock.calls[0][0].data;
    const persisted = enrData.formValues as Record<string, unknown>;
    expect(persisted).toEqual({ f1: 'My Shop' }); // only the schema field id survives
  });

  // ── B-MED-2: a field hidden by visibleWhen is not persisted ─────────────────
  it('drops a field hidden by visibleWhen from persisted formValues (B-MED-2)', async () => {
    const hiddenFieldScheme = makeScheme({
      enrollmentForm: {
        version: 1,
        campaignType: 'MIXED',
        formSchema: {
          captureGpsOnSubmit: false,
          requireOtp: false,
          fields: [
            { id: 'f1', type: 'TEXT', label: 'Mode', required: true, order: 0 },
            { id: 'f2', type: 'TEXT', label: 'Detail', required: false, order: 1, visibleWhen: { fieldId: 'f1', op: 'eq', value: 'SHOW' } },
          ],
        },
      },
    });
    mockPrisma.scheme.findFirst.mockResolvedValue(hiddenFieldScheme);
    mockPrisma.channelPartner.findFirst.mockResolvedValueOnce({ id: 'cp1', groupId: null });
    mockPrisma.outlet.findMany.mockResolvedValue([
      { id: 'o1', name: 'Shop', partnerId: 'cp1', outletTypeId: 't', programName: null, programCategory: null, zone: null, state: null },
    ]);
    mockPrisma.schemeOutlet.upsert.mockResolvedValue({ id: 'ro1', schemeId: 's1', clientId: 'deoleo', matchedPartnerId: 'cp1', matchedOutletId: 'o1', outletRef: 'o1', outletName: 'Shop', taggedSalesUserId: null });
    mockPrisma.schemeEnrollment.findUnique.mockResolvedValue(null);
    mockPrisma.schemeEnrollment.create.mockResolvedValue({ id: 'enr1', schemeId: 's1', schemeOutletId: 'ro1', currentVersion: 1 });
    mockPrisma.schemeSubmission.create.mockResolvedValue({ id: 'sub1', version: 1 });

    // f1='HIDE' → f2's visibleWhen (f1 eq 'SHOW') is false → its stale value must NOT persist.
    await service.enroll(partnerUser, 's1', { enrollmentMode: 'SELF', formValues: { f1: 'HIDE', f2: 'stale value' } });

    const persisted = mockPrisma.schemeEnrollment.create.mock.calls[0][0].data.formValues as Record<string, unknown>;
    expect(persisted).toEqual({ f1: 'HIDE' });
    expect(persisted).not.toHaveProperty('f2');
  });

  // ── A-LOW-4: a unique-violation surfaces as a clean 409, not a 500 ──────────
  it('maps a Prisma P2002 unique-violation to a ConflictException (A-LOW-4)', async () => {
    mockPrisma.scheme.findFirst.mockResolvedValue(makeScheme());
    mockPrisma.channelPartner.findFirst.mockResolvedValueOnce({ id: 'cp1', groupId: null });
    mockPrisma.outlet.findMany.mockResolvedValue([
      { id: 'o1', name: 'Shop', partnerId: 'cp1', outletTypeId: 't', programName: null, programCategory: null, zone: null, state: null },
    ]);
    mockPrisma.schemeOutlet.upsert.mockResolvedValue({ id: 'ro1', schemeId: 's1', matchedPartnerId: 'cp1', matchedOutletId: 'o1' });
    mockPrisma.schemeEnrollment.findUnique.mockResolvedValue(null);
    // A concurrent enroll won the 1:1 schemeOutletId race → the transaction throws P2002.
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    });
    mockPrisma.$transaction.mockRejectedValueOnce(p2002);

    await expect(
      service.enroll(partnerUser, 's1', { enrollmentMode: 'SELF', formValues: { f1: 'x' } }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  // ── Reject (admin only) ────────────────────────────────────────────────────
  describe('reject', () => {
    it('sets status REJECTED + reason for an admin', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(makeScheme());
      mockPrisma.schemeEnrollment.findFirst.mockResolvedValue({ id: 'enr1', schemeId: 's1' });
      mockPrisma.schemeEnrollment.update.mockResolvedValue({ id: 'enr1', status: 'REJECTED', rejectionReason: 'blurry photo' });

      const res = await service.reject(adminUser, 's1', 'enr1', { reason: 'blurry photo' });
      expect(res.enrollment.status).toBe('REJECTED');
      expect(mockPrisma.schemeEnrollment.update.mock.calls[0][0].data).toMatchObject({ status: 'REJECTED', rejectionReason: 'blurry photo' });
    });

    it('forbids a non-admin', async () => {
      await expect(service.reject(partnerUser, 's1', 'enr1', { reason: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ── Resubmit (post-rejection versioning) ───────────────────────────────────
  describe('resubmit', () => {
    it('bumps the version and supersedes when the enrollment was REJECTED', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(makeScheme());
      mockPrisma.schemeEnrollment.findFirst.mockResolvedValue({
        id: 'enr1', schemeId: 's1', status: 'REJECTED', enrollmentMode: 'SELF',
        schemeOutlet: { id: 'ro1', schemeId: 's1', matchedPartnerId: 'cp1' },
      });
      mockPrisma.channelPartner.findFirst.mockResolvedValueOnce({ id: 'cp1', groupId: null }); // authorizeRoster SELF
      // inside the tx: read prev, then update
      mockPrisma.schemeEnrollment.findUnique.mockResolvedValue({ id: 'enr1', currentVersion: 1, schemeId: 's1', schemeOutletId: 'ro1' });
      mockPrisma.schemeEnrollment.update.mockResolvedValue({ id: 'enr1', schemeId: 's1', schemeOutletId: 'ro1', currentVersion: 2 });
      mockPrisma.schemeSubmission.create.mockResolvedValue({ id: 'sub2', version: 2 });

      const res = await service.resubmit(partnerUser, 's1', 'enr1', { formValues: { f1: 'Fixed' } });
      expect(res.enrollment.currentVersion).toBe(2);
      expect(mockPrisma.schemeEnrollment.update.mock.calls[0][0].data.currentVersion).toBe(2);
      expect(mockPrisma.schemeSubmission.create.mock.calls[0][0].data.version).toBe(2);
    });

    it('rejects resubmit of a non-rejected enrollment', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(makeScheme());
      mockPrisma.schemeEnrollment.findFirst.mockResolvedValue({ id: 'enr1', schemeId: 's1', status: 'SUBMITTED', enrollmentMode: 'SELF', schemeOutlet: { id: 'ro1', schemeId: 's1', matchedPartnerId: 'cp1' } });

      await expect(service.resubmit(partnerUser, 's1', 'enr1', { formValues: { f1: 'x' } })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('ALLOWS a SELF enroller to edit a SUBMITTED enrollment when allowEnrollerEdit is on (bumps version)', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(
        makeScheme({ audienceConfig: { mode: 'FILTER', selfEnrollAllowed: true, frozen: false, allowEnrollerEdit: true } }),
      );
      mockPrisma.schemeEnrollment.findFirst.mockResolvedValue({
        id: 'enr1', schemeId: 's1', status: 'SUBMITTED', enrollmentMode: 'SELF', currentVersion: 1,
        formValues: { f1: 'Old' }, schemeOutlet: { id: 'ro1', schemeId: 's1', matchedPartnerId: 'cp1' },
      });
      mockPrisma.channelPartner.findFirst.mockResolvedValueOnce({ id: 'cp1', groupId: null }); // authorizeRoster SELF
      mockPrisma.schemeEnrollment.findUnique.mockResolvedValue({ id: 'enr1', currentVersion: 1, schemeId: 's1', schemeOutletId: 'ro1' });
      mockPrisma.schemeEnrollment.update.mockResolvedValue({ id: 'enr1', schemeId: 's1', schemeOutletId: 'ro1', currentVersion: 2 });
      mockPrisma.schemeSubmission.create.mockResolvedValue({ id: 'sub2', version: 2 });

      const res = await service.resubmit(partnerUser, 's1', 'enr1', { formValues: { f1: 'Corrected' } });
      expect(res.enrollment.currentVersion).toBe(2);
    });

    it('BLOCKS an enroller edit of a SUBMITTED enrollment in SALES mode even when allowEnrollerEdit is on (MED-1)', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(
        makeScheme({ audienceConfig: { mode: 'FILTER', selfEnrollAllowed: true, frozen: false, allowEnrollerEdit: true } }),
      );
      mockPrisma.schemeEnrollment.findFirst.mockResolvedValue({
        id: 'enr1', schemeId: 's1', status: 'SUBMITTED', enrollmentMode: 'SALES', currentVersion: 1,
        formValues: { f1: 'Old' }, schemeOutlet: { id: 'ro1', schemeId: 's1', matchedPartnerId: 'cp1' },
      });

      await expect(service.resubmit(salesUser, 's1', 'enr1', { formValues: { f1: 'x' } })).rejects.toBeInstanceOf(BadRequestException);
      // The SELF-mode gate fires BEFORE authorizeRoster — no roster re-auth query is reached.
      expect(mockPrisma.schemeEnrollment.update).not.toHaveBeenCalled();
    });
  });

  // ── Admin edit: consent carry-forward on a PHONE_OTP scheme (HIGH-1) ─────────
  describe('adminEditEnrollment consent carry-forward', () => {
    const otpEditScheme = () =>
      makeScheme({
        enrollmentForm: {
          version: 1, campaignType: 'MIXED',
          formSchema: {
            captureGpsOnSubmit: false, requireOtp: false,
            fields: [{ id: 'ph', type: 'PHONE_OTP', label: 'Phone', required: true, otpRequired: true, order: 0 }],
          },
        },
      });

    it('reuses the ORIGINALLY-verified phone (no fresh OTP) and ignores a client-substituted number', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(otpEditScheme());
      mockPrisma.schemeEnrollment.findFirst.mockResolvedValue({
        id: 'enr1', schemeId: 's1', status: 'SUBMITTED', enrollmentMode: 'SELF', currentVersion: 1,
        formValues: { ph: '9812300099' }, // the phone OTP-verified at original capture
        schemeOutlet: { id: 'ro1', schemeId: 's1', matchedPartnerId: 'cp1', matchedOutletId: 'o1' },
      });
      mockPrisma.otpCode.findFirst.mockResolvedValue(null); // NO fresh OTP on file
      mockPrisma.schemeEnrollment.findUnique.mockResolvedValue({ id: 'enr1', currentVersion: 1, schemeId: 's1', schemeOutletId: 'ro1' });
      mockPrisma.schemeEnrollment.update.mockResolvedValue({ id: 'enr1', schemeId: 's1', schemeOutletId: 'ro1', currentVersion: 2 });
      mockPrisma.schemeSubmission.create.mockResolvedValue({ id: 'sub2', version: 2 });

      // Admin edits with a DIFFERENT number typed into the field — it must be discarded.
      const res = await service.adminEditEnrollment(adminUser, 's1', 'enr1', { formValues: { ph: '8000000000' } });
      expect(res.enrollment.currentVersion).toBe(2);
      const updData = mockPrisma.schemeEnrollment.update.mock.calls[0][0].data;
      expect((updData.formValues as Record<string, unknown>).ph).toBe('9812300099'); // carried, not 8000000000
      // Carry-forward must NOT consult a fresh OTP — the edit succeeds without one.
      expect(mockPrisma.otpCode.findFirst).not.toHaveBeenCalled();
    });
  });

  // ── Admin list gate ────────────────────────────────────────────────────────
  it('forbids a non-admin from the admin enrollments list', async () => {
    await expect(service.adminListEnrollments(partnerUser, 's1', {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ── getEligibleSchemes: mySchemeOutletId (frozen roster vs live-rule) ───────
  describe('getEligibleSchemes → mySchemeOutletId', () => {
    it('returns the matched roster-row id for a frozen/EXCEL scheme, null for a live-rule scheme', async () => {
      mockPrisma.scheme.findMany.mockResolvedValue([
        makeScheme({ id: 'sFrozen', audienceConfig: { mode: 'EXCEL', selfEnrollAllowed: true, frozen: true } }),
        makeScheme({ id: 'sLive', audienceConfig: { mode: 'FILTER', selfEnrollAllowed: true, frozen: false } }),
      ]);
      mockPrisma.channelPartner.findFirst.mockResolvedValueOnce({ id: 'cp1', groupId: null }); // resolveActivePartnerId
      mockPrisma.outlet.findMany.mockResolvedValue([
        { id: 'o1', outletTypeId: 't', programName: null, programCategory: null, zone: null, state: null },
      ]);
      // Frozen scheme → a materialized roster row exists for this partner.
      mockPrisma.schemeOutlet.findFirst.mockResolvedValueOnce({ id: 'roFROZEN' });

      const res = await service.getEligibleSchemes(partnerUser);
      const byId = Object.fromEntries(res.schemes.map((s) => [s.id, s]));
      expect(byId['sFrozen'].mySchemeOutletId).toBe('roFROZEN');
      expect(byId['sLive'].mySchemeOutletId).toBeNull(); // live-rule → server lazy-creates on enroll
    });
  });

  // ── getSalesEligibleSchemes ────────────────────────────────────────────────
  describe('getSalesEligibleSchemes', () => {
    it('returns active in-window schemes for a rep', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su-caller' }); // requireCallerSalesUser
      mockPrisma.scheme.findMany.mockResolvedValue([
        { id: 's1', clientId: 'deoleo', status: 'ACTIVE', enrollmentForm: { campaignType: 'MIXED', version: 2 } },
      ]);

      const res = await service.getSalesEligibleSchemes(salesUser);
      expect(res.schemes).toHaveLength(1);
      expect(res.schemes[0].enrollmentForm).toEqual({ campaignType: 'MIXED', version: 2 });
      // Scoped to the caller tenant, ACTIVE, and the enroll window [startDate,endDate].
      const where = mockPrisma.scheme.findMany.mock.calls[0][0].where;
      expect(where.clientId).toBe('deoleo');
      expect(where.status).toBe('ACTIVE');
      expect(where.deletedAt).toBeNull();
      expect(where.startDate.lte).toBeInstanceOf(Date);
      expect(where.endDate.gte).toBeInstanceOf(Date);
    });

    it('forbids a caller that is not a sales user', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue(null);
      await expect(service.getSalesEligibleSchemes(salesUser)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ── getSalesTargets ────────────────────────────────────────────────────────
  describe('getSalesTargets', () => {
    const primeReach = () => {
      // caller → su-caller; downline includes su-child. su-other is out of reach.
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su-caller' });
      mockPrisma.salesUser.findMany.mockResolvedValue([
        { id: 'su-caller', reportingToId: null },
        { id: 'su-child', reportingToId: 'su-caller' },
        { id: 'su-other', reportingToId: null },
      ]);
    };

    it('returns tagged-downline + standalone + assignment-reach roster rows and a live-rule outlet, each with status; excludes out-of-reach rows', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(
        makeScheme({ audienceConfig: { mode: 'FILTER', selfEnrollAllowed: true, frozen: false } }),
      );
      primeReach();
      // Reach assignments → outlet o-assigned + partner cp-assigned + subtree outlet o-live.
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([
        { outletId: 'o-assigned', partnerId: 'cp-assigned' },
        { outletId: 'o-live', partnerId: null },
      ]);
      // Roster rows (already scoped by reach in the query): a standalone tagged row (NOT_ENROLLED),
      // a matched-by-assignment row (SUBMITTED), a matched-partner row (REJECTED).
      mockPrisma.schemeOutlet.findMany.mockResolvedValue([
        { id: 'ro-standalone', outletRef: 'EXT-1', outletName: 'Kirana', matchedOutletId: null, matchedPartnerId: null, taggedSalesUserId: 'su-child', enrollment: null },
        { id: 'ro-assigned', outletRef: 'o-assigned', outletName: 'Assigned Shop', matchedOutletId: 'o-assigned', matchedPartnerId: null, taggedSalesUserId: null, enrollment: { id: 'enrA', status: 'SUBMITTED', rejectionReason: null, currentVersion: 1 } },
        { id: 'ro-partner', outletRef: 'o-cp', outletName: 'Partner Shop', matchedOutletId: 'o-cp', matchedPartnerId: 'cp-assigned', taggedSalesUserId: null, enrollment: { id: 'enrP', status: 'REJECTED', rejectionReason: 'blurry', currentVersion: 2 } },
      ]);
      // Live-rule candidate outlets (o-live not yet rostered → matches filter).
      mockPrisma.outlet.findMany.mockResolvedValue([
        { id: 'o-live', name: 'Live Outlet', outletTypeId: 't', programName: null, programCategory: null, zone: null, state: null },
      ]);

      const res = await service.getSalesTargets(salesUser, 's1', {});
      const byRef = Object.fromEntries(res.targets.map((t) => [t.outletName, t]));

      // Standalone tagged-downline row (D19): standalone=true, matched=false, NOT_ENROLLED.
      expect(byRef['Kirana']).toMatchObject({ schemeOutletId: 'ro-standalone', targetOutletRef: null, standalone: true, matched: false, status: 'NOT_ENROLLED', enrollmentId: null, currentVersion: null });
      // Assignment-reach matched row: SUBMITTED.
      expect(byRef['Assigned Shop']).toMatchObject({ schemeOutletId: 'ro-assigned', matched: true, standalone: false, status: 'SUBMITTED', enrollmentId: 'enrA', currentVersion: 1 });
      // Matched-partner row: REJECTED with a reason.
      expect(byRef['Partner Shop']).toMatchObject({ schemeOutletId: 'ro-partner', status: 'REJECTED', rejectionReason: 'blurry', currentVersion: 2 });
      // Live-rule subtree outlet: schemeOutletId null, targetOutletRef set, NOT_ENROLLED.
      expect(byRef['Live Outlet']).toMatchObject({ schemeOutletId: null, targetOutletRef: 'o-live', matched: true, status: 'NOT_ENROLLED' });

      expect(res.targets).toHaveLength(4);
      expect(res.pagination.total).toBe(4);

      // The roster query is scoped BY reach (never the whole roster): OR includes the reach ids.
      const rosterWhere = mockPrisma.schemeOutlet.findMany.mock.calls[0][0].where;
      expect(rosterWhere.schemeId).toBe('s1');
      expect(rosterWhere.OR[0]).toEqual({ taggedSalesUserId: { in: ['su-caller', 'su-child'] } });
    });

    it('surfaces a partner-only-assigned partner\'s filter-matching outlets as live-rule targets (A-MED-1)', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(
        makeScheme({ audienceConfig: { mode: 'FILTER', selfEnrollAllowed: true, frozen: false } }),
      );
      primeReach();
      // A PARTNER-ONLY assignment: partnerId set, outletId null → reachOutletIds stays empty,
      // so the partner's outlets only enter the live-rule set via the reachPartnerIds branch.
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([
        { outletId: null, partnerId: 'cp-x' },
      ]);
      // No roster rows materialized for this scheme yet.
      mockPrisma.schemeOutlet.findMany.mockResolvedValue([]);
      // The partner's outlets, loaded via the partnerId branch of the candidate query.
      mockPrisma.outlet.findMany.mockResolvedValue([
        { id: 'o-p1', name: 'Partner Outlet 1', outletTypeId: 't', programName: null, programCategory: null, zone: null, state: null },
      ]);

      const res = await service.getSalesTargets(salesUser, 's1', {});
      const byName = Object.fromEntries(res.targets.map((t) => [t.outletName, t]));
      expect(byName['Partner Outlet 1']).toMatchObject({
        schemeOutletId: null, targetOutletRef: 'o-p1', matched: true, status: 'NOT_ENROLLED',
      });
      expect(res.targets).toHaveLength(1);
      // The candidate-outlet lookup includes the partner-only branch (A-MED-1).
      const outletWhere = mockPrisma.outlet.findMany.mock.calls[0][0].where;
      expect(outletWhere.OR).toContainEqual({ partnerId: { in: ['cp-x'] } });
    });

    it('applies the status filter', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(
        makeScheme({ audienceConfig: { mode: 'EXCEL', selfEnrollAllowed: false, frozen: true } }),
      );
      primeReach();
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([]);
      mockPrisma.schemeOutlet.findMany.mockResolvedValue([
        { id: 'ro1', outletRef: 'EXT-1', outletName: 'A', matchedOutletId: null, matchedPartnerId: null, taggedSalesUserId: 'su-child', enrollment: { id: 'e1', status: 'SUBMITTED', rejectionReason: null, currentVersion: 1 } },
        { id: 'ro2', outletRef: 'EXT-2', outletName: 'B', matchedOutletId: null, matchedPartnerId: null, taggedSalesUserId: 'su-child', enrollment: null },
      ]);

      const res = await service.getSalesTargets(salesUser, 's1', { status: 'NOT_ENROLLED' });
      expect(res.targets).toHaveLength(1);
      expect(res.targets[0].outletName).toBe('B');
      // Frozen roster → no live-rule outlet lookup.
      expect(mockPrisma.outlet.findMany).not.toHaveBeenCalled();
    });

    it('forbids a caller that is not a sales user', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue(null);
      await expect(service.getSalesTargets(salesUser, 's1', {})).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws NotFound for a scheme outside the caller tenant', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su-caller' });
      mockPrisma.scheme.findFirst.mockResolvedValue(null);
      await expect(service.getSalesTargets(salesUser, 'sX', {})).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── Cross-tenant read boundary: assumed-vs-unassumed GIFSY (tenant-scope helper) ──
  describe('schemeTenant (cross-tenant scope)', () => {
    // schemeTenant is private; the where-fragment it returns is the whole scoping contract.
    const schemeTenant = (u: JwtPayload): { clientId?: string } =>
      (service as unknown as { schemeTenant(user: JwtPayload): { clientId?: string } }).schemeTenant(u);

    const assumedGifsy: JwtPayload = { sub: 'u-admin', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '', name: '', assumed: true };

    it('un-assumed GIFSY → all tenants ({})', () => {
      expect(schemeTenant(adminUser)).toEqual({});
    });

    it('ASSUMED GIFSY → pinned to the assumed clientId', () => {
      expect(schemeTenant(assumedGifsy)).toEqual({ clientId: 'deoleo' });
    });

    it('CLIENT_ADMIN / tenant user → pinned to own clientId', () => {
      expect(schemeTenant(partnerUser)).toEqual({ clientId: 'deoleo' });
    });
  });

  describe('viewMedia (tenant-from-key) — assumed operator is pinned', () => {
    const assumedGifsy: JwtPayload = { sub: 'u-admin', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '', name: '', assumed: true };

    it('404s a cross-tenant key for an ASSUMED operator (no downloadBytes)', async () => {
      await expect(
        service.viewMedia(assumedGifsy, 'scheme-media/other-tenant/2026-07/a.jpg'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockStorage.downloadBytes).not.toHaveBeenCalled();
    });

    it('serves the assumed tenant’s own media to an ASSUMED operator', async () => {
      mockStorage.downloadBytes.mockResolvedValue({ bytes: Buffer.from([0xff, 0xd8, 0xff]), contentType: 'image/jpeg' });
      const out = await service.viewMedia(assumedGifsy, 'scheme-media/deoleo/2026-07/a.jpg');
      expect(out.contentType).toBe('image/jpeg');
    });

    it('lets an un-assumed GIFSY read any tenant key (cross-tenant operator)', async () => {
      mockStorage.downloadBytes.mockResolvedValue({ bytes: Buffer.from([0xff, 0xd8, 0xff]), contentType: 'image/jpeg' });
      const out = await service.viewMedia(adminUser, 'scheme-media/other-tenant/2026-07/a.jpg');
      expect(out.contentType).toBe('image/jpeg');
    });
  });
});
