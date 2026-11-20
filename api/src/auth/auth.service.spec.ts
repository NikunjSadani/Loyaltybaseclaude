// TDD: AuthService
// Tests written BEFORE implementation â€” each describes expected behaviour.
// Run: npx jest src/auth/auth.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException, BadRequestException, UnauthorizedException, ServiceUnavailableException, Logger } from '@nestjs/common';
import { AuthService } from './auth.service';
import { SESSION_TTL_DAYS } from './auth.constants';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Msg91Service } from '../notifications/msg91.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { TenantService } from '../tenant/tenant.service';
import { GifsyTenantGrantService } from '../common/rbac/gifsy-tenant-grant.service';
import { GifsyRoleService } from '../common/rbac/gifsy-role.service';

// getMe surfaces the tenant visibility-capture mode; default PHOTO_APPROVAL for tests.
const mockTenant = { resolveVisibilityCaptureMode: jest.fn(async () => 'PHOTO_APPROVAL') };

// â”€â”€â”€ Mocks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const mockPrisma = {
  // findUnique added for refreshToken's post-mint sessionsInvalidBefore re-read (1b);
  // defaults to undefined so the guard is a no-op unless a test opts in.
  user:    { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
  otpCode: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn(), count: jest.fn() },
  userSession: {
    create: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn(),
    // findUnique: refreshToken's lost-claim re-read of the predecessor's REAL revokedAt.
    // findMany: exitTenant's lineage walk (children of each hop).
    findUnique: jest.fn(), findMany: jest.fn(),
  },
  client:  { findFirst: jest.fn() },
  auditLog: { create: jest.fn(), count: jest.fn() },
  // Deactivated-outlet login gate: default to "no partner" so non-partner logins
  // skip the gate; the partner-login tests below override these.
  channelPartner: { findFirst: jest.fn() },
  outlet: { count: jest.fn() },
  // TenantSettingsService reads this (no rows -> typed defaults, conversionRate = env).
  programSetting: { findMany: jest.fn().mockResolvedValue([]) },
  // The OTP attempt claim (common/otp-attempt) is ONE `UPDATE … RETURNING "attempts"` via $queryRaw.
  $queryRaw: jest.fn(),
  $transaction: jest.fn(),
};
// refreshToken runs its claim + successor mint in ONE interactive transaction; the unit
// mock runs the callback against this same mock (the race semantics live in
// auth.service.refresh-race.spec.ts, against a row-lock fake DB). Inside the tx the user row
// is read FOR SHARE via $queryRaw — default: the user exists with no logout-all stamp.
const txUserStamp = jest.fn();
const txExecRaw = jest.fn(); // SET LOCAL lock_timeout (F1)
mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
  fn({ ...mockPrisma, $queryRaw: txUserStamp, $executeRawUnsafe: txExecRaw }),
);

const gifsyOp = { sub: 'op1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '98', name: 'Op' } as any;

const mockJwt = {
  sign:   jest.fn().mockReturnValue('mock.jwt.token'),
  verify: jest.fn(),
};

const mockConfig = {
  get: jest.fn((key: string) => {
    const cfg: Record<string, string> = {
      JWT_SECRET:              'test-secret',
      // Deployment now sets the access-token TTL to 60m (decoupled from the 30d session).
      JWT_EXPIRES_IN:          '60m',
      MSG91_AUTH_KEY:          'test-msg91-key',
      MSG91_SENDER_ID:         'GIFSY',
      MSG91_OTP_TEMPLATE_ID:   'test-template',
    };
    return cfg[key];
  }),
};

// â”€â”€â”€ Suite â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// P5 tenant-grant resolver stub. hasGrantUncached is the AUTHORITATIVE assume/refresh gate;
// default false (no grant) — staff-assume tests override it per case.
const mockGrants = {
  grantedTenantIds: jest.fn().mockResolvedValue(new Set<string>()),
  mayOperateOnTenant: jest.fn().mockResolvedValue(false),
  hasGrantUncached: jest.fn().mockResolvedValue(false),
  invalidate: jest.fn(),
  clearCache: jest.fn(),
};
// P6 role→permissions resolver stub (feeds getMe's `permissions[]`).
const mockRoleSvc = {
  getPermissions: jest.fn().mockResolvedValue(new Set<string>()),
  clearCache: jest.fn(),
};

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService,  useValue: mockPrisma },
        { provide: JwtService,     useValue: mockJwt    },
        { provide: ConfigService,  useValue: mockConfig },
        // Real Msg91Service (A-2a): thin wrapper over the mocked ConfigService + global.fetch,
        // so the existing MSG91/fetch behaviour tests run unchanged through the delegate.
        Msg91Service,
        // Real TenantSettingsService over the mocked Prisma (no rows -> typed defaults,
        // so getMe's conversionRate still reflects POINTS_CONVERSION_RATE env in these tests).
        TenantSettingsService,
        { provide: TenantService, useValue: mockTenant },
        // P5 tenant-grant resolver — stub (existing tests use GIFSY_ADMIN, which skips grant checks).
        {
          provide: GifsyTenantGrantService,
          useValue: mockGrants,
        },
        {
          provide: GifsyRoleService,
          useValue: mockRoleSvc,
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    jest.clearAllMocks();
    txUserStamp.mockResolvedValue([{ sessionsInvalidBefore: null }]);
    mockPrisma.userSession.findMany.mockResolvedValue([]);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // â”€â”€ getMe â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('getMe', () => {
    const partnerUser = { sub: 'u1', role: 'CHANNEL_PARTNER', clientId: 'deoleo', phone: '99', name: 'P' } as any;

    beforeEach(() => {
      // getMe queries channelPartner/salesUser/wallet — extend the mock for this block.
      (mockPrisma as any).channelPartner = { findUnique: jest.fn() };
      (mockPrisma as any).salesUser = { findUnique: jest.fn() };
      (mockPrisma as any).wallet = { findUnique: jest.fn() };
    });

    it('returns the partner beneficiary fields + the authoritative conversionRate', async () => {
      process.env.POINTS_CONVERSION_RATE = '2';
      (mockPrisma.user.findFirst as any); // unused here
      (mockPrisma as any).user.findUnique = jest.fn().mockResolvedValue({ name: 'P', phone: '99' });
      (mockPrisma as any).channelPartner.findUnique.mockResolvedValue({
        id: 'cp1', partnerCode: 'PC1', businessName: 'Biz', ownerName: 'Owner',
        phone: '99', email: 'e@e.com', gstNumber: null, panNumber: null, entityType: 'PROPRIETORSHIP',
        bankName: 'HDFC', bankAccountNumber: '123456', bankAccountHolder: 'Owner',
        ifscCode: 'HDFC0001', upiId: 'owner@upi', paymentMode: 'UPI',
      });
      (mockPrisma as any).salesUser.findUnique.mockResolvedValue(null);
      (mockPrisma as any).wallet.findUnique.mockResolvedValue({
        earnedPoints: 100, redeemablePoints: 80, lockedPoints: 0, lifetimeEarned: 100,
      });

      const result = await service.getMe(partnerUser);

      // The select passed to channelPartner.findUnique must include the beneficiary fields.
      const selectArg = (mockPrisma as any).channelPartner.findUnique.mock.calls[0][0].select;
      expect(selectArg).toMatchObject({
        bankName: true, bankAccountNumber: true, bankAccountHolder: true,
        ifscCode: true, upiId: true, paymentMode: true,
      });

      const cp = result.user.channelPartner as any;
      expect(cp.bankName).toBe('HDFC');
      expect(cp.bankAccountNumber).toBe('123456');
      expect(cp.bankAccountHolder).toBe('Owner');
      expect(cp.ifscCode).toBe('HDFC0001');
      expect(cp.upiId).toBe('owner@upi');
      expect(cp.paymentMode).toBe('UPI');

      // Authoritative server-side conversion rate from env.
      expect((result as any).conversionRate).toBe(2);
    });

    // R3 (G3): the sales profile's "reporting manager" = the NEXT ACTIVE manager (routing's rule), never a deleted one.
    describe('R3 — sales profile reporting manager', () => {
      const salesCaller = { sub: 'u-isr', role: 'SALES_ISR', clientId: 'bajaj', phone: '9', name: 'I' } as any;
      const stub = (reportingTo: unknown) => {
        (mockPrisma as any).user.findUnique = jest.fn().mockResolvedValue({ name: 'I', phone: '9' });
        (mockPrisma as any).channelPartner.findUnique.mockResolvedValue(null);
        (mockPrisma as any).salesUser.findUnique.mockResolvedValue({
          id: 'isr', employeeCode: 'E1', region: null, zone: null, clientId: 'bajaj', reportingTo,
        });
        (mockPrisma as any).salesUser.findMany = jest.fn();
        // F5: the vacant-manager walk goes UP by id lookups (bounded), never a full-tenant load.
        const NODES: Record<string, unknown> = {
          so: { id: 'so', employeeCode: 'E-SO', reportingToId: 'asm', isActive: true, deletedAt: new Date('2026-11-01'), user: { name: 'Gone SO', phone: '7' }, hierarchyLevel: { name: 'SO', level: 2 } },
          asm: { id: 'asm', employeeCode: 'E-ASM', reportingToId: null, isActive: true, deletedAt: null, user: { name: 'Arun ASM', phone: '8' }, hierarchyLevel: { name: 'ASM', level: 3 } },
        };
        (mockPrisma as any).salesUser.findFirst = jest.fn((args: { where: { id: string; clientId: string } }) =>
          Promise.resolve(args.where.clientId === 'bajaj' ? (NODES[args.where.id] ?? null) : null),
        );
      };

      it('F4: the /auth/me sales lookup excludes a REMOVED (soft-deleted) sales user', async () => {
        stub(null);
        await service.getMe(salesCaller);
        expect((mockPrisma as any).salesUser.findUnique.mock.calls[0][0].where).toEqual({ userId: 'u-isr', deletedAt: null });
      });

      it('a live, active direct manager is shown as before (no extra query)', async () => {
        stub({ isActive: true, deletedAt: null, user: { name: 'Sonu SO', phone: '7' }, hierarchyLevel: { name: 'SO' } });
        const res = await service.getMe(salesCaller);
        expect((res.user.salesUser as any).reportingTo).toEqual({ user: { name: 'Sonu SO', phone: '7' }, hierarchyLevel: { name: 'SO' } });
        expect((mockPrisma as any).salesUser.findMany).not.toHaveBeenCalled();
        // Response shape unchanged: no internal clientId / flags leak.
        expect(res.user.salesUser).not.toHaveProperty('clientId');
      });

      it('a soft-deleted direct manager is replaced by the next ACTIVE manager (tenant-scoped walk)', async () => {
        stub({ id: 'so', isActive: true, deletedAt: new Date('2026-11-01'), user: { name: 'Gone SO', phone: '7' }, hierarchyLevel: { name: 'SO' } });
        const res = await service.getMe(salesCaller);
        expect((res.user.salesUser as any).reportingTo).toEqual({ user: { name: 'Arun ASM', phone: '8' }, hierarchyLevel: { name: 'ASM' } });
        // Bounded, tenant-scoped id walk from the vacant SO up to the ASM; no full-tenant read.
        expect((mockPrisma as any).salesUser.findFirst.mock.calls.map((c: any[]) => c[0].where)).toEqual([
          { id: 'so', clientId: 'bajaj' },
          { id: 'asm', clientId: 'bajaj' },
        ]);
        expect((mockPrisma as any).salesUser.findMany).not.toHaveBeenCalled();
      });

      it('F6: a corrupt cyclic chain above a vacant manager terminates with no manager shown', async () => {
        stub({ id: 'so', isActive: false, deletedAt: null, user: { name: 'Off SO', phone: '7' }, hierarchyLevel: { name: 'SO' } });
        (mockPrisma as any).salesUser.findFirst = jest.fn((args: { where: { id: string } }) =>
          Promise.resolve({ id: args.where.id, reportingToId: args.where.id === 'so' ? 'x' : 'so', isActive: false, deletedAt: null, user: null, hierarchyLevel: null }),
        );
        const res = await service.getMe(salesCaller);
        expect((res.user.salesUser as any).reportingTo).toBeNull();
        expect((mockPrisma as any).salesUser.findFirst.mock.calls.length).toBeLessThanOrEqual(20);
      });
    });

    // ── /auth/me re-hydrate carries the partner-shell header identity (one rule with the login reply) ──
    describe('partner display identity on /auth/me', () => {
      // Restore the shared outlet stub shape other blocks rely on.
      afterEach(() => { (mockPrisma as any).outlet = { count: jest.fn() }; });
      const stubBase = () => {
        (mockPrisma as any).user.findUnique = jest.fn().mockResolvedValue({ name: 'VIKRAM SINGH', phone: '99' });
        (mockPrisma as any).channelPartner.findUnique.mockResolvedValue(null);
        (mockPrisma as any).salesUser.findUnique.mockResolvedValue(null);
      };

      it('adds businessName + primary-outlet outletName for a partner role', async () => {
        stubBase();
        (mockPrisma as any).channelPartner.findFirst = jest.fn()
          .mockResolvedValueOnce({ id: 'cp1', groupId: null })              // resolveActivePartnerId (own)
          .mockResolvedValueOnce({ businessName: 'Chakradhar Traders' });   // display row
        (mockPrisma as any).outlet = { findMany: jest.fn().mockResolvedValue([{ name: 'Chakradhar Marketing' }]) };

        const result = await service.getMe({ ...partnerUser, role: 'WHOLESALER' });

        expect(result.user).toMatchObject({ businessName: 'Chakradhar Traders', outletName: 'Chakradhar Marketing' });
        expect((mockPrisma as any).outlet.findMany).toHaveBeenCalledWith(expect.objectContaining({
          where: { clientId: 'deoleo', partnerId: 'cp1', deletedAt: null },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        }));
      });

      it('non-partner role: no display lookup and no new keys (response unchanged)', async () => {
        stubBase();
        (mockPrisma as any).channelPartner.findFirst = jest.fn();
        (mockPrisma as any).outlet = { findMany: jest.fn() };

        const result = await service.getMe({ ...partnerUser, role: 'SALES_ASM' });

        expect((mockPrisma as any).channelPartner.findFirst).not.toHaveBeenCalled();
        expect((mockPrisma as any).outlet.findMany).not.toHaveBeenCalled();
        expect(result.user).not.toHaveProperty('businessName');
        expect(result.user).not.toHaveProperty('outletName');
      });

      it('a display-lookup failure never fails /auth/me', async () => {
        stubBase();
        (mockPrisma as any).channelPartner.findFirst = jest.fn().mockRejectedValue(new Error('db blip'));

        const result = await service.getMe({ ...partnerUser, role: 'SSS' });
        expect(result.user.id).toBe('u1');
        expect(result.user).not.toHaveProperty('outletName');
      });
    });

    it('JOB B: returns the RAW beneficiary + paymentDetailsStatus even when UNVERIFIED (rewards flow needs the raw fields)', async () => {
      // The redemption flow reads the raw bank/upi to decide "has beneficiary" and create the payout,
      // so /auth/me must NOT hide them — it only ADDS paymentDetailsStatus so the FE profile can hide.
      (mockPrisma as any).user.findUnique = jest.fn().mockResolvedValue({ name: 'P', phone: '99' });
      (mockPrisma as any).channelPartner.findUnique.mockResolvedValue({
        id: 'cp1', partnerCode: 'PC1', businessName: 'Biz', ownerName: 'Owner',
        phone: '99', email: 'e@e.com', gstNumber: null, panNumber: null, entityType: 'PROPRIETORSHIP',
        bankName: 'HDFC', bankAccountNumber: '123456', bankAccountHolder: 'Owner',
        ifscCode: 'HDFC0001', upiId: 'owner@upi', paymentMode: 'UPI',
        paymentDetailsStatus: 'UNVERIFIED',
      });
      (mockPrisma as any).salesUser.findUnique.mockResolvedValue(null);
      (mockPrisma as any).wallet.findUnique.mockResolvedValue({
        earnedPoints: 100, redeemablePoints: 80, lockedPoints: 0, lifetimeEarned: 100,
      });

      const result = await service.getMe(partnerUser);

      // The select requests paymentDetailsStatus alongside the (still-raw) beneficiary fields.
      const selectArg = (mockPrisma as any).channelPartner.findUnique.mock.calls[0][0].select;
      expect(selectArg.paymentDetailsStatus).toBe(true);

      const cp = result.user.channelPartner as any;
      // Raw payout fields are UNCHANGED (not nulled) even for an UNVERIFIED partner.
      expect(cp.bankName).toBe('HDFC');
      expect(cp.bankAccountNumber).toBe('123456');
      expect(cp.upiId).toBe('owner@upi');
      // ...and the status is surfaced so the FE profile page can gate the display.
      expect(cp.paymentDetailsStatus).toBe('UNVERIFIED');
    });

    it('defaults conversionRate to 1 when POINTS_CONVERSION_RATE is unset', async () => {
      delete process.env.POINTS_CONVERSION_RATE;
      (mockPrisma as any).user.findUnique = jest.fn().mockResolvedValue({ name: 'P', phone: '99' });
      (mockPrisma as any).channelPartner.findUnique.mockResolvedValue(null);
      (mockPrisma as any).salesUser.findUnique.mockResolvedValue(null);

      const result = await service.getMe(partnerUser);
      expect((result as any).conversionRate).toBe(1);
    });

    // ── P6 — getMe exposes the caller's effective permissions[] for FE access-messaging ──
    it('P6: a GIFSY_STAFF getMe returns their assigned role permissions', async () => {
      (mockPrisma as any).user.findUnique = jest.fn().mockResolvedValue({ name: 'S', phone: '97' });
      (mockPrisma as any).channelPartner.findUnique.mockResolvedValue(null);
      (mockPrisma as any).salesUser.findUnique.mockResolvedValue(null);
      mockRoleSvc.getPermissions.mockResolvedValueOnce(new Set(['kyc:read', 'schemes:read']));
      const staff = { sub: 'st1', role: 'GIFSY_STAFF', clientId: 'gifsy', phone: '97', name: 'S', gifsyRoleId: 'r1' } as never;
      const result = await service.getMe(staff);
      expect(mockRoleSvc.getPermissions).toHaveBeenCalledWith('r1');
      expect((result as any).permissions.sort()).toEqual(['kyc:read', 'schemes:read']);
    });

    it('P6: a GIFSY_ADMIN getMe returns ALL permissions (owner unrestricted); a partner returns []', async () => {
      (mockPrisma as any).user.findUnique = jest.fn().mockResolvedValue({ name: 'A', phone: '98' });
      (mockPrisma as any).channelPartner.findUnique.mockResolvedValue(null);
      (mockPrisma as any).salesUser.findUnique.mockResolvedValue(null);
      const owner = { sub: 'ow', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '98', name: 'A' } as never;
      const ownerRes = await service.getMe(owner);
      expect((ownerRes as any).permissions).toContain('kyc:read');
      expect((ownerRes as any).permissions.length).toBeGreaterThan(10);
      // A non-operator role is not permission-gated on the FE → empty list.
      (mockPrisma as any).channelPartner.findUnique.mockResolvedValue(null);
      const partnerRes = await service.getMe(partnerUser);
      expect((partnerRes as any).permissions).toEqual([]);
    });
  });

  // â”€â”€ sendOtp â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  describe('sendOtp', () => {
    beforeEach(() => {
      // MSG91_AUTH_KEY is set in mockConfig, so sendViaMSG91 will try to
      // call fetch(). Mock a full response including json() so the response-body
      // error check in sendViaMSG91 doesn't blow up.
      global.fetch = jest.fn().mockResolvedValue({
        ok:   true,
        json: async () => ({ type: 'success', message: 'mock-request-id' }),
      } as any);
      // AF-10 per-phone window cap: default to "well under the cap" so existing tests pass.
      mockPrisma.otpCode.count.mockResolvedValue(0);
      // Option-B registration gate: default to "account exists" so a clientId-scoped send proceeds;
      // the unregistered case overrides this to null. Ignored when no clientId is passed.
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'seed-user' } as any);
    });

    it('should create an OTP record and return success', async () => {
      mockPrisma.otpCode.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp_1', code: '123456' });

      const result = await service.sendOtp('9876543210', 'SMS');

      // AF-10: prunes only OUT-OF-WINDOW rows (in-window rows are retained for the cap count).
      const delArg = mockPrisma.otpCode.deleteMany.mock.calls[0][0];
      expect(delArg.where.phone).toBe('9876543210');
      expect(delArg.where.createdAt.lt).toBeInstanceOf(Date);
      expect(mockPrisma.otpCode.create).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('AF-10: rejects (429) when the per-phone window cap is reached', async () => {
      mockPrisma.otpCode.count.mockResolvedValue(5); // at the cap
      await expect(service.sendOtp('9876543210', 'SMS')).rejects.toMatchObject({
        status: 429,
      });
      // No OTP created and no SMS sent once capped.
      expect(mockPrisma.otpCode.create).not.toHaveBeenCalled();
    });

    it('AF-10: the hourly cap counts ONLY LOGIN OTPs for the phone (KYC consent / redemption rows do not count)', async () => {
      // Simulate the DB: 5 KYC_CONSENT + 5 REDEMPTION_CONFIRM rows in the window, 0 LOGIN rows.
      const rows = [
        ...Array.from({ length: 5 }, () => ({ purpose: 'KYC_CONSENT' })),
        ...Array.from({ length: 5 }, () => ({ purpose: 'REDEMPTION_CONFIRM' })),
      ];
      mockPrisma.otpCode.count.mockImplementation(async ({ where }: any) =>
        rows.filter((r) => where.purpose === undefined || r.purpose === where.purpose).length);
      mockPrisma.otpCode.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp_1' });
      await expect(service.sendOtp('9876543210', 'SMS')).resolves.toMatchObject({ success: true });
      expect(mockPrisma.otpCode.count.mock.calls[0][0].where).toMatchObject({ phone: '9876543210', purpose: 'LOGIN' });
    });

    it('AF-10: LOGIN rows still count — 5 LOGIN OTPs in the window → 429', async () => {
      const rows = [
        ...Array.from({ length: 5 }, () => ({ purpose: 'LOGIN' })),
        ...Array.from({ length: 3 }, () => ({ purpose: 'KYC_CONSENT' })),
      ];
      mockPrisma.otpCode.count.mockImplementation(async ({ where }: any) =>
        rows.filter((r) => where.purpose === undefined || r.purpose === where.purpose).length);
      await expect(service.sendOtp('9876543210', 'SMS')).rejects.toMatchObject({ status: 429 });
      expect(mockPrisma.otpCode.create).not.toHaveBeenCalled();
    });

    it('AF-10: the DB-cap 429 logs its OWN distinct line ([otp-send-cap]) with a masked phone', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        mockPrisma.otpCode.count.mockResolvedValue(5);
        await expect(service.sendOtp('9123456789', 'SMS')).rejects.toMatchObject({ status: 429 });
        const text = warn.mock.calls.map((c) => String(c[0])).join('\n');
        expect(text).toContain('[otp-send-cap]');
        expect(text).toContain('"event":"otp.send_cap"');
        expect(text).toContain('******6789');
        expect(text).not.toContain('9123456789');
        expect(text).not.toContain('throttle.rejected'); // the throttler's line is a different event
      } finally {
        warn.mockRestore();
      }
    });

    it('A2: OTP code stored is exactly 6 digits', async () => {
      // RED: currently generateOtpCode() produces a 4-digit number (1000-9999).
      // After fix it must produce a 6-digit number (100000-999999).
      mockPrisma.otpCode.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp_1' });

      await service.sendOtp('9876543210', 'SMS');

      const createArg = mockPrisma.otpCode.create.mock.calls[0][0];
      const code      = createArg.data.code as string;

      expect(code).toHaveLength(6);
      expect(Number(code)).toBeGreaterThanOrEqual(100000);
      expect(Number(code)).toBeLessThanOrEqual(999999);
    });

    it('should reject invalid phone (< 10 digits)', async () => {
      await expect(service.sendOtp('12345', 'SMS')).rejects.toThrow();
    });

    it('uses the global env template when the tenant has no login override', async () => {
      mockPrisma.otpCode.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp_1' });
      // programSetting.findMany defaults to [] → no otpTemplates override → undefined → env template.
      await service.sendOtp('9876543210', 'SMS', 'deoleo');

      const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      expect(body.template_id).toBe('test-template'); // MSG91_OTP_TEMPLATE_ID env
    });

    it('threads the per-tenant login template into the MSG91 send when configured', async () => {
      mockPrisma.otpCode.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp_1' });
      mockPrisma.programSetting.findMany.mockResolvedValueOnce([
        { settingKey: 'otpTemplates', settingValue: { login: 'login-tpl' } },
      ]);

      await service.sendOtp('9876543210', 'SMS', 'deoleo');

      const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      expect(body.template_id).toBe('login-tpl');
    });

    it('uses the env template when no clientId is passed (pre-auth, tenant unknown)', async () => {
      mockPrisma.otpCode.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp_1' });
      mockPrisma.programSetting.findMany.mockResolvedValueOnce([
        { settingKey: 'otpTemplates', settingValue: { login: 'login-tpl' } },
      ]);

      // No clientId → getOtpTemplateId short-circuits to undefined → env template (no DB read).
      await service.sendOtp('9876543210', 'SMS');

      const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      expect(body.template_id).toBe('test-template');
    });

    // ── Option B: check-first registration gate ──────────────────────────────
    it('Option B: refuses to send (401) to a number with NO ACTIVE account under the tenant', async () => {
      // Under ACTIVE-only phone reservation, a number held only by an INACTIVE/soft-deleted
      // user has NO ACTIVE holder → the status:'ACTIVE' lookup returns null → refuse to send.
      mockPrisma.user.findFirst.mockResolvedValue(null as any); // no ACTIVE holder under this tenant
      await expect(service.sendOtp('9876543210', 'SMS', 'deoleo')).rejects.toMatchObject({
        status: 401,
      });
      // Tenant-scoped, ACTIVE-only lookup (a freed/deactivated number does not receive an OTP).
      const where = (mockPrisma.user.findFirst as jest.Mock).mock.calls[0][0].where;
      expect(where).toMatchObject({ phone: '9876543210', clientId: 'deoleo', status: 'ACTIVE' });
      // No OTP created + no SMS sent for an unregistered number.
      expect(mockPrisma.otpCode.create).not.toHaveBeenCalled();
      expect(global.fetch as jest.Mock).not.toHaveBeenCalled();
    });

    it('Option B: sends to a REGISTERED number (tenant-scoped ACTIVE account exists)', async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'u1' } as any); // ACTIVE holder exists
      mockPrisma.otpCode.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp_1' });
      const result = await service.sendOtp('9876543210', 'SMS', 'deoleo');
      expect(result.success).toBe(true);
      // Gate keyed on the ACTIVE status (not deletedAt), so only a live account is OTP-eligible.
      const where = (mockPrisma.user.findFirst as jest.Mock).mock.calls[0][0].where;
      expect(where).toMatchObject({ phone: '9876543210', clientId: 'deoleo', status: 'ACTIVE' });
      expect(mockPrisma.otpCode.create).toHaveBeenCalled();
    });

    it('Option B: SKIPS the registration check when no clientId is passed (legacy/unbranded caller)', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null as any); // would reject IF the check ran
      mockPrisma.otpCode.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp_1' });
      const result = await service.sendOtp('9876543210', 'SMS'); // no clientId
      expect(result.success).toBe(true);
      expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.otpCode.create).toHaveBeenCalled();
    });
  });

  // â”€â”€ verifyOtp â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  describe('verifyOtp', () => {
    const phone    = '9876543210';
    const clientId = 'deoleo';
    const validOtp = { id: 'otp_1', code: '1234', attempts: 0, maxAttempts: 3, expiresAt: new Date(Date.now() + 60000), verifiedAt: null };

    // The getMe block reassigns mockPrisma.channelPartner to a findUnique-only stub;
    // restore the findFirst + outlet.count shape the deactivated-outlet gate needs.
    beforeEach(() => {
      (mockPrisma as any).channelPartner = { findFirst: jest.fn() };
      (mockPrisma as any).outlet = { count: jest.fn() };
      // L1: each attempt is claimed atomically before the code is compared -- default: the claim wins
      // as the FIRST attempt (the claim returns the post-increment attempts value).
      mockPrisma.$queryRaw.mockReset();
      mockPrisma.$queryRaw.mockResolvedValue([{ attempts: 1 }]);
      mockPrisma.otpCode.updateMany.mockResolvedValue({ count: 1 });
      // A refused claim re-reads the row for the honest message — default: still live (cap spent).
      mockPrisma.otpCode.findUnique.mockResolvedValue({ expiresAt: new Date(Date.now() + 60_000), verifiedAt: null });
    });

    it('should return access + refresh tokens on correct OTP', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue(validOtp);
      mockPrisma.otpCode.update.mockResolvedValue({});
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'user_1', role: 'RETAILER', clientId, status: 'ACTIVE' });
      mockPrisma.userSession.create.mockResolvedValue({ id: 'sess_1' });

      const result = await service.verifyOtp(phone, '1234', clientId);

      expect(result.accessToken).toBe('mock.jwt.token');
      expect(result.refreshToken).toBeTruthy();
    });

    // ── ACTIVE-only phone reservation: DETERMINISTIC login resolution ──────────
    // Now that a deactivated user keeps deletedAt=null (only status→INACTIVE), an ACTIVE
    // and an INACTIVE row can share (clientId, phone). Login MUST resolve to the ACTIVE
    // user via an ACTIVE-first query — never the nondeterministic old findFirst.
    it('resolves to the ACTIVE user when an ACTIVE + INACTIVE duplicate share the phone', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue(validOtp);
      mockPrisma.otpCode.update.mockResolvedValue({});
      // Step 1 (status:'ACTIVE') returns the ACTIVE user; the INACTIVE duplicate is never consulted.
      mockPrisma.user.findFirst.mockResolvedValueOnce({
        id: 'active_user', role: 'RETAILER', clientId, status: 'ACTIVE', name: 'A', phone,
      });
      mockPrisma.user.update.mockResolvedValue({});
      mockPrisma.userSession.create.mockResolvedValue({ id: 'sess_1' });

      const result = await service.verifyOtp(phone, '1234', clientId);

      // Tokens are minted for the ACTIVE user's id.
      expect(result.user.id).toBe('active_user');
      // The FIRST user lookup is the ACTIVE-scoped query — proves ACTIVE is consulted first.
      const firstWhere = (mockPrisma.user.findFirst as jest.Mock).mock.calls[0][0].where;
      expect(firstWhere).toMatchObject({ phone, clientId, status: 'ACTIVE' });
      // With an ACTIVE hit, the deletedAt fallback query is never reached.
      expect(mockPrisma.user.findFirst as jest.Mock).toHaveBeenCalledTimes(1);
    });

    it('throws the existing "account is inactive" error for a single INACTIVE user (no ACTIVE)', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue(validOtp);
      mockPrisma.otpCode.update.mockResolvedValue({});
      // Step 1 (ACTIVE) → none; Step 2 (fallback, deletedAt:null) → the INACTIVE row (message only).
      mockPrisma.user.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'u_inactive', role: 'RETAILER', clientId, status: 'INACTIVE' });

      await expect(service.verifyOtp(phone, '1234', clientId)).rejects.toThrow(
        'Your account is inactive. Please contact your Deoleo representative.',
      );
      // No token minted on the fallback branch.
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
    });

    it('throws the existing "pending activation" error for a single PENDING_VERIFICATION user', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue(validOtp);
      mockPrisma.otpCode.update.mockResolvedValue({});
      mockPrisma.user.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'u_pending', role: 'RETAILER', clientId, status: 'PENDING_VERIFICATION' });

      await expect(service.verifyOtp(phone, '1234', clientId)).rejects.toThrow(
        'Your account is pending activation. Please contact your Deoleo representative.',
      );
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
    });

    it('throws "No account found" when neither an ACTIVE nor any non-deleted user exists', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue(validOtp);
      mockPrisma.otpCode.update.mockResolvedValue({});
      mockPrisma.user.findFirst
        .mockResolvedValueOnce(null)  // no ACTIVE
        .mockResolvedValueOnce(null); // no fallback (deletedAt:null) either

      await expect(service.verifyOtp(phone, '1234', clientId)).rejects.toThrow(
        'No account found. Please contact your sales representative to complete KYC first.',
      );
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
    });

    // ── Deactivated-outlet login gate (owner: a deactivated outlet must not log in) ──
    it('blocks a partner login when ALL their outlets are deactivated (0 active)', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue(validOtp);
      mockPrisma.otpCode.update.mockResolvedValue({});
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'user_1', role: 'WHOLESALER', clientId, status: 'ACTIVE' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1', isActive: true });
      mockPrisma.outlet.count.mockResolvedValue(0); // every outlet deactivated/deleted

      await expect(service.verifyOtp(phone, '1234', clientId)).rejects.toThrow('deactivated');
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled(); // no session minted
    });

    it('blocks a partner login when the ChannelPartner itself is deactivated', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue(validOtp);
      mockPrisma.otpCode.update.mockResolvedValue({});
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'user_1', role: 'SSS', clientId, status: 'ACTIVE' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1', isActive: false });
      mockPrisma.outlet.count.mockResolvedValue(1); // even with an active outlet, the partner is off

      await expect(service.verifyOtp(phone, '1234', clientId)).rejects.toThrow('inactive');
    });

    it('allows a partner login when at least ONE outlet is still active', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue(validOtp);
      mockPrisma.otpCode.update.mockResolvedValue({});
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'user_1', role: 'WHOLESALER', clientId, status: 'ACTIVE' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1', isActive: true });
      mockPrisma.outlet.count.mockResolvedValue(2); // multi-outlet partner, one deactivated, one still active
      mockPrisma.userSession.create.mockResolvedValue({ id: 'sess_1' });

      const result = await service.verifyOtp(phone, '1234', clientId);
      expect(result.accessToken).toBe('mock.jwt.token');
      // The active-outlet count is scoped to active + non-deleted outlets for THIS partner.
      expect(mockPrisma.outlet.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ partnerId: 'cp1', isActive: true, deletedAt: null }) }),
      );
    });

    // ── Partner-shell header identity in the login reply (outlet name from first paint) ──
    describe('login reply carries the partner display identity', () => {
      const partnerLogin = (role = 'WHOLESALER') => {
        mockPrisma.otpCode.findFirst.mockResolvedValue(validOtp);
        mockPrisma.otpCode.update.mockResolvedValue({});
        mockPrisma.user.findFirst.mockResolvedValue({
          id: 'user_1', role, clientId, status: 'ACTIVE', name: 'VIKRAM SINGH', phone,
        });
        mockPrisma.userSession.create.mockResolvedValue({ id: 'sess_1' });
      };

      it('adds businessName + the PRIMARY outlet master name (same rule as /partner/me)', async () => {
        partnerLogin();
        // gate lookup, resolveActivePartnerId (own), then the display partner row.
        mockPrisma.channelPartner.findFirst
          .mockResolvedValueOnce({ id: 'cp1', isActive: true })
          .mockResolvedValueOnce({ id: 'cp1', groupId: null })
          .mockResolvedValueOnce({ businessName: 'Chakradhar Traders' });
        mockPrisma.outlet.count.mockResolvedValue(1);
        (mockPrisma as any).outlet.findMany = jest.fn().mockResolvedValue([{ name: 'Chakradhar Marketing' }]);

        const result = await service.verifyOtp(phone, '1234', clientId);

        expect(result.user).toMatchObject({
          id: 'user_1', name: 'VIKRAM SINGH',
          businessName: 'Chakradhar Traders', outletName: 'Chakradhar Marketing',
        });
        // Primary-outlet selection identical to resolvePartnerActivity (isPrimary desc, createdAt asc).
        expect((mockPrisma as any).outlet.findMany).toHaveBeenCalledWith(expect.objectContaining({
          where: { clientId, partnerId: 'cp1', deletedAt: null },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        }));
        // The default (own) outlet — never a switched sibling at login.
        expect((mockPrisma.channelPartner.findFirst as jest.Mock).mock.calls[1][0].where)
          .toMatchObject({ userId: 'user_1', clientId, isParent: false });
      });

      it('outletName is null when the partner has no outlet (FE falls back to businessName)', async () => {
        partnerLogin();
        mockPrisma.channelPartner.findFirst
          .mockResolvedValueOnce({ id: 'cp1', isActive: true })
          .mockResolvedValueOnce({ id: 'cp1', groupId: null })
          .mockResolvedValueOnce({ businessName: 'Biz Only' });
        mockPrisma.outlet.count.mockResolvedValue(1);
        (mockPrisma as any).outlet.findMany = jest.fn().mockResolvedValue([]);

        const result = await service.verifyOtp(phone, '1234', clientId);
        expect(result.user).toMatchObject({ businessName: 'Biz Only', outletName: null });
      });

      it('a non-partner login reply is unchanged (no businessName/outletName keys)', async () => {
        partnerLogin();
        mockPrisma.channelPartner.findFirst.mockResolvedValue(null);

        const result = await service.verifyOtp(phone, '1234', clientId);
        expect(Object.keys(result.user).sort()).toEqual(['id', 'name', 'phone', 'role']);
      });

      it('a non-partner ROLE never runs the display lookup (only the existing deactivation gate query)', async () => {
        partnerLogin('SALES_ASM');
        mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
        (mockPrisma as any).outlet.findMany = jest.fn();

        const result = await service.verifyOtp(phone, '1234', clientId);
        expect(mockPrisma.channelPartner.findFirst).toHaveBeenCalledTimes(1); // the gate, not the display
        expect((mockPrisma as any).outlet.findMany).not.toHaveBeenCalled();
        expect(Object.keys(result.user).sort()).toEqual(['id', 'name', 'phone', 'role']);
      });

      it('a display-lookup failure never blocks the login (legacy reply)', async () => {
        partnerLogin();
        mockPrisma.channelPartner.findFirst
          .mockResolvedValueOnce({ id: 'cp1', isActive: true })
          .mockRejectedValueOnce(new Error('db blip'));
        mockPrisma.outlet.count.mockResolvedValue(1);

        const result = await service.verifyOtp(phone, '1234', clientId);
        expect(result.accessToken).toBe('mock.jwt.token');
        expect(result.user).not.toHaveProperty('outletName');
        expect(result.user).not.toHaveProperty('businessName');
      });
    });

    it('does not gate a non-partner login (sales/admin have no ChannelPartner)', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue(validOtp);
      mockPrisma.otpCode.update.mockResolvedValue({});
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'su_1', role: 'SALES_SO', clientId, status: 'ACTIVE' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null); // no partner → gate skipped
      mockPrisma.userSession.create.mockResolvedValue({ id: 'sess_1' });

      const result = await service.verifyOtp(phone, '1234', clientId);
      expect(result.accessToken).toBe('mock.jwt.token');
      expect(mockPrisma.outlet.count).not.toHaveBeenCalled(); // never even checks outlets
    });

    // The same gate MUST run on refresh — else a partner deactivated mid-session
    // keeps minting access tokens via their 30-day refresh token (audit F1).
    it('refresh is BLOCKED for a partner whose outlets were all deactivated', async () => {
      (mockPrisma as any).channelPartner = { findFirst: jest.fn().mockResolvedValue({ id: 'cp1', isActive: true }) };
      (mockPrisma as any).outlet = { count: jest.fn().mockResolvedValue(0) };
      mockPrisma.userSession.findFirst.mockResolvedValue({
        id: 'sess_d', clientId, refreshToken: 'rt', revokedAt: null,
        expiresAt: new Date(Date.now() + 60000),
        user: { id: 'u1', role: 'WHOLESALER', clientId },
      });
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 }); // atomic claim wins (session now revoked)

      await expect(service.refreshToken('rt')).rejects.toThrow('inactive');
    });

    it('refresh SUCCEEDS for a partner that still has an active outlet', async () => {
      (mockPrisma as any).channelPartner = { findFirst: jest.fn().mockResolvedValue({ id: 'cp1', isActive: true }) };
      (mockPrisma as any).outlet = { count: jest.fn().mockResolvedValue(1) };
      mockPrisma.userSession.findFirst.mockResolvedValue({
        id: 'sess_ok', clientId, refreshToken: 'rt', revokedAt: null,
        expiresAt: new Date(Date.now() + 60000),
        user: { id: 'u1', role: 'WHOLESALER', clientId },
      });
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.userSession.create.mockResolvedValue({ id: 'sess_new' });

      const result = await service.refreshToken('rt');
      expect(result.accessToken).toBe('mock.jwt.token');
    });

    it('should throw on expired OTP', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue({
        ...validOtp,
        expiresAt: new Date(Date.now() - 1000),  // expired
      });
      await expect(service.verifyOtp(phone, '1234', clientId)).rejects.toThrow('OTP expired');
    });

    it('should throw on wrong OTP and increment attempts (atomically, guarded by the cap)', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue(validOtp);
      mockPrisma.otpCode.update.mockResolvedValue({});
      mockPrisma.otpCode.updateMany.mockResolvedValue({ count: 1 });

      await expect(service.verifyOtp(phone, '9999', clientId)).rejects.toThrow('Invalid OTP. 2 attempts remaining.');
      // ONE conditional UPDATE … RETURNING bound to this row + its cap
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(mockPrisma.$queryRaw.mock.calls[0][0].values).toEqual(['otp_1', 3]);
      // never the old read-then-write absolute value
      expect(mockPrisma.otpCode.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ attempts: expect.anything() }) }),
      );
    });

    it('remaining-attempts copy is unchanged ("1 attempt" / "0 attempts remaining")', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue({ ...validOtp, attempts: 2 });
      mockPrisma.$queryRaw.mockResolvedValueOnce([{ attempts: 3 }]);
      await expect(service.verifyOtp(phone, '9999', clientId)).rejects.toThrow('Invalid OTP. 0 attempts remaining.');
      mockPrisma.otpCode.findFirst.mockResolvedValue({ ...validOtp, attempts: 1 });
      mockPrisma.$queryRaw.mockResolvedValueOnce([{ attempts: 2 }]);
      await expect(service.verifyOtp(phone, '9999', clientId)).rejects.toThrow('Invalid OTP. 1 attempt remaining.');
    });

    it('exact remaining: computed from the claim post-increment value, not the earlier (stale) read', async () => {
      // The read said attempts=0, but two parallel guesses claimed first -> this claim is attempt 3.
      mockPrisma.otpCode.findFirst.mockResolvedValue(validOtp);
      mockPrisma.$queryRaw.mockResolvedValueOnce([{ attempts: 3 }]);
      await expect(service.verifyOtp(phone, '9999', clientId)).rejects.toThrow('Invalid OTP. 0 attempts remaining.');
    });

    it('L1: an attempt whose atomic claim loses (count 0) is "Too many attempts" and is NEVER compared -- even the right code', async () => {
      // A stale read (attempts 0) passes the cheap pre-check, but the DB says the cap is already spent.
      mockPrisma.otpCode.findFirst.mockResolvedValue(validOtp);
      mockPrisma.$queryRaw.mockResolvedValue([]); // claim refused: no row updated
      mockPrisma.otpCode.update.mockClear();
      mockPrisma.userSession.create.mockClear();
      await expect(service.verifyOtp(phone, '1234', clientId)).rejects.toThrow('Too many attempts');
      // the correct code did not mark the OTP verified / mint a session
      expect(mockPrisma.otpCode.update).not.toHaveBeenCalled();
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
    });

    it('L1 wording: a lost claim on a code that EXPIRED meanwhile → "OTP expired", not "Too many attempts"', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue(validOtp);
      mockPrisma.$queryRaw.mockResolvedValue([]);
      mockPrisma.otpCode.findUnique.mockResolvedValue({ expiresAt: new Date(Date.now() - 1000), verifiedAt: null });
      await expect(service.verifyOtp(phone, '1234', clientId)).rejects.toThrow('OTP expired — please request a new one.');
      expect(mockPrisma.otpCode.findUnique).toHaveBeenCalledWith({ where: { id: 'otp_1' }, select: { expiresAt: true, verifiedAt: true } });
    });

    it('L1 wording: a lost claim on a code that is GONE (pruned) → "No active OTP found"', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue(validOtp);
      mockPrisma.$queryRaw.mockResolvedValue([]);
      mockPrisma.otpCode.findUnique.mockResolvedValue(null);
      await expect(service.verifyOtp(phone, '1234', clientId)).rejects.toThrow('No active OTP found for this number. Please request a new OTP.');
    });

    it('L1 concurrency: 100 parallel guesses on one OTP (all reading attempts=0) -> only maxAttempts are evaluated', async () => {
      // The conditional increment is the ONLY serialisation point -- simulate the DB row.
      let dbAttempts = 0;
      mockPrisma.otpCode.findFirst.mockResolvedValue(validOtp); // every request reads the stale 0
      mockPrisma.$queryRaw.mockImplementation(async (q: any) => {
        await new Promise((r) => setImmediate(r)); // interleave
        const max = q.values[1];
        if (dbAttempts < max) { dbAttempts++; return [{ attempts: dbAttempts }]; }
        return [];
      });
      mockPrisma.userSession.create.mockClear();
      // The real code is the LAST guess -- after the cap is spent it must NOT log in.
      const guesses = Array.from({ length: 100 }, (_, i) => (i === 99 ? '1234' : String(5000 + i)));
      const results = await Promise.allSettled(guesses.map((g) => service.verifyOtp(phone, g, clientId)));
      const msgs = results.map((r) => (r.status === 'rejected' ? (r.reason as Error).message : 'OK'));
      expect(msgs.filter((m) => m.startsWith('Invalid OTP')).length).toBe(3);
      expect(msgs.filter((m) => m.startsWith('Too many attempts')).length).toBe(97);
      // Exact remaining per winner (the old stale read said "2 attempts remaining" to all three).
      expect(msgs.filter((m) => m.startsWith('Invalid OTP')).sort()).toEqual([
        'Invalid OTP. 0 attempts remaining.',
        'Invalid OTP. 1 attempt remaining.',
        'Invalid OTP. 2 attempts remaining.',
      ]);
      expect(msgs).not.toContain('OK');
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
      expect(dbAttempts).toBe(3);
    });

    it('#1: looks up ONLY the LOGIN-purpose OTP for the phone (never a redemption/KYC/scheme row)', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue(null);
      await expect(service.verifyOtp(phone, '1234', clientId)).rejects.toThrow('No active OTP found');
      expect(mockPrisma.otpCode.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: { phone, purpose: 'LOGIN', verifiedAt: null },
      }));
    });

    it('#3: marks the OTP used CONDITIONALLY (verifiedAt: null) — a lost mark is "No active OTP", no session', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue(validOtp);
      mockPrisma.otpCode.updateMany.mockImplementation(async ({ data }: any) =>
        (data?.verifiedAt ? { count: 0 } : { count: 1 }));
      mockPrisma.userSession.create.mockClear();
      await expect(service.verifyOtp(phone, '1234', clientId)).rejects.toThrow('No active OTP found');
      expect(mockPrisma.otpCode.updateMany).toHaveBeenCalledWith({
        where: { id: 'otp_1', verifiedAt: null }, data: { verifiedAt: expect.any(Date) },
      });
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
    });

    it('#3: two parallel CORRECT verifies of one OTP → exactly one session', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue(validOtp);
      const row = simulateOtpRow(mockPrisma);
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'user_1', role: 'RETAILER', clientId, status: 'ACTIVE' });
      mockPrisma.userSession.create.mockClear();
      mockPrisma.userSession.create.mockResolvedValue({ id: 'sess_1' });
      const results = await Promise.allSettled([1, 2].map(() => service.verifyOtp(phone, '1234', clientId)));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect((rejected.reason as Error).message).toContain('No active OTP found');
      expect(row.marks).toBe(1);
      expect(mockPrisma.userSession.create).toHaveBeenCalledTimes(1);
    });

    it('should lock OTP after 3 failed attempts', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue({ ...validOtp, attempts: 3 });
      await expect(service.verifyOtp(phone, '9999', clientId)).rejects.toThrow('Too many attempts');
    });

    it('should throw on no OTP found for phone', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue(null);
      await expect(service.verifyOtp(phone, '1234', clientId)).rejects.toThrow();
    });
  });

  // â”€â”€ generateTokens â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  describe('generateTokens', () => {
    it('should call JwtService.sign with correct payload', async () => {
      mockPrisma.userSession.create.mockResolvedValue({ id: 'sess_1' });
      const user = { id: 'user_1', role: 'RETAILER', clientId: 'deoleo', phone: '9876543210' };

      await service.generateTokens(user as any);

      expect(mockJwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({ sub: 'user_1', role: 'RETAILER', clientId: 'deoleo' }),
        expect.any(Object),
      );
    });
  });

  // ── logoutAllSessions (self "log out everywhere", #101 / Feature 10-i) ───────
  describe('logoutAllSessions', () => {
    const caller = { sub: 'me1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'Me' } as any;

    it('revokes ONLY the caller (user.sub) non-revoked sessions and returns the count', async () => {
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 3 });
      mockPrisma.auditLog.create.mockResolvedValue({ id: 'al1' });

      const res = await service.logoutAllSessions(caller);

      // Strictly scoped to the caller's own userId + non-revoked rows
      expect(mockPrisma.userSession.updateMany).toHaveBeenCalledWith({
        where: { userId: 'me1', revokedAt: null },
        data:  { revokedAt: expect.any(Date) },
      });
      expect(res).toEqual({ revoked: 3 });
    });

    it('writes a LOGOUT audit log attributed to the caller with the logout_all_sessions event', async () => {
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.auditLog.create.mockResolvedValue({ id: 'al2' });

      await service.logoutAllSessions(caller);

      const audit = mockPrisma.auditLog.create.mock.calls[0][0].data;
      expect(audit.action).toBe('LOGOUT');
      expect(audit.actorId).toBe('me1');
      expect(audit.metadata).toMatchObject({ event: 'logout_all_sessions', revoked: 1 });
    });
  });

  // ── exitTenant — authoritative, stash-independent exit (#51 strand fix) ──────
  describe('exitTenant', () => {
    // The caller's token here is the ASSUMED token: role stays GIFSY_ADMIN, clientId is the tenant,
    // assumed:true, and `sid` is the assumed session's id (revoked on exit).
    const assumedOp = { sub: 'op1', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '98', name: 'Op', assumed: true, sid: 'sid_A' } as any;

    beforeEach(() => {
      mockPrisma.userSession.create.mockResolvedValue({ id: 'home_sess' });
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.auditLog.create.mockResolvedValue({ id: 'al_exit' });
    });

    it('mints an UN-ASSUMED session for the operator’s OWN home clientId (no assumed flag)', async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'op1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '98', name: 'Op' } as any);

      const res = await service.exitTenant(assumedOp);

      // token minted for the HOME clientId, and the payload carries NO `assumed` flag
      const signPayload = (mockJwt.sign as jest.Mock).mock.calls.at(-1)![0];
      expect(signPayload).toEqual(expect.objectContaining({ sub: 'op1', role: 'GIFSY_ADMIN', clientId: 'gifsy' }));
      expect(signPayload.assumed).toBeUndefined();
      // the SESSION ROW is created against the HOME clientId too (not the tenant) — a regression that
      // minted the row against the assumed tenant while signing home would otherwise slip through.
      const sessionData = (mockPrisma.userSession.create as jest.Mock).mock.calls.at(-1)![0].data;
      expect(sessionData.clientId).toBe('gifsy');
      expect(res.clientId).toBe('gifsy');
      expect(res.accessToken).toBeTruthy();
      expect(res.refreshToken).toBeTruthy();
    });

    it('REVOKES the assumed session AND its WHOLE rotation lineage (multi-hop, S4) so it cannot self-renew', async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'op1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '98', name: 'Op' } as any);
      // Lineage sid_A → sid_B → sid_C (two hops: a prior tab rotated twice), then no more children.
      mockPrisma.userSession.findMany
        .mockResolvedValueOnce([{ id: 'sid_B' }])
        .mockResolvedValueOnce([{ id: 'sid_C' }])
        .mockResolvedValueOnce([]);

      await service.exitTenant(assumedOp);

      const revokes = (mockPrisma.userSession.updateMany as jest.Mock).mock.calls.map((c) => c[0]);
      expect(revokes.map((r) => r.where.id.in)).toEqual([['sid_A'], ['sid_B'], ['sid_C']]);
      for (const r of revokes) {
        expect(r.where).toMatchObject({ userId: 'op1', revokedAt: null });
        expect(r.data).toEqual({ revokedAt: expect.any(Date) });
      }
      // Each hop's children are looked up scoped to the caller's own userId.
      expect(mockPrisma.userSession.findMany.mock.calls[0][0].where).toEqual({ userId: 'op1', rotatedFromId: { in: ['sid_A'] } });
    });

    it('writes an EXIT_TENANT audit log attributed to the real operator', async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'op1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '98', name: 'Op' } as any);

      await service.exitTenant(assumedOp);

      const audit = mockPrisma.auditLog.create.mock.calls.at(-1)![0].data;
      expect(audit.action).toBe('LOGOUT');
      expect(audit.actorId).toBe('op1');
      expect(audit.metadata).toMatchObject({ event: 'EXIT_TENANT', fromClientId: 'deoleo', toClientId: 'gifsy' });
    });

    it('rejects an UN-ASSUMED caller (no spurious home session / from==to audit row)', async () => {
      await expect(
        service.exitTenant({ sub: 'op1', role: 'GIFSY_ADMIN', clientId: 'gifsy', assumed: false, sid: 's' } as any),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
      expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('forbids a non-operator caller', async () => {
      await expect(
        service.exitTenant({ sub: 'u1', role: 'CLIENT_ADMIN', clientId: 'deoleo', assumed: true } as any),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects when the operator account no longer exists', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null as any);
      await expect(service.exitTenant(assumedOp)).rejects.toThrow(UnauthorizedException);
    });
  });

  // ── refreshToken preserves the assumed operator-context (A2 audit fix) ───────
  describe('refreshToken (operator-context)', () => {
    it('a refreshed ASSUMED session keeps the tenant scope + assumed flag (not reverted to gifsy)', async () => {
      // Session row carries the TENANT clientId; its user is the gifsy operator.
      mockPrisma.userSession.findFirst.mockResolvedValue({
        id: 'sess_a', clientId: 'deoleo', refreshToken: 'rt', revokedAt: null,
        expiresAt: new Date(Date.now() + 3600_000),
        user: { id: 'op1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '98', name: 'Op' },
      });
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 }); // claim wins
      mockPrisma.userSession.update.mockResolvedValue({});
      mockPrisma.userSession.create.mockResolvedValue({});

      await service.refreshToken('rt');

      const payload = mockJwt.sign.mock.calls[0][0];
      expect(payload).toMatchObject({ sub: 'op1', role: 'GIFSY_ADMIN', clientId: 'deoleo', assumed: true });
    });

    it('a normal session refreshes to its own home clientId (no assumed flag)', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue({
        id: 'sess_n', clientId: 'deoleo', refreshToken: 'rt', revokedAt: null,
        expiresAt: new Date(Date.now() + 3600_000),
        user: { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P' },
      });
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 }); // claim wins
      mockPrisma.userSession.update.mockResolvedValue({});
      mockPrisma.userSession.create.mockResolvedValue({});

      await service.refreshToken('rt');

      const payload = mockJwt.sign.mock.calls[0][0];
      expect(payload.clientId).toBe('deoleo');
      expect(payload.assumed).toBeUndefined();
    });
  });

  // ── refreshToken atomic single-use claim (token-reuse / session-fixation fix) ─
  describe('refreshToken (atomic single-use)', () => {
    const liveSession = {
      id: 'sess_x', clientId: 'deoleo', refreshToken: 'rt', revokedAt: null,
      expiresAt: new Date(Date.now() + 3600_000),
      user: { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P' },
    };

    it('revokes via an ATOMIC updateMany claim keyed on the refreshToken (not a read-then-update by id)', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue(liveSession);
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.userSession.create.mockResolvedValue({});

      await service.refreshToken('rt');

      // The holder's claim also marks the session USED (its holder presented its refresh token).
      expect(mockPrisma.userSession.updateMany).toHaveBeenCalledWith({
        where: { refreshToken: 'rt', revokedAt: null },
        data:  { revokedAt: expect.any(Date), firstUsedAt: expect.any(Date) },
      });
      // new tokens minted exactly once
      expect(mockPrisma.userSession.create).toHaveBeenCalledTimes(1);
      // the successor row records the predecessor it rotated from (idempotent-rotation chain)
      expect(mockPrisma.userSession.create.mock.calls[0][0].data.rotatedFromId).toBe('sess_x');
    });

    it('reads the predecessor IGNORING revokedAt (so a just-rotated predecessor is visible for grace)', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue(liveSession);
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.userSession.create.mockResolvedValue({});

      await service.refreshToken('rt');

      // The FIRST lookup keys on refreshToken alone (no revokedAt:null in the where).
      expect(mockPrisma.userSession.findFirst.mock.calls[0][0].where).toEqual({ refreshToken: 'rt' });
    });

    // ── Idempotent rotation (multi-tab fix) ──────────────────────────────────────
    it('idempotent: a loser (claim lost, predecessor revoked < grace, LIVE successor) returns the successor STORED tokens (no second mint)', async () => {
      const predecessor = {
        id: 'sess_x', clientId: 'deoleo', refreshToken: 'rt',
        revokedAt: new Date(Date.now() - 1_000), // just revoked by the winning sibling
        expiresAt: new Date(Date.now() + 3600_000),
        user: { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P' },
      };
      const successor = { id: 'sess_y', token: 'succ.access', refreshToken: 'succ-refresh', revokedAt: null };
      // 1st findFirst → predecessor (already revoked); 2nd findFirst → the live successor.
      mockPrisma.userSession.findFirst
        .mockResolvedValueOnce(predecessor)
        .mockResolvedValueOnce(successor);

      const res = await service.refreshToken('rt');

      // Hands back the successor's already-issued pair — NOT a freshly minted set.
      expect(res).toEqual({ accessToken: 'succ.access', refreshToken: 'succ-refresh' });
      // No claim attempt (already revoked) and, crucially, NO second mint.
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
      // The successor lookup REQUIRES revokedAt:null (a revoked successor can't be resurrected).
      expect(mockPrisma.userSession.findFirst.mock.calls[1][0].where).toEqual({
        rotatedFromId: 'sess_x', revokedAt: null,
      });
    });

    it('idempotent: a lost claim (count 0) with a live successor also returns the successor STORED tokens', async () => {
      // Predecessor still reads as un-revoked (our stale read), but the concurrent winner
      // revokes it → our claim loses (count 0) → grace path with predecessorRevokedAt ≈ now.
      const successor = { id: 'sess_y', token: 'succ.access', refreshToken: 'succ-refresh', revokedAt: null };
      mockPrisma.userSession.findFirst
        .mockResolvedValueOnce(liveSession)   // predecessor (revokedAt:null in our read)
        .mockResolvedValueOnce(successor);    // live successor
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 0 }); // claim lost

      const res = await service.refreshToken('rt');

      expect(res).toEqual({ accessToken: 'succ.access', refreshToken: 'succ-refresh' });
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
      // A lost claim is a PROVEN concurrent sibling (the row was live when this request read it)
      // → never a lineage kill, however long the winner's transaction took.
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('S2: a logout-all stamp visible INSIDE the claim transaction (user row FOR SHARE) → 401, no claim, no mint', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue({ ...liveSession, createdAt: new Date(Date.now() - 60_000) });
      txUserStamp.mockResolvedValueOnce([{ sessionsInvalidBefore: new Date() }]);

      await expect(service.refreshToken('rt')).rejects.toThrow('Session expired');
      expect(mockPrisma.userSession.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
      // The in-tx read is a FOR SHARE lock on the user row.
      const sql = (txUserStamp.mock.calls[0][0] as TemplateStringsArray).join('?');
      expect(sql).toMatch(/FROM "users" WHERE "id" = \? FOR SHARE/);
    });

    it('F1: the claim transaction FIRST sets a bounded lock_timeout', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue(liveSession);
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.userSession.create.mockResolvedValue({});

      await service.refreshToken('rt');

      expect(txExecRaw).toHaveBeenCalledWith("SET LOCAL lock_timeout = '1s'");
      expect(txExecRaw.mock.invocationCallOrder[0]).toBeLessThan(txUserStamp.mock.invocationCallOrder[0]);
    });

    it('F1: a transaction failure (lock timeout 55P03 / tx timeout) → 503 TRANSIENT, never a 401/500', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue(liveSession);
      txUserStamp.mockRejectedValueOnce(Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }));

      await expect(service.refreshToken('rt')).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
    });

    it.each([
      ['an absolute deadline already in the past', { clientDeadlineMs: Date.now() - 60_000 }],
      ['a 1ms relative budget', { budgetMs: 1 }],
    ])('S2: %s is FLOORED to 500ms from receipt → the refresh proceeds normally (no free 503 liveness probe)', async (_l, opts) => {
      mockPrisma.userSession.findFirst.mockResolvedValue(liveSession);
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.userSession.create.mockResolvedValue({});

      await expect(service.refreshToken('rt', opts)).resolves.toMatchObject({ accessToken: 'mock.jwt.token' });
      expect(mockPrisma.userSession.create).toHaveBeenCalledTimes(1);
    });

    it('F1: once receipt + budget has passed (slow path) → 503 before the transaction, nothing claimed', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue(liveSession);

      // Received 5s ago (e.g. a stalled gate read): even the 4s server budget is gone.
      await expect(service.refreshToken('rt', { receivedAt: Date.now() - 5_000 })).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('H2: grace is judged at RECEIPT — a replay received 5s after rotation but processed late still converges', async () => {
      mockPrisma.userSession.findFirst
        .mockResolvedValueOnce({ ...liveSession, revokedAt: new Date(Date.now() - 8_000) }) // 8s old NOW…
        .mockResolvedValueOnce({ id: 'sess_y', token: 'succ.access', refreshToken: 'succ-refresh', revokedAt: null });

      // …but only 5s old when the request was received 3s ago (slow pool before the read).
      await expect(service.refreshToken('rt', { receivedAt: Date.now() - 3_000 })).resolves.toEqual({
        accessToken: 'succ.access', refreshToken: 'succ-refresh',
      });
      expect(mockPrisma.user.update).not.toHaveBeenCalled(); // no reuse kill
    });

    it('F4: the winner re-stamps the predecessor revokedAt as the LAST statement (grace runs from commit)', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue(liveSession);
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.userSession.create.mockResolvedValue({});

      await service.refreshToken('rt');

      expect(mockPrisma.userSession.update).toHaveBeenCalledWith({ where: { id: 'sess_x' }, data: { revokedAt: expect.any(Date) } });
      expect(mockPrisma.userSession.update.mock.invocationCallOrder[0]).toBeGreaterThan(
        mockPrisma.userSession.create.mock.invocationCallOrder[0],
      );
    });

    it('grace is 6s: a replay 5.5s after the rotation still converges on the live successor', async () => {
      mockPrisma.userSession.findFirst
        .mockResolvedValueOnce({ ...liveSession, revokedAt: new Date(Date.now() - 5_500) })
        .mockResolvedValueOnce({ id: 'sess_y', token: 'succ.access', refreshToken: 'succ-refresh', revokedAt: null });

      await expect(service.refreshToken('rt')).resolves.toEqual({ accessToken: 'succ.access', refreshToken: 'succ-refresh' });
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('S3: a TRANSIENT gate failure (DB error) does NOT consume the predecessor → a retry can still succeed', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue(liveSession);
      mockPrisma.channelPartner.findFirst.mockRejectedValueOnce(new Error('connection timeout'));

      await expect(service.refreshToken('rt')).rejects.toThrow('connection timeout');
      expect(mockPrisma.userSession.updateMany).not.toHaveBeenCalled(); // predecessor left LIVE
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
    });

    it('S3: a DELIBERATE gate refusal (deactivated partner → 403) still consumes the predecessor', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue(liveSession);
      mockPrisma.channelPartner.findFirst.mockResolvedValueOnce({ id: 'cp1', isActive: false });
      mockPrisma.outlet.count.mockResolvedValueOnce(0);
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });

      await expect(service.refreshToken('rt')).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.userSession.updateMany).toHaveBeenCalledWith({
        where: { refreshToken: 'rt', revokedAt: null }, data: { revokedAt: expect.any(Date), firstUsedAt: expect.any(Date) },
      });
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
    });

    it('reuse: an already-revoked token replayed AFTER the 5s grace with NO live successor → 401', async () => {
      const staleRevoked = {
        id: 'sess_x', clientId: 'deoleo', refreshToken: 'rt',
        revokedAt: new Date(Date.now() - 60_000), // revoked a minute ago — outside the 5s grace
        createdAt: new Date(Date.now() - 3600_000),
        expiresAt: new Date(Date.now() + 3600_000),
        user: { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P', sessionsInvalidBefore: null },
      };
      // Predecessor read → revoked outside grace; the H4 successor lookup finds no live successor → reuse.
      mockPrisma.userSession.findFirst.mockResolvedValueOnce(staleRevoked).mockResolvedValueOnce(null);
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.user.update.mockResolvedValue({});

      await expect(service.refreshToken('rt')).rejects.toThrow('Session expired');
      // Predecessor read + H4 successor check; never mints a new session.
      expect(mockPrisma.userSession.findFirst).toHaveBeenCalledTimes(2);
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
    });

    it('unknown token → 401 (no session row at all)', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue(null);
      await expect(service.refreshToken('nope')).rejects.toThrow('Session expired');
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
    });

    it('no-resurrection: a successor revoked by logout-all → 401 (grace lookup requires revokedAt:null)', async () => {
      const predecessor = {
        id: 'sess_x', clientId: 'deoleo', refreshToken: 'rt',
        revokedAt: new Date(Date.now() - 1_000), // within grace
        expiresAt: new Date(Date.now() + 3600_000),
        user: { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P' },
      };
      // Predecessor is within grace, but the successor lookup (revokedAt:null) finds nothing
      // because logout-all revoked the successor → no resurrection → 401.
      mockPrisma.userSession.findFirst
        .mockResolvedValueOnce(predecessor)
        .mockResolvedValueOnce(null);

      await expect(service.refreshToken('rt')).rejects.toThrow('Session expired');
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
    });

    it('preserves the assumed operator-context only when the claim WINS', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue({
        id: 'sess_a', clientId: 'deoleo', refreshToken: 'rt', revokedAt: null,
        expiresAt: new Date(Date.now() + 3600_000),
        user: { id: 'op1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '98', name: 'Op' },
      });
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.userSession.create.mockResolvedValue({});

      await service.refreshToken('rt');

      const payload = mockJwt.sign.mock.calls[0][0];
      expect(payload).toMatchObject({ sub: 'op1', clientId: 'deoleo', assumed: true });
    });
  });

  // ── Sliding 7-day session TTL (roll-on-refresh) ──────────────────────────────
  describe('sliding session TTL (SESSION_TTL_DAYS = 30)', () => {
    const WINDOW_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

    beforeEach(() => {
      // Fixed "now" so TTL math is exact — computed RELATIVE to the mocked clock,
      // never a hardcoded future date.
      jest.useFakeTimers().setSystemTime(new Date('2026-08-12T00:00:00.000Z'));
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('login (generateTokens) stamps expiresAt ≈ now + the 30d sliding window', async () => {
      mockPrisma.userSession.create.mockResolvedValue({ id: 'sess_1' });
      await service.generateTokens({ id: 'u1', role: 'RETAILER', clientId: 'deoleo', phone: '99' } as any);

      const expiresAt: Date = mockPrisma.userSession.create.mock.calls[0][0].data.expiresAt;
      expect(expiresAt.getTime()).toBe(Date.now() + WINDOW_MS);
    });

    it('refresh re-mints expiresAt ≈ now + 30d AND writes rotatedFromId = predecessor.id', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue({
        id: 'pred_1', clientId: 'deoleo', refreshToken: 'rt', revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        user: { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P' },
      });
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.userSession.create.mockResolvedValue({});

      await service.refreshToken('rt');

      const data = mockPrisma.userSession.create.mock.calls[0][0].data;
      expect((data.expiresAt as Date).getTime()).toBe(Date.now() + WINDOW_MS);
      expect(data.rotatedFromId).toBe('pred_1');
    });

    it('assumed refresh re-mints expiresAt ≈ now + 30d and preserves assumed:true + tenant clientId', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue({
        id: 'pred_a', clientId: 'deoleo', refreshToken: 'rt', revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        user: { id: 'op1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '98', name: 'Op' },
      });
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.userSession.create.mockResolvedValue({});

      await service.refreshToken('rt');

      const data = mockPrisma.userSession.create.mock.calls[0][0].data;
      expect((data.expiresAt as Date).getTime()).toBe(Date.now() + WINDOW_MS);
      expect(data.clientId).toBe('deoleo'); // tenant scope preserved
      const payload = mockJwt.sign.mock.calls[0][0];
      expect(payload).toMatchObject({ clientId: 'deoleo', assumed: true });
    });
  });

  // ── Access-token TTL DECOUPLED from the session window (FIX 1a) ──────────────
  // The access JWT must be SHORT (ACCESS_TTL = 60m) on BOTH the normal and the assumed
  // paths so activity forces frequent refreshes; the SESSION ROW stays 30d (sliding), which
  // is what makes the rolling session non-inert. Fake timers → exact 30d math (relative to now).
  describe('access-token TTL (ACCESS_TTL = 60m, session row 30d)', () => {
    const WINDOW_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-12T00:00:00.000Z'));
      mockPrisma.client.findFirst.mockResolvedValue({ id: 'deoleo', internalName: 'Deoleo' });
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'op1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '98', name: 'Op' });
      mockPrisma.auditLog.create.mockResolvedValue({});
    });
    afterEach(() => jest.useRealTimers());

    it('NORMAL login signs the access token with expiresIn = 60m (JWT_EXPIRES_IN), NOT 30d', async () => {
      mockPrisma.userSession.create.mockResolvedValue({ id: 'sess_1' });
      await service.generateTokens({ id: 'u1', role: 'RETAILER', clientId: 'deoleo', phone: '99' } as any);

      // 2nd sign arg carries the JWT options; expiresIn is the SHORT access TTL.
      expect(mockJwt.sign.mock.calls[0][1].expiresIn).toBe('60m');
      // …while the persisted SESSION row still lives the full 30-day window.
      const expiresAt: Date = mockPrisma.userSession.create.mock.calls[0][0].data.expiresAt;
      expect(expiresAt.getTime()).toBe(Date.now() + WINDOW_MS);
    });

    it('ASSUMED (assume-tenant) signs the access token with expiresIn = 60m (not 720h), session row 30d', async () => {
      mockPrisma.userSession.create.mockResolvedValue({ id: 'sess_a' });
      await service.assumeTenant(gifsyOp, 'deoleo');

      expect(mockJwt.sign.mock.calls[0][1].expiresIn).toBe('60m');
      const expiresAt: Date = mockPrisma.userSession.create.mock.calls[0][0].data.expiresAt;
      expect(expiresAt.getTime()).toBe(Date.now() + WINDOW_MS); // 30d, NOT 720h-as-access
    });

    it('CODE default falls back to ACCESS_TTL (60m) when JWT_EXPIRES_IN is unset — never 30d', async () => {
      // Config returns undefined for JWT_EXPIRES_IN → the code default must be 60m.
      // Restore the shared default impl in finally so later describes aren't polluted.
      try {
        mockConfig.get.mockImplementation((key: string): any =>
          key === 'JWT_SECRET' ? 'test-secret' : undefined,
        );
        mockPrisma.userSession.create.mockResolvedValue({ id: 'sess_1' });
        await service.generateTokens({ id: 'u1', role: 'RETAILER', clientId: 'deoleo', phone: '99' } as any);

        expect(mockJwt.sign.mock.calls[0][1].expiresIn).toBe('60m');
      } finally {
        mockConfig.get.mockImplementation((key: string): any => {
          const cfg: Record<string, string> = {
            JWT_SECRET: 'test-secret', JWT_EXPIRES_IN: '60m',
            MSG91_AUTH_KEY: 'test-msg91-key', MSG91_SENDER_ID: 'GIFSY', MSG91_OTP_TEMPLATE_ID: 'test-template',
          };
          return cfg[key];
        });
      }
    });
  });

  // ── logout-all beats a concurrent refresh (FIX 1b) ──────────────────────────
  describe('logout-all authority vs concurrent refresh (1b)', () => {
    const liveSession = () => ({
      id: 'sess_x', clientId: 'deoleo', refreshToken: 'rt', revokedAt: null,
      createdAt: new Date(Date.now() - 60_000), // created a minute ago (before any logout)
      expiresAt: new Date(Date.now() + 3600_000),
      user: { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P', sessionsInvalidBefore: null as Date | null },
    });

    beforeEach(() => {
      (mockPrisma as any).channelPartner = { findFirst: jest.fn().mockResolvedValue(null) };
      (mockPrisma as any).outlet = { count: jest.fn() };
    });

    it('logoutAllSessions stamps user.sessionsInvalidBefore in the SAME op as the revoke', async () => {
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 2 });
      mockPrisma.user.update.mockResolvedValue({});
      mockPrisma.auditLog.create.mockResolvedValue({});

      const caller = { sub: 'me1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'Me' } as any;
      const res = await service.logoutAllSessions(caller);

      expect(res).toEqual({ revoked: 2 });
      // The stamp write targets the caller and sets a Date.
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'me1' },
        data:  { sessionsInvalidBefore: expect.any(Date) },
      });
    });

    it('a logout-all stamp visible INSIDE the claim tx (FOR SHARE read) → 401 and NOTHING minted', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue(liveSession()); // read BEFORE logout: stamp null
      // The stamp committed between our first read and the in-tx FOR SHARE read.
      txUserStamp.mockResolvedValueOnce([{ sessionsInvalidBefore: new Date(Date.now() + 60_000) }]);

      await expect(service.refreshToken('rt')).rejects.toThrow('Session expired');
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
      expect(mockPrisma.userSession.updateMany).not.toHaveBeenCalled();
    });

    it('H1: NO post-commit DB work — a committed rotation is returned even if the shared pool is unusable afterwards', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue(liveSession());
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.userSession.create.mockResolvedValue({});
      // Any post-commit read on the shared client would hang / fail — it must not be made.
      mockPrisma.user.findUnique.mockRejectedValue(new Error('pool exhausted'));

      const res = await service.refreshToken('rt');

      expect(res.accessToken).toBe('mock.jwt.token');
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
      mockPrisma.user.findUnique.mockReset();
    });

    it('a predecessor created BEFORE a prior logout-all is refused up front (never mints)', async () => {
      const s = liveSession();
      // Stamp already visible on the predecessor read, and the session predates it.
      s.user.sessionsInvalidBefore = new Date(Date.now() - 1_000);
      s.createdAt = new Date(Date.now() - 60_000);
      mockPrisma.userSession.findFirst.mockResolvedValue(s);

      await expect(service.refreshToken('rt')).rejects.toThrow('Session expired');
      // Rejected before the atomic claim / mint.
      expect(mockPrisma.userSession.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
    });

    it('a normal refresh with NO logout-all stamp still succeeds (re-read is a no-op)', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue(liveSession());
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.userSession.create.mockResolvedValue({});
      mockPrisma.user.findUnique.mockResolvedValue({ sessionsInvalidBefore: null });

      const res = await service.refreshToken('rt');
      expect(res.accessToken).toBe('mock.jwt.token');
    });
  });

  // ── reuse detection revokes the lineage (FIX 1c) ────────────────────────────
  describe('refresh-token reuse detection (1c, grace = 5s)', () => {
    beforeEach(() => {
      (mockPrisma as any).channelPartner = { findFirst: jest.fn().mockResolvedValue(null) };
      (mockPrisma as any).outlet = { count: jest.fn() };
    });

    it('S1: replay of a rotated token DAYS later while its successor is still LIVE → reuse detection, NOT a handoff', async () => {
      // The old lenient path handed a live successor to ANY replay of a revoked predecessor,
      // regardless of age — so a stolen, already-rotated token obtained the live session with
      // no time limit. Outside the grace window this is now treated as reuse.
      const rotatedLongAgo = {
        id: 'sess_x', clientId: 'deoleo', refreshToken: 'rt',
        revokedAt: new Date(Date.now() - 3 * 24 * 3600_000), // rotated 3 days ago
        createdAt: new Date(Date.now() - 4 * 24 * 3600_000),
        expiresAt: new Date(Date.now() + 3600_000),
        user: { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P', sessionsInvalidBefore: null },
      };
      // Its successor is live but was created 3 days ago and has been USED → strict.
      mockPrisma.userSession.findFirst.mockResolvedValueOnce(rotatedLongAgo).mockResolvedValueOnce({
        id: 'sess_y', token: 'succ.access', refreshToken: 'succ-refresh', revokedAt: null,
        firstUsedAt: new Date(Date.now() - 3 * 24 * 3600_000),
        createdAt: new Date(Date.now() - 3 * 24 * 3600_000), expiresAt: new Date(Date.now() + 3600_000),
      });
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.user.update.mockResolvedValue({});

      await expect(service.refreshToken('rt')).rejects.toThrow('Session expired');

      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
      // The live (used) successor is NOT handed back…
      expect(mockPrisma.userSession.findFirst).toHaveBeenCalledTimes(2);
      // …and the lineage is killed (stamp + revoke all live sessions).
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' }, data: { sessionsInvalidBefore: expect.any(Date) },
      });
      expect(mockPrisma.userSession.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', revokedAt: null }, data: { revokedAt: expect.any(Date) },
      });
    });

    it('S1: replay WITHIN the grace window with a live successor → handoff of the successor pair (no kill)', async () => {
      const justRotated = {
        id: 'sess_x', clientId: 'deoleo', refreshToken: 'rt',
        revokedAt: new Date(Date.now() - 1_000), // 1s ago — inside the 5s grace
        createdAt: new Date(Date.now() - 3600_000),
        expiresAt: new Date(Date.now() + 3600_000),
        user: { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P', sessionsInvalidBefore: null },
      };
      const successor = { id: 'sess_y', token: 'succ.access', refreshToken: 'succ-refresh', revokedAt: null };
      mockPrisma.userSession.findFirst
        .mockResolvedValueOnce(justRotated)
        .mockResolvedValueOnce(successor);

      const res = await service.refreshToken('rt');

      expect(res).toEqual({ accessToken: 'succ.access', refreshToken: 'succ-refresh' });
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
      expect(mockPrisma.userSession.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      expect(mockPrisma.userSession.findFirst.mock.calls[1][0].where).toEqual({
        rotatedFromId: 'sess_x', revokedAt: null,
      });
    });

    it('replay >5s grace with NO live successor → 401 AND revokes ALL sessions + stamps the user', async () => {
      const staleRevoked = {
        id: 'sess_x', clientId: 'deoleo', refreshToken: 'rt',
        revokedAt: new Date(Date.now() - 7_000), // 7s ago: inside the OLD 10s grace, OUTSIDE the new 5s
        createdAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 3600_000),
        user: { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P', sessionsInvalidBefore: null },
      };
      // Predecessor revoked, NO live successor (already rotated away) → genuine theft signal.
      mockPrisma.userSession.findFirst.mockResolvedValueOnce(staleRevoked).mockResolvedValueOnce(null);
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 3 });
      mockPrisma.user.update.mockResolvedValue({});

      await expect(service.refreshToken('rt')).rejects.toThrow('Session expired');

      // Outside grace: predecessor read + H4 successor check (none live); never mints.
      expect(mockPrisma.userSession.findFirst).toHaveBeenCalledTimes(2);
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
      // STAMP-BEFORE-REVOKE: the user stamp is written BEFORE the session revoke.
      const stampOrder = mockPrisma.user.update.mock.invocationCallOrder[0];
      const revokeCall = mockPrisma.userSession.updateMany.mock.calls.findIndex(
        (c: any) => c[0]?.where?.userId === 'u1',
      );
      const revokeOrder = mockPrisma.userSession.updateMany.mock.invocationCallOrder[revokeCall];
      expect(stampOrder).toBeLessThan(revokeOrder);
      // Lineage kill: revoke EVERY live session for the user…
      expect(mockPrisma.userSession.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', revokedAt: null },
        data:  { revokedAt: expect.any(Date) },
      });
      // …and stamp the user so any in-flight refresh is invalidated too.
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data:  { sessionsInvalidBefore: expect.any(Date) },
      });
    });

    it('a merely EXPIRED-but-never-revoked session is NOT treated as reuse (no lineage kill)', async () => {
      const expired = {
        id: 'sess_e', clientId: 'deoleo', refreshToken: 'rt', revokedAt: null,
        createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() - 1_000), // expired
        user: { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P', sessionsInvalidBefore: null },
      };
      // Predecessor read → expired; successor lookup (a login session has no rotation) → none.
      mockPrisma.userSession.findFirst.mockResolvedValueOnce(expired);

      await expect(service.refreshToken('rt')).rejects.toThrow('Session expired');
      // revokedAt === null → not reuse → the user-wide revoke + stamp must NOT run.
      expect(mockPrisma.userSession.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      // …and NO platform security-event row is written on a non-reuse path.
      expect(securityEventCalls()).toHaveLength(0);
    });

    // ── platform-level security-event audit (BE-1) ────────────────────────────
    // Every SECURITY_EVENT AuditLog write for refresh-token reuse; the report filters on
    // exactly this (entityType + metadata.event), so the tests assert on the same shape.
    const securityEventCalls = () =>
      mockPrisma.auditLog.create.mock.calls.filter(
        (c: any) =>
          c[0]?.data?.entityType === 'SECURITY_EVENT' &&
          c[0]?.data?.metadata?.event === 'refresh_token_reuse',
      );

    it('reuse (>5s grace, no live successor) writes ONE SECURITY_EVENT audit row AND still throws 401', async () => {
      const staleRevoked = {
        id: 'sess_x', clientId: 'deoleo', refreshToken: 'rt',
        revokedAt: new Date(Date.now() - 7_000),
        createdAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 3600_000),
        user: { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P', sessionsInvalidBefore: null },
      };
      mockPrisma.userSession.findFirst.mockResolvedValueOnce(staleRevoked).mockResolvedValueOnce(null);
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 3 });
      mockPrisma.user.update.mockResolvedValue({});

      await expect(service.refreshToken('rt')).rejects.toThrow('Session expired');

      const calls = securityEventCalls();
      expect(calls).toHaveLength(1);
      const data = calls[0][0].data;
      expect(data.action).toBe('LOGOUT');
      expect(data.entityType).toBe('SECURITY_EVENT');
      expect(data.targetUserId).toBe('u1');
      expect(data.entityId).toBe('u1');
      expect(data.actorId).toBe('u1');
      expect(data.metadata.event).toBe('refresh_token_reuse');
      // Which TENANT the reuse belongs to (AuditLog has no clientId column).
      expect(data.metadata.clientId).toBe('deoleo');
      expect(data.metadata.sessionId).toBe('sess_x');
    });

    it('best-effort: a failed SECURITY_EVENT audit write does NOT mask the 401', async () => {
      const staleRevoked = {
        id: 'sess_x', clientId: 'deoleo', refreshToken: 'rt',
        revokedAt: new Date(Date.now() - 7_000),
        createdAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 3600_000),
        user: { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P', sessionsInvalidBefore: null },
      };
      mockPrisma.userSession.findFirst.mockResolvedValueOnce(staleRevoked).mockResolvedValueOnce(null);
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 3 });
      mockPrisma.user.update.mockResolvedValue({});
      // Audit write blows up — the caller must still get the 401, not a 500.
      mockPrisma.auditLog.create.mockRejectedValueOnce(new Error('audit db down'));

      await expect(service.refreshToken('rt')).rejects.toThrow('Session expired');
    });

    it('S1: a replay >6s past grace whose live successor HAS BEEN USED → reuse → ONE SECURITY_EVENT row (no handoff)', async () => {
      const revokedPredecessor = {
        id: 'sess_x', clientId: 'deoleo', refreshToken: 'rt',
        revokedAt: new Date(Date.now() - 7_000),
        createdAt: new Date(Date.now() - 3600_000),
        expiresAt: new Date(Date.now() + 3600_000),
        user: { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P', sessionsInvalidBefore: null },
      };
      mockPrisma.userSession.findFirst.mockResolvedValueOnce(revokedPredecessor).mockResolvedValueOnce({
        id: 'sess_y', token: 'succ.access', refreshToken: 'succ-refresh', revokedAt: null,
        firstUsedAt: new Date(Date.now() - 5_000), createdAt: new Date(Date.now() - 7_000),
        expiresAt: new Date(Date.now() + 3600_000),
      });
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.user.update.mockResolvedValue({});

      await expect(service.refreshToken('rt')).rejects.toThrow('Session expired');
      expect(securityEventCalls()).toHaveLength(1);
    });

    // ── H4 / C1 / S-H1 (owner decisions 2026-11-20): never-used successor → RENEW FORWARD ──────
    // Lineage A → B. The client lost the response that carried B and replays A after the grace window.
    const HOUR = 3600_000;
    const replayedA = (rotatedAgoMs: number) => ({
      id: 'sess_a', clientId: 'deoleo', refreshToken: 'rt', userId: 'u1',
      revokedAt: new Date(Date.now() - rotatedAgoMs),
      createdAt: new Date(Date.now() - rotatedAgoMs - HOUR),
      expiresAt: new Date(Date.now() + 30 * 24 * HOUR),
      user: { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P', sessionsInvalidBefore: null },
    });
    const sessionB = (over: Record<string, unknown> = {}) => ({
      id: 'sess_b', clientId: 'deoleo', userId: 'u1', token: 'b.access', refreshToken: 'rt-b',
      revokedAt: null, firstUsedAt: null, handedBackAt: null, createdFingerprint: 'fp-device',
      createdAt: new Date(Date.now() - 2 * HOUR), expiresAt: new Date(Date.now() + 28 * 24 * HOUR),
      ...over,
    });
    const handbackAudits = () =>
      mockPrisma.auditLog.create.mock.calls.filter(
        (c: any) => c[0]?.data?.entityType === 'AUTH_EVENT' && c[0]?.data?.metadata?.event === 'REFRESH_HANDOFF_UNUSED_SUCCESSOR',
      );
    const repeatAlarms = () =>
      mockPrisma.auditLog.create.mock.calls.filter(
        (c: any) => c[0]?.data?.entityType === 'SECURITY_EVENT' && c[0]?.data?.metadata?.event === 'repeated_unused_successor_handoff',
      );
    /** A revoke of EVERY live session of the user (the reuse kill) — vs a lineage-only revoke. */
    const revokeAllCalls = () =>
      mockPrisma.userSession.updateMany.mock.calls.filter((c: any) => c[0]?.where?.userId === 'u1' && !c[0]?.where?.id);
    const lineageRevokeOf = (rootId: string) =>
      mockPrisma.userSession.updateMany.mock.calls.some((c: any) => c[0]?.where?.id?.in?.includes(rootId));
    const armRenew = () => {
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 }); // conditional claim of B wins
      mockPrisma.userSession.create.mockResolvedValue({});
      mockPrisma.userSession.update.mockResolvedValue({});
      mockPrisma.auditLog.create.mockResolvedValue({});
      mockPrisma.auditLog.count.mockResolvedValue(1);
    };

    it.each([
      ['2 hours', 2 * HOUR],
      ['2 days', 2 * 24 * HOUR],
    ])('C1: app switch — A replayed %s after rotation, B NEVER used, same device → RENEWED FORWARD (fresh pair), stays logged in', async (_l, ago) => {
      mockPrisma.userSession.findFirst.mockResolvedValueOnce(replayedA(ago)).mockResolvedValueOnce(sessionB());
      armRenew();

      const res = await service.refreshToken('rt', { fingerprint: 'fp-device' });
      await service.settleBackgroundWork(); // audit rows are written AFTER the response (H-A b)

      expect(res).toEqual({ accessToken: 'mock.jwt.token', refreshToken: expect.any(String) }); // a FRESH pair, not B's stale one
      // B is claimed CONDITIONALLY (still unused, never handed back) and stamped handedBackAt…
      expect(mockPrisma.userSession.updateMany).toHaveBeenCalledWith({
        where: { id: 'sess_b', revokedAt: null, firstUsedAt: null, handedBackAt: null },
        data: { revokedAt: expect.any(Date), handedBackAt: expect.any(Date) },
      });
      // …and C is minted from B (single lineage), bound to the replaying device.
      const created = mockPrisma.userSession.create.mock.calls[0][0].data;
      expect(created).toMatchObject({ rotatedFromId: 'sess_b', createdFingerprint: 'fp-device' });
      // No kill, no security event; one info audit row with its OWN action.
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      expect(securityEventCalls()).toHaveLength(0);
      expect(handbackAudits()).toHaveLength(1);
      expect(handbackAudits()[0][0].data.action).toBe('REFRESH_HANDOFF');
    });

    it('B USED (firstUsedAt) → strict reuse kill, nothing renewed', async () => {
      mockPrisma.userSession.findFirst
        .mockResolvedValueOnce(replayedA(2 * HOUR))
        .mockResolvedValueOnce(sessionB({ firstUsedAt: new Date(Date.now() - HOUR) }));
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.user.update.mockResolvedValue({});

      await expect(service.refreshToken('rt', { fingerprint: 'fp-device' })).rejects.toThrow('Session expired');
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
      expect(securityEventCalls()).toHaveLength(1);
      expect(securityEventCalls()[0][0].data.metadata.reason).toBe('successor_used');
    });

    it('H-A (c): replay from a DIFFERENT device class → 401 for THIS device only + SECURITY_EVENT — NO all-device kill', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValueOnce(replayedA(2 * HOUR)).mockResolvedValueOnce(sessionB());
      mockPrisma.auditLog.create.mockResolvedValue({});

      await expect(service.refreshToken('rt', { fingerprint: 'fp-attacker' })).rejects.toThrow('Session expired');
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
      expect(mockPrisma.user.update).not.toHaveBeenCalled(); // no stamp
      expect(revokeAllCalls()).toHaveLength(0); // no revoke-all…
      expect(lineageRevokeOf('sess_a')).toBe(true); // …only THIS lineage ends
      expect(securityEventCalls()).toHaveLength(0); // NOT a reuse kill…
      const alarms = mockPrisma.auditLog.create.mock.calls.filter((c: any) => c[0]?.data?.entityType === 'SECURITY_EVENT');
      expect(alarms).toHaveLength(1);
      expect(alarms[0][0].data.metadata).toMatchObject({ event: 'refresh_handback_refused', reason: 'device_mismatch' });
    });

    it('M-2: UNKNOWN device (no client fingerprint, e.g. an older frontend) → plain 401, NO kill, NO alarm', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValueOnce(replayedA(2 * HOUR)).mockResolvedValueOnce(sessionB());

      await expect(service.refreshToken('rt', {})).rejects.toThrow('Session expired');
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      expect(mockPrisma.userSession.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('H-A (a): the handback REPLY was lost too — the old token replayed again later, newest tip still UNUSED, same device → renewed AGAIN', async () => {
      mockPrisma.userSession.findFirst
        .mockResolvedValueOnce(replayedA(2 * HOUR))
        .mockResolvedValueOnce(sessionB({ revokedAt: new Date(Date.now() - 60_000), handedBackAt: new Date(Date.now() - 60_000) }))
        .mockResolvedValueOnce(sessionB({ id: 'sess_c', token: 'c.access', refreshToken: 'rt-c', createdFingerprint: 'fp-device' }));
      armRenew();

      await expect(service.refreshToken('rt', { fingerprint: 'fp-device' })).resolves.toMatchObject({ accessToken: 'mock.jwt.token' });
      expect(mockPrisma.userSession.updateMany).toHaveBeenCalledWith({
        where: { id: 'sess_c', revokedAt: null, firstUsedAt: null, handedBackAt: null },
        data: { revokedAt: expect.any(Date), handedBackAt: expect.any(Date) },
      });
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('H-A (a) cap: 5 handbacks in this lineage within 24 h → 401 for this device + SECURITY_EVENT, NO kill', async () => {
      const handed = (id: string, agoMs: number) =>
        sessionB({ id, revokedAt: new Date(Date.now() - agoMs), handedBackAt: new Date(Date.now() - agoMs) });
      mockPrisma.userSession.findFirst
        .mockResolvedValueOnce(replayedA(10 * HOUR))
        .mockResolvedValueOnce(handed('h1', 9 * HOUR))
        .mockResolvedValueOnce(handed('h2', 7 * HOUR))
        .mockResolvedValueOnce(handed('h3', 5 * HOUR))
        .mockResolvedValueOnce(handed('h4', 3 * HOUR))
        .mockResolvedValueOnce(handed('h5', 1 * HOUR))
        .mockResolvedValueOnce(sessionB({ id: 'tip' }));
      mockPrisma.auditLog.create.mockResolvedValue({});

      await expect(service.refreshToken('rt', { fingerprint: 'fp-device' })).rejects.toThrow('Session expired');
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      const alarm = mockPrisma.auditLog.create.mock.calls.find((c: any) => c[0]?.data?.entityType === 'SECURITY_EVENT');
      expect(alarm![0].data.metadata).toMatchObject({ event: 'refresh_handback_refused', reason: 'handback_cap_reached' });
      expect(revokeAllCalls()).toHaveLength(0);
      expect(lineageRevokeOf('sess_a')).toBe(true);
    });

    it('LOW1: a token that was ITSELF handed back (outside its 6 s window) cannot take a newer session → 401 + SECURITY_EVENT, no kill', async () => {
      mockPrisma.userSession.findFirst
        .mockResolvedValueOnce({ ...replayedA(2 * HOUR), handedBackAt: new Date(Date.now() - 60_000) })
        .mockResolvedValueOnce(sessionB());
      mockPrisma.auditLog.create.mockResolvedValue({});

      await expect(service.refreshToken('rt', { fingerprint: 'fp-device' })).rejects.toThrow('Session expired');
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      const alarm = mockPrisma.auditLog.create.mock.calls.find((c: any) => c[0]?.data?.entityType === 'SECURITY_EVENT');
      expect(alarm![0].data.metadata).toMatchObject({ reason: 'handed_back_token_replayed' });
      expect(revokeAllCalls()).toHaveLength(0);
      expect(lineageRevokeOf('sess_a')).toBe(true);
    });

    it('M-1: within 6 s of a handback the lineage converges EVEN IF the tip was already used (grace before the used check) + LOW2 repeat audit', async () => {
      mockPrisma.userSession.findFirst
        .mockResolvedValueOnce(replayedA(2 * HOUR))
        .mockResolvedValueOnce(sessionB({ revokedAt: new Date(Date.now() - 1_000), handedBackAt: new Date(Date.now() - 1_000) }))
        .mockResolvedValueOnce(sessionB({ id: 'sess_c', token: 'c.access', refreshToken: 'rt-c', firstUsedAt: new Date() }));
      mockPrisma.auditLog.create.mockResolvedValue({});

      await expect(service.refreshToken('rt', { fingerprint: 'fp-device' })).resolves.toEqual({ accessToken: 'c.access', refreshToken: 'rt-c' });
      await service.settleBackgroundWork();
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      const repeats = mockPrisma.auditLog.create.mock.calls.filter((c: any) => c[0]?.data?.metadata?.event === 'REFRESH_HANDOFF_REPEAT');
      expect(repeats).toHaveLength(1);
      expect(repeats[0][0].data).toMatchObject({ entityType: 'AUTH_EVENT', action: 'REFRESH_HANDOFF' });
    });

    it('S-H1b: a concurrent replay of the SAME resume (within grace of the handback) converges on the renewed pair', async () => {
      mockPrisma.userSession.findFirst
        .mockResolvedValueOnce(replayedA(2 * HOUR))
        .mockResolvedValueOnce(sessionB({ revokedAt: new Date(Date.now() - 1_000), handedBackAt: new Date(Date.now() - 1_000) }))
        .mockResolvedValueOnce(sessionB({ id: 'sess_c', token: 'c.access', refreshToken: 'rt-c' }));

      await expect(service.refreshToken('rt', { fingerprint: 'fp-device' })).resolves.toEqual({ accessToken: 'c.access', refreshToken: 'rt-c' });
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
      expect(securityEventCalls()).toHaveLength(0);
    });

    it('S-H1b: the conditional claim LOSES to a concurrent handback → re-evaluated → converges on its pair', async () => {
      mockPrisma.userSession.findFirst
        .mockResolvedValueOnce(replayedA(2 * HOUR))
        .mockResolvedValueOnce(sessionB()) // first walk: B live + unused
        .mockResolvedValueOnce(sessionB({ revokedAt: new Date(), handedBackAt: new Date() })) // re-walk: B handed back…
        .mockResolvedValueOnce(sessionB({ id: 'sess_c', token: 'c.access', refreshToken: 'rt-c' })); // …into C
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 0 }); // our conditional claim lost

      await expect(service.refreshToken('rt', { fingerprint: 'fp-device' })).resolves.toEqual({ accessToken: 'c.access', refreshToken: 'rt-c' });
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
      expect(securityEventCalls()).toHaveLength(0);
    });

    it.each([
      [4, 0],
      [5, 1],
    ])('S-H1c: %i handbacks for the user within 24 h → %i SECURITY_EVENT (threshold 5); the renewal itself never waits for it', async (count, alarms) => {
      mockPrisma.userSession.findFirst.mockResolvedValueOnce(replayedA(2 * HOUR)).mockResolvedValueOnce(sessionB());
      armRenew();
      mockPrisma.auditLog.count.mockResolvedValue(count);

      await expect(service.refreshToken('rt', { fingerprint: 'fp-device' })).resolves.toMatchObject({ accessToken: 'mock.jwt.token' });
      await service.settleBackgroundWork();
      expect(repeatAlarms()).toHaveLength(alarms);
    });

    it('H-A (b): NOTHING after the commit — a hanging audit write never delays the renewed pair; a failing one is counted', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValueOnce(replayedA(2 * HOUR)).mockResolvedValueOnce(sessionB());
      armRenew();
      mockPrisma.auditLog.create.mockImplementationOnce(() => new Promise(() => undefined)); // never settles

      await expect(service.refreshToken('rt', { fingerprint: 'fp-device' })).resolves.toMatchObject({ accessToken: 'mock.jwt.token' });

      mockPrisma.userSession.findFirst.mockResolvedValueOnce(replayedA(2 * HOUR)).mockResolvedValueOnce(sessionB());
      mockPrisma.auditLog.create.mockRejectedValueOnce(new Error('audit db down'));
      const before = service.handbackAuditFailures;
      await expect(service.refreshToken('rt', { fingerprint: 'fp-device' })).resolves.toMatchObject({ accessToken: 'mock.jwt.token' });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(service.handbackAuditFailures).toBe(before + 1);
    });

    it('B naturally expired (30-day window lapsed) → plain 401, NO kill, NO security event', async () => {
      mockPrisma.userSession.findFirst
        .mockResolvedValueOnce(replayedA(31 * 24 * HOUR))
        .mockResolvedValueOnce(sessionB({ expiresAt: new Date(Date.now() - 1_000) }));

      await expect(service.refreshToken('rt', { fingerprint: 'fp-device' })).rejects.toThrow('Session expired');
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      expect(securityEventCalls()).toHaveLength(0);
    });

    it('a failed info-audit write never blocks the renewal', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValueOnce(replayedA(2 * HOUR)).mockResolvedValueOnce(sessionB());
      armRenew();
      mockPrisma.auditLog.create.mockRejectedValueOnce(new Error('audit db down'));

      await expect(service.refreshToken('rt', { fingerprint: 'fp-device' })).resolves.toMatchObject({ accessToken: 'mock.jwt.token' });
    });

    it('a holder refresh records the device fingerprint on the new session (S-H1a binding source)', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue(rotated30sAgoLive());
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.userSession.create.mockResolvedValue({});

      await service.refreshToken('rt', { fingerprint: 'fp-device' });
      expect(mockPrisma.userSession.create.mock.calls[0][0].data.createdFingerprint).toBe('fp-device');
    });
    const rotated30sAgoLive = () => ({
      id: 'sess_x', clientId: 'deoleo', refreshToken: 'rt', revokedAt: null,
      createdAt: new Date(Date.now() - HOUR), expiresAt: new Date(Date.now() + HOUR),
      user: { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P', sessionsInvalidBefore: null },
    });

    it('in-grace loser (revoked < 5s ago, no live successor) writes NO SECURITY_EVENT row', async () => {
      const recentlyRevoked = {
        id: 'sess_x', clientId: 'deoleo', refreshToken: 'rt',
        revokedAt: new Date(Date.now() - 1_000), // 1s ago — INSIDE the 5s grace
        createdAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 3600_000),
        user: { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P', sessionsInvalidBefore: null },
      };
      mockPrisma.userSession.findFirst
        .mockResolvedValueOnce(recentlyRevoked)
        .mockResolvedValueOnce(null);

      await expect(service.refreshToken('rt')).rejects.toThrow('Session expired');
      // Transient in-grace loser → not reuse → no lineage kill, no security-event row.
      expect(mockPrisma.userSession.updateMany).not.toHaveBeenCalled();
      expect(securityEventCalls()).toHaveLength(0);
    });
  });

  // â”€â”€ Fixed OTP mode â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  // ── assumeTenant (A2 operator-context switcher, #51) ────────────────────────
  describe('assumeTenant', () => {
    beforeEach(() => {
      mockPrisma.client.findFirst.mockResolvedValue({ id: 'deoleo', internalName: 'Deoleo' });
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'op1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '98', name: 'Op' });
      mockPrisma.userSession.create.mockResolvedValue({});
      mockPrisma.auditLog.create.mockResolvedValue({});
    });

    it('mints a token scoped to the target tenant, keeping the GIFSY role + real operator sub', async () => {
      const res = await service.assumeTenant(gifsyOp, 'deoleo');
      expect(res.clientId).toBe('deoleo');
      expect(res.brandName).toBe('Deoleo');
      // the JWT payload carries the assumed tenant + assumed flag, sub stays the operator
      const payload = mockJwt.sign.mock.calls[0][0];
      expect(payload).toMatchObject({ sub: 'op1', role: 'GIFSY_ADMIN', clientId: 'deoleo', assumed: true });
      // the session row is bound to the assumed tenant
      expect(mockPrisma.userSession.create.mock.calls[0][0].data.clientId).toBe('deoleo');
      // the tenant lookup admits ACTIVE + ONBOARDING (configure-before-activate),
      // but excludes INACTIVE.
      expect(mockPrisma.client.findFirst.mock.calls[0][0].where).toEqual({
        id: 'deoleo',
        status: { in: ['ACTIVE', 'ONBOARDING'] },
      });
    });

    it('lets an operator assume an ONBOARDING tenant (configure before activating)', async () => {
      mockPrisma.client.findFirst.mockResolvedValue({ id: 'clientb', internalName: 'Client B' });
      const res = await service.assumeTenant(gifsyOp, 'clientb');
      expect(res.clientId).toBe('clientb');
      // The where admits ONBOARDING, so the (mocked) row is returned and assume succeeds.
      expect(mockPrisma.client.findFirst.mock.calls[0][0].where.status).toEqual({
        in: ['ACTIVE', 'ONBOARDING'],
      });
    });

    it('cannot assume an INACTIVE tenant (excluded by the status filter → 404)', async () => {
      // An INACTIVE tenant never matches `status IN (ACTIVE, ONBOARDING)`, so the
      // findFirst resolves null exactly as it would for a disabled tenant.
      mockPrisma.client.findFirst.mockResolvedValue(null);
      await expect(service.assumeTenant(gifsyOp, 'old-inactive')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('audit-logs the assume, attributed to the real operator', async () => {
      await service.assumeTenant(gifsyOp, 'deoleo');
      const audit = mockPrisma.auditLog.create.mock.calls[0][0].data;
      expect(audit.actorId).toBe('op1');
      expect(audit.metadata).toMatchObject({ event: 'ASSUME_TENANT', fromClientId: 'gifsy', toClientId: 'deoleo' });
    });

    it('refuses a non-GIFSY caller (403)', async () => {
      const clientAdmin = { ...gifsyOp, role: 'CLIENT_ADMIN', clientId: 'deoleo' };
      await expect(service.assumeTenant(clientAdmin, 'clientb')).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('404s an unknown/inactive tenant', async () => {
      mockPrisma.client.findFirst.mockResolvedValue(null);
      await expect(service.assumeTenant(gifsyOp, 'no-such')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('400s assuming the operator’s own context', async () => {
      await expect(service.assumeTenant(gifsyOp, 'gifsy')).rejects.toBeInstanceOf(BadRequestException);
    });

    // ── RBAC Option-X (P5) — GIFSY_STAFF may assume ONLY a granted tenant (authoritative check) ──
    it('P5: a GIFSY_STAFF WITHOUT a grant for the target is refused (403), authoritative uncached check', async () => {
      const staff = { ...gifsyOp, role: 'GIFSY_STAFF', sub: 'st1', clientId: 'gifsy' };
      mockGrants.hasGrantUncached.mockResolvedValueOnce(false);
      await expect(service.assumeTenant(staff, 'deoleo')).rejects.toBeInstanceOf(ForbiddenException);
      // Authorized via the uncached DB check (not the 30s cache), keyed on the staff + target.
      expect(mockGrants.hasGrantUncached).toHaveBeenCalledWith('st1', 'deoleo');
      expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('P5: a GIFSY_STAFF WITH a grant assumes the tenant — token pinned, role stays GIFSY_STAFF', async () => {
      const staff = { ...gifsyOp, role: 'GIFSY_STAFF', sub: 'st1', clientId: 'gifsy' };
      mockGrants.hasGrantUncached.mockResolvedValueOnce(true);
      mockPrisma.user.findFirst.mockResolvedValue({
        id: 'st1', role: 'GIFSY_STAFF', clientId: 'gifsy', phone: '97', name: 'Staff', gifsyRoleId: 'r1',
      });
      const res = await service.assumeTenant(staff, 'deoleo');
      expect(res.clientId).toBe('deoleo');
      const payload = mockJwt.sign.mock.calls[0][0];
      expect(payload).toMatchObject({ sub: 'st1', role: 'GIFSY_STAFF', clientId: 'deoleo', assumed: true });
    });
  });

  describe('FIXED_OTP mode', () => {
    it('should accept fixed OTP regardless of stored code when FIXED_OTP env is set', async () => {
      // Override config to return FIXED_OTP
      mockConfig.get.mockImplementation((key: string) => {
        if (key === 'FIXED_OTP') return '1234';
        const cfg: Record<string, string> = {
          JWT_SECRET: 'test-secret', JWT_EXPIRES_IN: '60m',
          MSG91_AUTH_KEY: 'key', MSG91_SENDER_ID: 'GIFSY', MSG91_OTP_TEMPLATE_ID: 'tmpl',
        };
        return cfg[key];
      });

      const otpWithDifferentCode = { id: 'otp_1', code: '9999', attempts: 0, maxAttempts: 3, expiresAt: new Date(Date.now() + 60000), verifiedAt: null };
      mockPrisma.otpCode.findFirst.mockResolvedValue(otpWithDifferentCode);
      mockPrisma.otpCode.update.mockResolvedValue({});
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'user_1', role: 'RETAILER', clientId: 'deoleo', status: 'ACTIVE' });
      mockPrisma.user.update.mockResolvedValue({});
      mockPrisma.userSession.create.mockResolvedValue({ id: 'sess_1' });

      // code in DB is '9999' but FIXED_OTP is '1234' â€” should accept '1234'
      const result = await service.verifyOtp('9876543210', '1234', 'deoleo');
      expect(result.accessToken).toBe('mock.jwt.token');
    });

    it('should reject even fixed OTP if the submitted code does not match it', async () => {
      mockConfig.get.mockImplementation((key: string): any => key === 'FIXED_OTP' ? '1234' : undefined);
      const record = { id: 'otp_1', code: '9999', attempts: 0, maxAttempts: 3, expiresAt: new Date(Date.now() + 60000), verifiedAt: null };
      mockPrisma.otpCode.findFirst.mockResolvedValue(record);
      mockPrisma.otpCode.update.mockResolvedValue({});

      // '5678' is neither the stored code nor the fixed OTP
      await expect(service.verifyOtp('9876543210', '5678', 'deoleo')).rejects.toThrow('Invalid OTP');
    });

    it('REFUSES to honor FIXED_OTP in production (defense-in-depth NODE_ENV guard)', async () => {
      const prev = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        // Even with FIXED_OTP=1234 configured, prod must fall back to the stored code.
        mockConfig.get.mockImplementation((key: string): any => key === 'FIXED_OTP' ? '1234' : undefined);
        const record = { id: 'otp_1', code: '9999', attempts: 0, maxAttempts: 3, expiresAt: new Date(Date.now() + 60000), verifiedAt: null };
        mockPrisma.otpCode.findFirst.mockResolvedValue(record);
        mockPrisma.otpCode.update.mockResolvedValue({});

        // Submitting the would-be fixed OTP must be rejected — only the real stored code works.
        await expect(service.verifyOtp('9876543210', '1234', 'deoleo')).rejects.toThrow('Invalid OTP');
      } finally {
        process.env.NODE_ENV = prev;
      }
    });

    it('HONORS FIXED_OTP in production-NODE_ENV staging when ALLOW_FIXED_OTP=true (the opt-in)', async () => {
      const prevEnv = process.env.NODE_ENV;
      const prevFlag = process.env.ALLOW_FIXED_OTP;
      const prevDb = process.env.DATABASE_URL;
      process.env.NODE_ENV = 'production';
      process.env.ALLOW_FIXED_OTP = 'true';
      process.env.DATABASE_URL = 'postgresql://u:p@h/gifsy_staging'; // not the prod DB
      try {
        mockConfig.get.mockImplementation((key: string): any => key === 'FIXED_OTP' ? '1234' : undefined);
        const record = { id: 'otp_1', code: '9999', attempts: 0, maxAttempts: 3, expiresAt: new Date(Date.now() + 60000), verifiedAt: null };
        mockPrisma.otpCode.findFirst.mockResolvedValue(record);
        mockPrisma.otpCode.update.mockResolvedValue({});
        mockPrisma.user.findFirst.mockResolvedValue({ id: 'user_1', role: 'RETAILER', clientId: 'deoleo', status: 'ACTIVE' });
        mockPrisma.user.update.mockResolvedValue({});
        mockPrisma.userSession.create.mockResolvedValue({ id: 'sess_1' });

        // staging opt-in: the fixed OTP is accepted even though NODE_ENV=production
        const result = await service.verifyOtp('9876543210', '1234', 'deoleo');
        expect(result.accessToken).toBe('mock.jwt.token');
      } finally {
        process.env.NODE_ENV = prevEnv;
        if (prevFlag === undefined) delete process.env.ALLOW_FIXED_OTP; else process.env.ALLOW_FIXED_OTP = prevFlag;
        if (prevDb === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prevDb;
      }
    });

    it('still HARD-refuses FIXED_OTP when ALLOW_FIXED_OTP=true but the DB is prod', async () => {
      const prevEnv = process.env.NODE_ENV;
      const prevFlag = process.env.ALLOW_FIXED_OTP;
      const prevDb = process.env.DATABASE_URL;
      process.env.NODE_ENV = 'production';
      process.env.ALLOW_FIXED_OTP = 'true';
      process.env.DATABASE_URL = 'postgresql://u:p@h/gifsy_prod';
      try {
        mockConfig.get.mockImplementation((key: string): any => key === 'FIXED_OTP' ? '1234' : undefined);
        const record = { id: 'otp_1', code: '9999', attempts: 0, maxAttempts: 3, expiresAt: new Date(Date.now() + 60000), verifiedAt: null };
        mockPrisma.otpCode.findFirst.mockResolvedValue(record);
        mockPrisma.otpCode.update.mockResolvedValue({});
        await expect(service.verifyOtp('9876543210', '1234', 'deoleo')).rejects.toThrow('Invalid OTP');
      } finally {
        process.env.NODE_ENV = prevEnv;
        if (prevFlag === undefined) delete process.env.ALLOW_FIXED_OTP; else process.env.ALLOW_FIXED_OTP = prevFlag;
        if (prevDb === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prevDb;
      }
    });
  });

  describe('Business rule constants', () => {
    it('should have POINTS_TO_PAISE conversion of 100 (1 point = ₹1)', () => {
      expect(AuthService.POINTS_TO_PAISE).toBe(100);
    });
  });
});

/**
 * A one-OtpCode-row fake for updateMany (2026-11-10): honours the claim (attempts < max, unverified),
 * the refund (decrement) and the conditional "mark used" (verifiedAt: null → set once). Interleaves
 * callers so parallel verifies race exactly as they would against the DB's row-level serialisation.
 */
function simulateOtpRow(db: { $queryRaw: jest.Mock; otpCode: { updateMany: jest.Mock } }, maxAttempts = 3) {
  const row = { attempts: 0, verifiedAt: null as Date | null, marks: 0 };
  // The claim: ONE `UPDATE … WHERE id AND verifiedAt IS NULL AND attempts < $max RETURNING attempts`.
  db.$queryRaw.mockImplementation(async (q: any) => {
    await new Promise((r) => setImmediate(r));
    const max = q.values?.[1] ?? maxAttempts;
    if (row.verifiedAt || !(row.attempts < max)) return [];
    row.attempts++;
    return [{ attempts: row.attempts }];
  });
  const updateMany = db.otpCode.updateMany;
  updateMany.mockImplementation(async ({ where, data }: any) => {
    await new Promise((r) => setImmediate(r));
    if (data?.verifiedAt) {
      if (where?.verifiedAt === null && row.verifiedAt) return { count: 0 };
      row.verifiedAt = data.verifiedAt; row.marks++; return { count: 1 };
    }
    if (data?.attempts?.increment) {
      if (row.verifiedAt && where?.verifiedAt === null) return { count: 0 };
      if (row.attempts < (where?.attempts?.lt ?? maxAttempts)) { row.attempts++; return { count: 1 }; }
      return { count: 0 };
    }
    if (data?.attempts?.decrement) { if (row.attempts > 0) row.attempts--; return { count: 1 }; }
    return { count: 1 };
  });
  return row;
}
