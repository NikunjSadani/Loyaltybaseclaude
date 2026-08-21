/**
 * NotificationTemplatesService — the per-tenant notification-templates config STORE + RESOLVER
 * (Phase 2, config layer).
 *
 * STORAGE: ONE per-tenant `program_settings` row (clientId = the operator's assumed tenant,
 * settingKey = 'notificationTemplates'). The WRITE goes through AdminCoreService.upsertSetting so
 * the existing PROGRAM_SETTINGS config-change AuditLog fires and the shared tenant-settings cache
 * is busted — never a re-implementation of the settings write path.
 *
 * OWNER-ONLY AT THE DATA BOUNDARY: saveConfig re-checks `user.role === 'GIFSY_ADMIN'` before it
 * writes (the controller's @Roles('GIFSY_ADMIN') is the first gate; this is defense-in-depth so a
 * non-owner can never persist a config even if a route were mis-wired). This mirrors how AdminCore
 * re-checks isGifsyOperator on its platform-only settings writes.
 *
 * FAIL-SAFE READS: getConfig / getChannelConfig NEVER throw — a missing/malformed row or an
 * unreadable DB falls back to the typed defaults (mode OFF + the WHATSAPP_KYC-seeded template),
 * so a poisoned config can never break a (future) notification send.
 *
 * NOTE: this is the config layer only. The resolver is EXPORTED for later consumers; no sender is
 * wired to it yet, so today's live WhatsApp behaviour (the untouched WHATSAPP_KYC path) is
 * unchanged by this module.
 */
import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AdminCoreService } from '../admin-core/admin-core.service';
import { UpsertSettingDto } from '../admin-core/dto/settings.dto';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import {
  EventKey,
  NOTIFICATION_TEMPLATES_SETTING_KEY,
  NotificationTemplatesConfig,
  ResolvedChannelConfig,
  mergeConfig,
  validateNotificationTemplatesInput,
} from './notification-templates.config';

@Injectable()
export class NotificationTemplatesService {
  private readonly logger = new Logger(NotificationTemplatesService.name);

  // Per-tenant cache of the merged config. Short TTL + explicit invalidate() on every write.
  private cache = new Map<string, { config: NotificationTemplatesConfig; cachedAt: number }>();
  private readonly CACHE_TTL_MS = 60 * 1000; // 60s; also busted on write via invalidate()

  constructor(
    private readonly prisma: PrismaService,
    private readonly adminCore: AdminCoreService,
  ) {}

  /** Bust the cache for a tenant — called after every write so the new config is visible at once. */
  invalidate(clientId: string): void {
    this.cache.delete(clientId);
  }

  /**
   * The full resolved config for a tenant (DB overlaid on defaults; every EVENT_KEY present).
   * NEVER throws: any read/parse failure falls back to the typed defaults. Cached per clientId.
   */
  async getConfig(clientId: string): Promise<NotificationTemplatesConfig> {
    const cached = this.cache.get(clientId);
    if (cached && Date.now() - cached.cachedAt < this.CACHE_TTL_MS) {
      return cached.config;
    }

    let stored: unknown = null;
    try {
      const row = await this.prisma.programSetting.findUnique({
        where: {
          clientId_settingKey: { clientId, settingKey: NOTIFICATION_TEMPLATES_SETTING_KEY },
        },
        select: { settingValue: true },
      });
      stored = row?.settingValue ?? null;
    } catch (e) {
      // Never let a settings read crash a (future) notification path — fall back to defaults.
      this.logger.warn(`notificationTemplates read failed for ${clientId}; using defaults: ${e}`);
      stored = null;
    }

    const config = mergeConfig(clientId, stored); // lenient, never throws
    this.cache.set(clientId, { config, cachedAt: Date.now() });
    return config;
  }

  /**
   * RESOLVER (exported for later consumers): the channel config for one (clientId, eventKey),
   * plus the two master switches. DB over defaults; NEVER throws — any failure fails safe to
   * OFF + the seeded template. An unknown eventKey resolves to a safe OFF default too.
   */
  async getChannelConfig(clientId: string, eventKey: string): Promise<ResolvedChannelConfig> {
    try {
      const config = await this.getConfig(clientId);
      const ev = config.events[eventKey as EventKey];
      if (!ev) {
        // Unknown/unlisted event — safe OFF default (no template).
        return {
          mode: 'OFF',
          whatsappTemplate: '',
          smsTemplateId: '',
          masterSms: config.masterSms,
          masterWhatsapp: config.masterWhatsapp,
        };
      }
      return {
        mode: ev.mode,
        whatsappTemplate: ev.whatsappTemplate,
        smsTemplateId: ev.smsTemplateId,
        masterSms: config.masterSms,
        masterWhatsapp: config.masterWhatsapp,
      };
    } catch (e) {
      // Belt-and-braces: getConfig already fails soft, but any unexpected throw here must still
      // resolve to a safe OFF default rather than break the caller.
      this.logger.warn(`getChannelConfig(${clientId}, ${eventKey}) failed; resolving OFF: ${e}`);
      return { mode: 'OFF', whatsappTemplate: '', smsTemplateId: '', masterSms: false, masterWhatsapp: false };
    }
  }

  /**
   * Persist the per-tenant config. GIFSY_ADMIN-only re-checked HERE at the data boundary. Strict-
   * validates the input (throws BadRequest naming the field / rejecting unknown event keys), writes
   * under the operator's (assumed) tenant scope via AdminCoreService.upsertSetting (audit + shared
   * cache bust), busts THIS service's cache, and returns the refreshed config.
   */
  async saveConfig(user: JwtPayload, input: unknown): Promise<NotificationTemplatesConfig> {
    // Owner-only at the data boundary — never let a non-owner persist a config even if a route
    // were mis-wired (the controller @Roles('GIFSY_ADMIN') is the first, coarse gate).
    if (user.role !== 'GIFSY_ADMIN') {
      throw new ForbiddenException('Notification templates can only be configured by a Gifsy admin.');
    }

    const normalized = validateNotificationTemplatesInput(
      input,
      (msg) => new BadRequestException(msg),
    );

    const settingDto: UpsertSettingDto = {
      key: NOTIFICATION_TEMPLATES_SETTING_KEY,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      value: normalized as any,
      category: 'notifications',
      description: 'Per-tenant notification-templates config (per-event SMS/WhatsApp channel + template).',
    };

    // Write under the operator's assumed tenant (user.clientId); the real operator identity is
    // preserved for the audit. upsertSetting appends the PROGRAM_SETTINGS AuditLog + busts the
    // tenant-settings cache. allowPlatformOnlyKey opts THIS dedicated, validated path past the
    // generic-PUT block in upsertSetting that forces every notificationTemplates write through here.
    await this.adminCore.upsertSetting(user, settingDto, { allowPlatformOnlyKey: true });

    // Bust THIS service's cache so the new config is effective immediately.
    this.invalidate(user.clientId);

    return this.getConfig(user.clientId);
  }
}
