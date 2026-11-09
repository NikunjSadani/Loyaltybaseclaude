import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Per-month apply in ONE transaction into OutletSalesRecord (owned keys only; plan §7.2; task K-6).
 * OWNER: Lane K. Lane-0 skeleton (empty) so controllers and the module compile before the lane starts.
 */
@Injectable()
export class SalesApplyService {
  constructor(readonly prisma: PrismaService) {}
}
