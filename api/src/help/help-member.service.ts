import { Injectable, NotFoundException } from '@nestjs/common';
import type { HelpTopic } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import type { JwtPayload } from '../common/decorators/current-user.decorator';
import { resolveTenantFeatures } from '../common/tenant-features.helper';
import { resolveActivePartnerId } from '../common/partner-group.helper';
import { partnerOutletsWhere } from '../partner/partner-display.helper';
import { HelpMediaService } from './help-media.service';
import { roleFilterAdmits, type HelpAudience } from './help.constants';

/** What a sales rep / partner sees for one guide. */
export interface HelpTopicMemberView {
  id: string;
  title: string;
  description: string | null;
  steps: string[];
  /** Short-lived signed stream URL, or null when the guide has no video (steps only). */
  videoUrl: string | null;
  posterUrl: string | null;
}

/** Message used for every flag-OFF / not-visible refusal (no detail about why). */
const NOT_AVAILABLE = 'Help & videos is not available.';

/**
 * Help & videos — member reads (sales app: audience SALES; partner app: audience PARTNER). The audience is fixed
 * by the CONTROLLER (route + @Roles), never taken from the request. Tenant = the caller's own clientId. Only
 * PUBLISHED, non-deleted topics whose role filter admits the caller are returned. Tenant flag `helpVideos` OFF →
 * 404 (the FE renders no entry point, so a member never reaches this unless they type the URL).
 */
@Injectable()
export class HelpMemberService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantService,
    private readonly media: HelpMediaService,
  ) {}

  private async assertEnabled(clientId: string): Promise<void> {
    const features = await resolveTenantFeatures(this.tenant, clientId);
    if (features.helpVideos !== true) throw new NotFoundException(NOT_AVAILABLE);
  }

  /** Every label the caller carries for role filtering: login role + hierarchy level / outlet-type codes. */
  private async viewerRoles(user: JwtPayload, audience: HelpAudience): Promise<string[]> {
    const roles: string[] = [user.role];
    if (audience === 'SALES') {
      const su = await this.prisma.salesUser.findFirst({
        where: { userId: user.sub, user: { clientId: user.clientId }, deletedAt: null },
        select: { hierarchyLevel: { select: { code: true } } },
      });
      if (su?.hierarchyLevel?.code) roles.push(su.hierarchyLevel.code);
      return roles;
    }
    // PARTNER: the login's OWN partner (no selector) → the outlet types of its outlets.
    const { partnerId } = await resolveActivePartnerId(this.prisma, {
      clientId: user.clientId,
      userSub: user.sub,
      phone: user.phone,
    });
    if (partnerId) {
      const outlets = await this.prisma.outlet.findMany({
        where: partnerOutletsWhere(user.clientId, partnerId),
        select: { outletType: { select: { code: true } } },
      });
      for (const o of outlets) if (o.outletType?.code) roles.push(o.outletType.code);
    }
    return roles;
  }

  private view(t: HelpTopic): HelpTopicMemberView {
    return {
      id: t.id,
      title: t.title,
      description: t.description,
      steps: t.steps,
      videoUrl: t.videoKey ? this.media.mintUrl(t.id, t.clientId, 'video') : null,
      posterUrl: t.posterKey ? this.media.mintUrl(t.id, t.clientId, 'poster') : null,
    };
  }

  private async visibleTopics(user: JwtPayload, audience: HelpAudience): Promise<HelpTopic[]> {
    await this.assertEnabled(user.clientId);
    const [rows, roles] = await Promise.all([
      this.prisma.helpTopic.findMany({
        where: { clientId: user.clientId, audience, isPublished: true, deletedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
      this.viewerRoles(user, audience),
    ]);
    return rows.filter((t) => roleFilterAdmits(t.roles, roles));
  }

  async list(user: JwtPayload, audience: HelpAudience): Promise<{ topics: HelpTopicMemberView[] }> {
    const rows = await this.visibleTopics(user, audience);
    return { topics: rows.map((t) => this.view(t)) };
  }

  async get(user: JwtPayload, audience: HelpAudience, id: string): Promise<HelpTopicMemberView> {
    const rows = await this.visibleTopics(user, audience);
    const t = rows.find((r) => r.id === id);
    if (!t) throw new NotFoundException('Guide not found');
    return this.view(t);
  }
}
