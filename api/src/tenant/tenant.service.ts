import {
  Injectable, NotFoundException, ForbiddenException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantSettingsService } from './tenant-settings.service';

/**
 * The two supported visibility capture modes for a tenant.
 *   PHOTO_APPROVAL  — field agents submit photos; Gifsy-admin approves/rejects.
 *   AMOUNT_UPLOAD   — Gifsy-admin/Client-admin bulk-uploads visibility amounts via Excel.
 *
 * Default (when the field is absent): PHOTO_APPROVAL.
 */
export type VisibilityCaptureMode = 'PHOTO_APPROVAL' | 'AMOUNT_UPLOAD';

export interface ClientFeatures {
  loyalty:        boolean;
  visibility:     boolean;
  leaderboard:    boolean;
  schemes:        boolean;
  selfEnrollment: boolean;
  targets:        boolean;
  rewards:        boolean;
  tds:            boolean;
  /**
   * Controls which visibility data-capture path is active for the tenant.
   * 'PHOTO_APPROVAL' (default when unset) — app photo-capture + approval workflow.
   * 'AMOUNT_UPLOAD'                        — admin Excel bulk-upload workflow.
   */
  visibilityCaptureMode?: VisibilityCaptureMode;
}

export interface ClientConfig {
  slug:     string;
  name:     string;
  features: ClientFeatures;
  branding: { primaryColor: string; displayName: string; logoUrl?: string };
  isActive: boolean;
}

@Injectable()
export class TenantService {
  private readonly logger = new Logger(TenantService.name);

  // In-memory cache — invalidated when config is updated
  private cache = new Map<string, { config: ClientConfig; cachedAt: number }>();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: TenantSettingsService,
  ) {}

  /**
   * Resolve a client config by slug.
   * Reads from DB (with short-lived cache). GIFSY_ADMIN is the only role
   * that can modify these configs — CLIENT_ADMIN cannot.
   */
  async resolveClient(slug: string): Promise<ClientConfig> {
    const cached = this.cache.get(slug);
    if (cached && Date.now() - cached.cachedAt < this.CACHE_TTL_MS) {
      if (!cached.config.isActive) throw new ForbiddenException(`Client "${slug}" is inactive.`);
      return cached.config;
    }

    const rows = await this.prisma.adminConfig.findMany({
      where: { clientId: slug, key: 'client_config' },
    });

    if (rows.length === 0) {
      throw new NotFoundException(`Unknown client: "${slug}". Contact Gifsy to onboard.`);
    }

    const config = rows[0].value as unknown as ClientConfig;

    if (!config.isActive) {
      throw new ForbiddenException(`Client "${slug}" account is inactive.`);
    }

    this.cache.set(slug, { config, cachedAt: Date.now() });
    return config;
  }

  /**
   * Resolve the visibility capture mode for a tenant.
   * Returns 'PHOTO_APPROVAL' when the field is absent (the default).
   *
   * Usage: inject TenantService and call resolveVisibilityCaptureMode(user.clientId).
   */
  async resolveVisibilityCaptureMode(clientId: string): Promise<VisibilityCaptureMode> {
    try {
      const config = await this.resolveClient(clientId);
      return config.features.visibilityCaptureMode ?? 'PHOTO_APPROVAL';
    } catch {
      // If the client config cannot be resolved (e.g. during tests without a full
      // config row), fall back to the safe default rather than hard-crashing.
      return 'PHOTO_APPROVAL';
    }
  }

  /**
   * Resolve the per-tenant MASTER Visibility switch (program_settings-backed).
   * Returns false (OFF) when unset — visibility is opt-in. Reads UNCACHED so a tenant
   * OFF→ON / ON→OFF flip is honoured immediately across every Cloud Run instance (the
   * per-instance settings cache would otherwise leave the switch stale for up to 5 min
   * on instances that did not serve the write — unacceptable for an enable/kill control).
   * Fails CLOSED (read error / missing row / non-boolean → OFF). Callers 403 when false.
   */
  async resolveVisibilityEnabled(clientId: string): Promise<boolean> {
    return this.settings.getVisibilityEnabledUncached(clientId);
  }

  /** Check if a specific feature is enabled for a client */
  async isFeatureEnabled(clientId: string, feature: string): Promise<boolean> {
    try {
      const config = await this.resolveClient(clientId);
      return Boolean((config.features as any)[feature] ?? false);
    } catch {
      return false;
    }
  }

  /** Invalidate cache for a client (called after config update) */
  invalidateCache(slug: string): void {
    this.cache.delete(slug);
    this.logger.log(`Cache invalidated for client: ${slug}`);
  }

  /** List all client configs — GIFSY_ADMIN only */
  async listAllClients(): Promise<ClientConfig[]> {
    const rows = await this.prisma.adminConfig.findMany({
      where: { key: 'client_config' },
      orderBy: { clientId: 'asc' },
    });
    return rows.map((r) => r.value as unknown as ClientConfig);
  }

  /** Seed initial client config — only callable by GIFSY_ADMIN */
  async upsertClientConfig(slug: string, config: ClientConfig): Promise<void> {
    await this.prisma.adminConfig.upsert({
      where:  { clientId_key: { clientId: slug, key: 'client_config' } } as any,
      create: { clientId: slug, key: 'client_config', value: config as any },
      update: { value: config as any },
    });
    this.invalidateCache(slug);
    this.logger.log(`Client config updated: ${slug}`);
  }
}
