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
   * Map a `clients` table row to the ClientConfig shape consumers expect.
   *
   * `isActive` = status !== 'INACTIVE', so ACTIVE **and** ONBOARDING both resolve
   * as active (only INACTIVE trips the ForbiddenException gate in resolveClient).
   * `features` is returned AS-IS (the raw JSON blob) — do NOT remap/rename keys;
   * the only dynamically-read keys (rbacEnforcement, visibilityCaptureMode) live
   * directly on `clients.features`, so passing the blob through preserves both.
   */
  private mapClientRow(client: {
    id: string;
    internalName: string;
    status: string;
    branding: unknown;
    features: unknown;
  }): ClientConfig {
    const b = (client.branding ?? {}) as {
      primaryColor?: string;
      displayName?: string;
      logoUrl?: string;
    };
    return {
      slug:     client.id,
      name:     client.internalName,
      isActive: client.status !== 'INACTIVE',
      branding: {
        primaryColor: b.primaryColor ?? '#16a34a',
        displayName:  b.displayName ?? client.internalName,
        logoUrl:      b.logoUrl,
      },
      features: (client.features ?? {}) as unknown as ClientFeatures,
    };
  }

  /**
   * Resolve a client config by slug.
   * Reads from the `clients` table (with short-lived cache). GIFSY_ADMIN is the
   * only role that can modify these configs — CLIENT_ADMIN cannot.
   */
  async resolveClient(slug: string): Promise<ClientConfig> {
    const cached = this.cache.get(slug);
    if (cached && Date.now() - cached.cachedAt < this.CACHE_TTL_MS) {
      if (!cached.config.isActive) throw new ForbiddenException(`Client "${slug}" is inactive.`);
      return cached.config;
    }

    const client = await this.prisma.client.findUnique({ where: { id: slug } });

    if (!client) {
      throw new NotFoundException(`Unknown client: "${slug}". Contact Gifsy to onboard.`);
    }

    const config = this.mapClientRow(client);

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
    const rows = await this.prisma.client.findMany({ orderBy: { id: 'asc' } });
    return rows.map((r) => this.mapClientRow(r));
  }
}
