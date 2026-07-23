import { Injectable, NotFoundException, StreamableFile } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { buildXlsx } from '../common/xlsx';

/**
 * Schemes admin — ported from
 * platform/src/app/api/admin/schemes/[id]/enrollments/export/route.ts.
 *
 * The source exported World-A `MOCK_ENROLLMENTS` (lib/campaign.ts) with custom
 * form-field columns, GPS columns, and photo columns. Those are DROPPED
 * (RULE 3: no mocks; the canonical SchemeEnrollment is a minimal join with no
 * form-field config / GPS / photos). This faithful port exports the scheme's
 * real enrollments, tenant-scoped via the parent Scheme's clientId.
 *
 * Access: GIFSY_ADMIN | CLIENT_ADMIN (schemes:export).
 */
@Injectable()
export class SchemesService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /v1/admin/schemes/:id/enrollments/export — xlsx download. */
  async exportEnrollments(user: JwtPayload, schemeId: string): Promise<StreamableFile> {
    // Tenant scope: the scheme must belong to the caller's client.
    const scheme = await this.prisma.scheme.findFirst({
      where: { id: schemeId, clientId: user.clientId },
      select: { id: true, code: true },
    });
    if (!scheme) throw new NotFoundException('Scheme not found');

    const enrollments = await this.prisma.schemeEnrollment.findMany({
      where: { schemeId: scheme.id },
      include: {
        // The enrollee is now the SHOP (partner); userId is the performing login (nullable —
        // null for a login-less sibling), kept for audit. Join both.
        partner: { select: { id: true, partnerCode: true, businessName: true, ownerName: true, phone: true } },
        user: { select: { id: true, name: true, phone: true, email: true, role: true } },
      },
      orderBy: { enrolledAt: 'desc' },
    });

    if (enrollments.length === 0) {
      throw new NotFoundException('No enrollments found for this scheme.');
    }

    const rows: Record<string, unknown>[] = enrollments.map((e) => ({
      'Enrollment ID': e.id,
      'Scheme ID': e.schemeId,
      'Partner ID': e.partnerId,
      'Partner Code': e.partner?.partnerCode ?? '',
      Name: e.partner?.businessName ?? e.partner?.ownerName ?? '',
      Phone: e.partner?.phone ?? e.user?.phone ?? '',
      // The login that performed the enrollment (audit — blank for a login-less sibling).
      'Enrolled By (User ID)': e.userId ?? '',
      'Enrolled By Name': e.user?.name ?? '',
      Email: e.user?.email ?? '',
      Role: e.user?.role ?? '',
      Status: e.status,
      'Enrolled At': e.enrolledAt.toISOString(),
    }));

    const buffer = buildXlsx([{ name: 'Enrollments', rows }]);
    const filename = `enrollments_${schemeId}_${new Date().toISOString().split('T')[0]}.xlsx`;

    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${filename}"`,
    });
  }
}
