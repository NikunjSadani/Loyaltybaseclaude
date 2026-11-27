// Unit tests for NotificationTemplatesService — the per-tenant notification-templates config
// store + resolver. Mocked Prisma + a mocked AdminCoreService (the settings write path).
// Run: npx jest src/notification-templates/notification-templates.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { NotificationTemplatesService } from './notification-templates.service';
import { PrismaService } from '../prisma/prisma.service';
import { AdminCoreService } from '../admin-core/admin-core.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import {
  NOTIFICATION_TEMPLATES_SETTING_KEY,
  whatsappTemplateDefault,
} from './notification-templates.config';

const mockPrisma = {
  programSetting: { findUnique: jest.fn() },
};
const mockAdminCore = { upsertSetting: jest.fn() };

const owner: JwtPayload = {
  sub: 'u1',
  role: 'GIFSY_ADMIN',
  clientId: 'deoleo',
  phone: '',
  name: '',
  assumed: true,
};
const staff: JwtPayload = {
  sub: 'u2',
  role: 'GIFSY_STAFF' as never,
  clientId: 'deoleo',
  phone: '',
  name: '',
} as JwtPayload;
const clientAdmin: JwtPayload = { sub: 'u3', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '', name: '' };

describe('NotificationTemplatesService', () => {
  let service: NotificationTemplatesService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockAdminCore.upsertSetting.mockResolvedValue({ setting: { id: 's1' } });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationTemplatesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AdminCoreService, useValue: mockAdminCore },
      ],
    }).compile();
    service = module.get(NotificationTemplatesService);
  });

  // ── Defaults / seeding ──────────────────────────────────────────────────────
  describe('defaults + WHATSAPP_KYC seeding', () => {
    it('DEOLEO PRESERVATION: the 4 live events default to WHATSAPP-on (masterWhatsapp ON) so a no-DB-row tenant sends exactly as today; SMS stays OFF', async () => {
      mockPrisma.programSetting.findUnique.mockResolvedValueOnce(null);
      const cfg = await service.getConfig('deoleo');
      // masterWhatsapp defaults ON for a WHATSAPP_KYC tenant; SMS master stays OFF (new channel).
      expect(cfg.masterSms).toBe(false);
      expect(cfg.masterWhatsapp).toBe(true);
      // The 4 events that send LIVE WhatsApp today default to mode WHATSAPP + their seeded template.
      expect(cfg.events.KYC_SUBMITTED.mode).toBe('WHATSAPP');
      expect(cfg.events.KYC_SUBMITTED.whatsappTemplate).toBe('deoleo_kyc_submission');
      expect(cfg.events.KYC_APPROVED.mode).toBe('WHATSAPP');
      expect(cfg.events.KYC_APPROVED.whatsappTemplate).toBe('deoleo_kyc_approval');
      expect(cfg.events.POINTS_CREDITED.mode).toBe('WHATSAPP');
      expect(cfg.events.POINTS_CREDITED.whatsappTemplate).toBe('deoleo_points_credit');
      expect(cfg.events.PAYOUT_CREDITED.mode).toBe('WHATSAPP');
      expect(cfg.events.PAYOUT_CREDITED.whatsappTemplate).toBe('deoleo_payout_credit');
      expect(whatsappTemplateDefault('deoleo', 'KYC_APPROVED')).toBe('deoleo_kyc_approval');
      // SMS is OFF everywhere by default (a brand-new channel).
      expect(cfg.events.KYC_APPROVED.smsTemplateId).toBe('');
      // A non-live event defaults OFF with an empty template.
      expect(cfg.events.ORDER_DELIVERED.mode).toBe('OFF');
      expect(cfg.events.ORDER_DELIVERED.whatsappTemplate).toBe('');
      // KYC_REJECTED / KYC_UNDER_REVIEW are config events but NOT live today → default OFF.
      expect(cfg.events.KYC_REJECTED.mode).toBe('OFF');
      expect(cfg.events.KYC_UNDER_REVIEW.mode).toBe('OFF');
    });

    it('an UNKNOWN tenant gets empty WhatsApp seeds, all events OFF, and masterWhatsapp OFF', async () => {
      mockPrisma.programSetting.findUnique.mockResolvedValueOnce(null);
      const cfg = await service.getConfig('acme');
      expect(cfg.masterWhatsapp).toBe(false);
      expect(cfg.masterSms).toBe(false);
      expect(cfg.events.KYC_SUBMITTED.whatsappTemplate).toBe('');
      expect(cfg.events.KYC_SUBMITTED.mode).toBe('OFF');
      expect(cfg.events.KYC_APPROVED.mode).toBe('OFF');
    });

    it('VOUCHER_ISSUED defaults to BOTH for EVERY tenant (transactional voucher code → both channels) with the voucher_code template', async () => {
      mockPrisma.programSetting.findUnique.mockResolvedValue(null);
      for (const t of ['deoleo', 'bajaj', 'acme']) {
        const cfg = await service.getConfig(t);
        expect(cfg.events.VOUCHER_ISSUED.mode).toBe('BOTH');
        expect(cfg.events.VOUCHER_ISSUED.whatsappTemplate).toBe('voucher_code');
      }
    });
  });

  // ── DB-over-default merge ───────────────────────────────────────────────────
  describe('getChannelConfig — DB over defaults', () => {
    it('a stored config OVERRIDES the default (mode + templates) for the specified event', async () => {
      mockPrisma.programSetting.findUnique.mockResolvedValue({
        settingValue: {
          masterSms: true,
          masterWhatsapp: true,
          events: {
            KYC_SUBMITTED: { mode: 'BOTH', whatsappTemplate: 'custom_wa', smsTemplateId: 'SMS123' },
          },
        },
      });
      const resolved = await service.getChannelConfig('deoleo', 'KYC_SUBMITTED');
      expect(resolved).toEqual({
        mode: 'BOTH',
        whatsappTemplate: 'custom_wa',
        smsTemplateId: 'SMS123',
        masterSms: true,
        masterWhatsapp: true,
      });
    });

    it('an event NOT in the stored config falls back to its default (deoleo KYC_APPROVED → WHATSAPP + seed)', async () => {
      mockPrisma.programSetting.findUnique.mockResolvedValue({
        settingValue: { masterSms: true, masterWhatsapp: false, events: { KYC_SUBMITTED: { mode: 'SMS' } } },
      });
      const resolved = await service.getChannelConfig('deoleo', 'KYC_APPROVED');
      expect(resolved.mode).toBe('WHATSAPP'); // deoleo default for a live event
      expect(resolved.whatsappTemplate).toBe('deoleo_kyc_approval'); // seeded default kept
      expect(resolved.masterSms).toBe(true); // master still comes from the stored config
      expect(resolved.masterWhatsapp).toBe(false); // stored master overrides the default (ON→OFF)
    });

    it('a blank stored whatsappTemplate keeps the seeded default (not blanked)', async () => {
      mockPrisma.programSetting.findUnique.mockResolvedValue({
        settingValue: { masterSms: false, masterWhatsapp: true, events: { KYC_SUBMITTED: { mode: 'WHATSAPP', whatsappTemplate: '' } } },
      });
      const resolved = await service.getChannelConfig('deoleo', 'KYC_SUBMITTED');
      expect(resolved.mode).toBe('WHATSAPP');
      expect(resolved.whatsappTemplate).toBe('deoleo_kyc_submission');
    });
  });

  // ── Fail-safe ───────────────────────────────────────────────────────────────
  describe('fail-safe on malformed / absent / unreadable', () => {
    it('absent row → deoleo live-event defaults (WHATSAPP + seed)', async () => {
      mockPrisma.programSetting.findUnique.mockResolvedValue(null);
      const r = await service.getChannelConfig('deoleo', 'KYC_SUBMITTED');
      expect(r.mode).toBe('WHATSAPP');
      expect(r.whatsappTemplate).toBe('deoleo_kyc_submission');
      // A non-live config event still defaults OFF even for a WHATSAPP_KYC tenant.
      const rr = await service.getChannelConfig('deoleo', 'KYC_REJECTED');
      expect(rr.mode).toBe('OFF');
    });

    it('malformed settingValue (not an object) → defaults, never throws', async () => {
      mockPrisma.programSetting.findUnique.mockResolvedValue({ settingValue: 'garbage' });
      await expect(service.getChannelConfig('deoleo', 'KYC_SUBMITTED')).resolves.toMatchObject({ mode: 'WHATSAPP' });
    });

    it('a bad mode / bad master types are IGNORED (kept default), never throws', async () => {
      mockPrisma.programSetting.findUnique.mockResolvedValue({
        settingValue: { masterSms: 'yes', masterWhatsapp: 1, events: { KYC_SUBMITTED: { mode: 'LOUD' } } },
      });
      const r = await service.getChannelConfig('deoleo', 'KYC_SUBMITTED');
      expect(r.mode).toBe('WHATSAPP'); // 'LOUD' is not a valid mode → kept deoleo default (WHATSAPP)
      expect(r.masterSms).toBe(false); // 'yes' is not a boolean → default (false)
      expect(r.masterWhatsapp).toBe(true); // 1 is not a boolean → kept deoleo default (true)
    });

    it('a DB read error → defaults, never throws', async () => {
      mockPrisma.programSetting.findUnique.mockRejectedValue(new Error('db down'));
      await expect(service.getChannelConfig('deoleo', 'KYC_SUBMITTED')).resolves.toMatchObject({ mode: 'WHATSAPP' });
    });

    it('an unknown event key resolves to a safe OFF default', async () => {
      mockPrisma.programSetting.findUnique.mockResolvedValue(null);
      const r = await service.getChannelConfig('deoleo', 'NOT_AN_EVENT');
      expect(r).toMatchObject({ mode: 'OFF', whatsappTemplate: '', smsTemplateId: '' });
    });
  });

  // ── Owner-only at the data boundary ─────────────────────────────────────────
  describe('saveConfig — owner-only at the data boundary', () => {
    const validBody = {
      masterSms: true,
      masterWhatsapp: true,
      events: { KYC_SUBMITTED: { mode: 'SMS', smsTemplateId: 'S1' } },
    };

    it('a GIFSY_STAFF caller is FORBIDDEN (never writes)', async () => {
      await expect(service.saveConfig(staff, validBody)).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockAdminCore.upsertSetting).not.toHaveBeenCalled();
    });

    it('a CLIENT_ADMIN caller is FORBIDDEN (never writes)', async () => {
      await expect(service.saveConfig(clientAdmin, validBody)).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockAdminCore.upsertSetting).not.toHaveBeenCalled();
    });

    it('a GIFSY_ADMIN writes via upsertSetting under the assumed tenant with the right key', async () => {
      mockPrisma.programSetting.findUnique.mockResolvedValue(null); // for the post-write getConfig
      await service.saveConfig(owner, validBody);
      expect(mockAdminCore.upsertSetting).toHaveBeenCalledTimes(1);
      const [passedUser, dto] = mockAdminCore.upsertSetting.mock.calls[0];
      expect(passedUser.clientId).toBe('deoleo');
      expect(passedUser.sub).toBe('u1'); // operator identity preserved for the audit
      expect(dto.key).toBe(NOTIFICATION_TEMPLATES_SETTING_KEY);
      expect(dto.value.masterSms).toBe(true);
      expect(dto.value.events.KYC_SUBMITTED).toEqual({ mode: 'SMS', whatsappTemplate: '', smsTemplateId: 'S1' });
    });
  });

  // ── Unknown-event rejection + strict write validation ───────────────────────
  describe('saveConfig — strict validation (defense-in-depth beyond the DTO/pipe)', () => {
    it('REJECTS an unknown event key with BadRequest', async () => {
      await expect(
        service.saveConfig(owner, { masterSms: false, masterWhatsapp: false, events: { NOPE: { mode: 'SMS' } } }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockAdminCore.upsertSetting).not.toHaveBeenCalled();
    });

    it('REJECTS an invalid mode with BadRequest', async () => {
      await expect(
        service.saveConfig(owner, { masterSms: false, masterWhatsapp: false, events: { KYC_APPROVED: { mode: 'LOUD' } } }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('REJECTS a non-boolean master with BadRequest', async () => {
      await expect(
        service.saveConfig(owner, { masterSms: 'x', masterWhatsapp: false, events: {} }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('REJECTS an over-long template string with BadRequest', async () => {
      await expect(
        service.saveConfig(owner, {
          masterSms: false,
          masterWhatsapp: false,
          events: { KYC_APPROVED: { mode: 'WHATSAPP', whatsappTemplate: 'x'.repeat(201) } },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts a masters-only body (events omitted) and normalises to an empty events map', async () => {
      mockPrisma.programSetting.findUnique.mockResolvedValue(null);
      await service.saveConfig(owner, { masterSms: true, masterWhatsapp: false });
      const [, dto] = mockAdminCore.upsertSetting.mock.calls[0];
      expect(dto.value.events).toEqual({});
    });
  });

  // ── whatsappVariables override ──────────────────────────────────────────────
  describe('whatsappVariables override', () => {
    const bajajUser: JwtPayload = { ...owner, clientId: 'bajaj' };
    const bajajVars = ['ownerName', 'pointsCredited', 'redeemableBalance', 'dateCredited'];
    const put = (ev: Record<string, unknown>) =>
      service.saveConfig(bajajUser, { masterSms: false, masterWhatsapp: true, events: { POINTS_CREDITED: { mode: 'WHATSAPP', whatsappTemplate: 'bajaj_loyalty_points', ...ev } } });

    it('a valid override is stored verbatim (order kept) and resolved by getChannelConfig', async () => {
      mockPrisma.programSetting.findUnique.mockResolvedValue(null);
      await put({ whatsappVariables: bajajVars });
      const [, dto] = mockAdminCore.upsertSetting.mock.calls[0];
      expect(dto.value.events.POINTS_CREDITED.whatsappVariables).toEqual(bajajVars);

      service.invalidate('bajaj');
      mockPrisma.programSetting.findUnique.mockResolvedValue({ settingValue: dto.value });
      const r = await service.getChannelConfig('bajaj', 'POINTS_CREDITED');
      expect(r).toEqual({
        mode: 'WHATSAPP',
        whatsappTemplate: 'bajaj_loyalty_points',
        smsTemplateId: '',
        masterSms: false,
        masterWhatsapp: true,
        whatsappVariables: bajajVars,
      });
      // GET config (what the panel reads) carries it too.
      expect((await service.getConfig('bajaj')).events.POINTS_CREDITED.whatsappVariables).toEqual(bajajVars);
    });

    it('absent override → NOT stored and NOT resolved (key absent: byte-identical shape)', async () => {
      mockPrisma.programSetting.findUnique.mockResolvedValue(null);
      await put({});
      const [, dto] = mockAdminCore.upsertSetting.mock.calls[0];
      expect('whatsappVariables' in dto.value.events.POINTS_CREDITED).toBe(false);
    });

    it.each(['KYC_SUBMITTED', 'KYC_APPROVED', 'POINTS_CREDITED', 'PAYOUT_CREDITED'])(
      'Deoleo %s with no row → resolver has NO whatsappVariables key',
      async (ev) => {
        mockPrisma.programSetting.findUnique.mockResolvedValue(null);
        const r = await service.getChannelConfig('deoleo', ev);
        expect('whatsappVariables' in r).toBe(false);
        expect('whatsappVariables' in (await service.getConfig('deoleo')).events[ev as 'KYC_SUBMITTED']).toBe(false);
      },
    );

    it.each([
      [[], /must not be empty/],
      [['ownerName', 'utr'], /unknown variable "utr"/],
      [['ownerName', 'ownerName'], /"ownerName" more than once/],
      [Array(11).fill('ownerName'), /at most 10/],
      ['ownerName', /must be an array/],
      [['ownerName', 5], /unknown variable 5/],
    ])('REJECTS %j with a 400 naming the bad entry', async (wv, msg) => {
      const p = put({ whatsappVariables: wv });
      await expect(p).rejects.toBeInstanceOf(BadRequestException);
      await expect(p).rejects.toThrow(msg as RegExp);
      expect(mockAdminCore.upsertSetting).not.toHaveBeenCalled();
    });

    it('a stored but INVALID override is NOT silently replaced: raw value + whatsappVariablesError surfaced (resolver + GET)', async () => {
      mockPrisma.programSetting.findUnique.mockResolvedValue({
        settingValue: { masterSms: false, masterWhatsapp: true, events: { POINTS_CREDITED: { mode: 'WHATSAPP', whatsappVariables: ['ownerName', 'bogus'] } } },
      });
      const r = await service.getChannelConfig('bajaj', 'POINTS_CREDITED');
      expect(r.whatsappVariables).toEqual(['ownerName', 'bogus']);
      expect(r.whatsappVariablesError).toMatch(/unknown variable "bogus"/);
      const ev = (await service.getConfig('bajaj')).events.POINTS_CREDITED;
      expect(ev.whatsappVariables).toEqual(['ownerName', 'bogus']);
      expect(ev.whatsappVariablesError).toMatch(/"bogus"/);
    });

    it('a stored non-array override is surfaced stringified with an error', async () => {
      mockPrisma.programSetting.findUnique.mockResolvedValue({
        settingValue: { masterSms: false, masterWhatsapp: true, events: { POINTS_CREDITED: { mode: 'WHATSAPP', whatsappVariables: 'ownerName' } } },
      });
      const r = await service.getChannelConfig('bajaj', 'POINTS_CREDITED');
      expect(r.whatsappVariables).toEqual(['ownerName']);
      expect(r.whatsappVariablesError).toMatch(/must be an array/);
    });
  });
});
