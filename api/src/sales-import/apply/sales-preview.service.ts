import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Per-month live preview of an import (plan §5.2 GET :id/preview, §6.3 warnings; task K-5).
 * OWNER: Lane K. Lane-0 skeleton (empty) so controllers and the module compile before the lane starts.
 */
@Injectable()
export class SalesPreviewService {
  constructor(readonly prisma: PrismaService) {}
}
