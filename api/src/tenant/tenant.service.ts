import {
  Injectable, NotFoundException, ForbiddenException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface ClientFeatures {
  loyalty:        boolean;
  visibility:     boolean;
  leaderboard:    boolean;
  schemes:        boolean;
  selfEnrollment: boolean;
  targets:        boolean;
  rewards:        boolean;
  tds:            boolean;
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

  constructor(private readonly prisma: PrismaService) {}

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
