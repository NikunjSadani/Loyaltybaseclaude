import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import {
  CreateWhatsappTemplateDto,
  UpdateWhatsappTemplateDto,
} from './dto/whatsapp-template.dto';

/**
 * WhatsApp template library — per-tenant CRUD, Gifsy OWNER only.
 *
 * DATA-BOUNDARY ENFORCEMENT (not just the route): every method re-asserts the caller is the
 * platform OWNER (`role === 'GIFSY_ADMIN'`, NOT the broader isGifsyOperator which also admits
 * GIFSY_STAFF) and pins every query to the operator's ASSUMED tenant (`user.clientId`). A
 * tenant CLIENT_ADMIN / a GIFSY_STAFF is already 403'd at the @Roles guard, but the service
 * check means the boundary holds even if a route were ever mis-annotated. `clientId` is NEVER
 * taken from the body.
 */
@Injectable()
export class WhatsappTemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Fail-closed OWNER gate — GIFSY_ADMIN only (excludes GIFSY_STAFF). */
  private assertOperator(user: JwtPayload): void {
    if (user.role !== 'GIFSY_ADMIN') {
      throw new ForbiddenException('WhatsApp templates are Gifsy owner only.');
    }
  }

  /** List — ACTIVE first, then newest. Tenant-scoped to the assumed tenant. FE reads `.items`. */
  async list(user: JwtPayload) {
    this.assertOperator(user);
    const items = await this.prisma.whatsappTemplate.findMany({
      where: { clientId: user.clientId },
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
    });
    return { items };
  }

  async create(user: JwtPayload, dto: CreateWhatsappTemplateDto) {
    this.assertOperator(user);
    try {
      const template = await this.prisma.whatsappTemplate.create({
        data: {
          clientId: user.clientId,
          name: dto.name,
          msg91TemplateName: dto.msg91TemplateName,
          category: dto.category,
          languageCode: dto.languageCode?.trim() || 'en',
          bodyText: dto.bodyText,
          variableContract: this.contractJson(dto.variableContract),
          headerType: dto.headerType ?? null,
          footer: dto.footer ?? null,
          createdByUserId: user.sub ?? null,
        },
      });
      return { template };
    } catch (e) {
      // @@unique([clientId, name]) — a duplicate display name in this tenant.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('A template with this name already exists.');
      }
      throw e;
    }
  }

  async update(user: JwtPayload, id: string, dto: UpdateWhatsappTemplateDto) {
    this.assertOperator(user);
    await this.getOwned(user, id); // tenant-ownership guard (404 otherwise)

    const data: Prisma.WhatsappTemplateUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.msg91TemplateName !== undefined) data.msg91TemplateName = dto.msg91TemplateName;
    if (dto.category !== undefined) data.category = dto.category;
    if (dto.languageCode !== undefined) data.languageCode = dto.languageCode.trim() || 'en';
    if (dto.bodyText !== undefined) data.bodyText = dto.bodyText;
    if (dto.variableContract !== undefined) {
      data.variableContract = this.contractJson(dto.variableContract);
    }
    if (dto.headerType !== undefined) data.headerType = dto.headerType;
    if (dto.footer !== undefined) data.footer = dto.footer;

    try {
      const template = await this.prisma.whatsappTemplate.update({ where: { id }, data });
      return { template };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('A template with this name already exists.');
      }
      throw e;
    }
  }

  /** Soft-archive (status ARCHIVED) — kept so historical broadcasts keep their template. */
  async archive(user: JwtPayload, id: string) {
    this.assertOperator(user);
    await this.getOwned(user, id);
    const template = await this.prisma.whatsappTemplate.update({
      where: { id },
      data: { status: 'ARCHIVED' },
    });
    return { template };
  }

  /**
   * Load a template that MUST belong to the caller's tenant (used by the broadcast
   * service). Cross-tenant / missing → 404. Not @assertOperator-gated: callers already
   * assert the operator; this is the tenant-ownership lookup only.
   */
  async getOwned(user: JwtPayload, id: string) {
    const template = await this.prisma.whatsappTemplate.findFirst({
      where: { id, clientId: user.clientId },
    });
    if (!template) throw new NotFoundException('Template not found');
    return template;
  }

  /** Normalise the variable contract array → sorted-by-index JSON (or JsonNull). */
  private contractJson(
    contract: { index: number; label: string }[] | undefined,
  ): Prisma.InputJsonValue | typeof Prisma.JsonNull {
    if (!contract || contract.length === 0) return Prisma.JsonNull;
    const sorted = [...contract].sort((a, b) => a.index - b.index);
    return sorted as unknown as Prisma.InputJsonValue;
  }
}
