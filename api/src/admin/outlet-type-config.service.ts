import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertOutletTypeConfigDto } from './dto/admin.dto';

// ── Response shape returned by this service ───────────────────────────────────

export interface OutletTypeConfigResponse {
  clientId:           string;
  outletTypeCode:     string;
  outletTypeName:     string;
  isEnabled:          boolean;
  displayName:        string | null;
  loyaltyEnabled:     boolean;
  schemesEnabled:     boolean;
  visibilityEnabled:  boolean;
  payoutsEnabled:     boolean;
  leaderboardEnabled: boolean;
  targetsEnabled:     boolean;
  kycRequired:        boolean;
}

// ── Default flags for when no DB row exists ───────────────────────────────────

const DEFAULT_FLAGS = {
  isEnabled:          true,
  displayName:        null,
  loyaltyEnabled:     true,
  schemesEnabled:     true,
  visibilityEnabled:  true,
  payoutsEnabled:     true,
  leaderboardEnabled: true,
  targetsEnabled:     true,
  kycRequired:        true,
} as const;

@Injectable()
export class OutletTypeConfigService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Return one config entry per active outlet type for the given client.
   * Rows that don't exist in DB are filled with all-true defaults.
   */
  async getAll(clientId: string): Promise<OutletTypeConfigResponse[]> {
    const [types, rows] = await Promise.all([
      this.prisma.outletType.findMany({
        where: { isActive: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.outletTypeClientConfig.findMany({
        where: { clientId },
      }),
    ]);

    // Index existing rows by outletTypeId for O(1) lookup
    const rowMap = new Map(rows.map((r) => [r.outletTypeId, r]));

    return types.filter((t) => t.isActive).map((type) => {
      const row = rowMap.get(type.id);
      return {
        clientId,
        outletTypeCode:     type.code,
        outletTypeName:     type.name,
        isEnabled:          row?.isEnabled          ?? DEFAULT_FLAGS.isEnabled,
        displayName:        row?.displayName        ?? DEFAULT_FLAGS.displayName,
        loyaltyEnabled:     row?.loyaltyEnabled     ?? DEFAULT_FLAGS.loyaltyEnabled,
        schemesEnabled:     row?.schemesEnabled     ?? DEFAULT_FLAGS.schemesEnabled,
        visibilityEnabled:  row?.visibilityEnabled  ?? DEFAULT_FLAGS.visibilityEnabled,
        payoutsEnabled:     row?.payoutsEnabled     ?? DEFAULT_FLAGS.payoutsEnabled,
        leaderboardEnabled: row?.leaderboardEnabled ?? DEFAULT_FLAGS.leaderboardEnabled,
        targetsEnabled:     row?.targetsEnabled     ?? DEFAULT_FLAGS.targetsEnabled,
        kycRequired:        row?.kycRequired        ?? DEFAULT_FLAGS.kycRequired,
      };
    });
  }

  /**
   * Create or update the config for one outlet type + client combination.
   * Only the fields present in dto are changed; others remain at their stored
   * value (or default on first create).
   */
  async upsert(
    clientId:     string,
    code:         string,
    dto:          UpsertOutletTypeConfigDto,
  ): Promise<OutletTypeConfigResponse> {
    const outletType = await this.prisma.outletType.findFirst({
      where: { code, isActive: true },
    });
    if (!outletType) {
      throw new NotFoundException(`Outlet type with code "${code}" not found.`);
    }

    const row = await this.prisma.outletTypeClientConfig.upsert({
      where: {
        clientId_outletTypeId: { clientId, outletTypeId: outletType.id },
      },
      create: {
        clientId,
        outletTypeId:       outletType.id,
        isEnabled:          dto.isEnabled          ?? DEFAULT_FLAGS.isEnabled,
        displayName:        dto.displayName        ?? DEFAULT_FLAGS.displayName,
        loyaltyEnabled:     dto.loyaltyEnabled     ?? DEFAULT_FLAGS.loyaltyEnabled,
        schemesEnabled:     dto.schemesEnabled     ?? DEFAULT_FLAGS.schemesEnabled,
        visibilityEnabled:  dto.visibilityEnabled  ?? DEFAULT_FLAGS.visibilityEnabled,
        payoutsEnabled:     dto.payoutsEnabled     ?? DEFAULT_FLAGS.payoutsEnabled,
        leaderboardEnabled: dto.leaderboardEnabled ?? DEFAULT_FLAGS.leaderboardEnabled,
        targetsEnabled:     dto.targetsEnabled     ?? DEFAULT_FLAGS.targetsEnabled,
        kycRequired:        dto.kycRequired        ?? DEFAULT_FLAGS.kycRequired,
      },
      update: {
        // Only update fields that were explicitly supplied in the dto
        ...(dto.isEnabled          !== undefined && { isEnabled:          dto.isEnabled }),
        ...(dto.displayName        !== undefined && { displayName:        dto.displayName }),
        ...(dto.loyaltyEnabled     !== undefined && { loyaltyEnabled:     dto.loyaltyEnabled }),
        ...(dto.schemesEnabled     !== undefined && { schemesEnabled:     dto.schemesEnabled }),
        ...(dto.visibilityEnabled  !== undefined && { visibilityEnabled:  dto.visibilityEnabled }),
        ...(dto.payoutsEnabled     !== undefined && { payoutsEnabled:     dto.payoutsEnabled }),
        ...(dto.leaderboardEnabled !== undefined && { leaderboardEnabled: dto.leaderboardEnabled }),
        ...(dto.targetsEnabled     !== undefined && { targetsEnabled:     dto.targetsEnabled }),
        ...(dto.kycRequired        !== undefined && { kycRequired:        dto.kycRequired }),
      },
    });

    return {
      clientId:           row.clientId,
      outletTypeCode:     outletType.code,
      outletTypeName:     outletType.name,
      isEnabled:          row.isEnabled,
      displayName:        row.displayName,
      loyaltyEnabled:     row.loyaltyEnabled,
      schemesEnabled:     row.schemesEnabled,
      visibilityEnabled:  row.visibilityEnabled,
      payoutsEnabled:     row.payoutsEnabled,
      leaderboardEnabled: row.leaderboardEnabled,
      targetsEnabled:     row.targetsEnabled,
      kycRequired:        row.kycRequired,
    };
  }
}
