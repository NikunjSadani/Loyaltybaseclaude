import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Month state list / close / reopen with the per-(client, month) advisory lock + audit (plan §7.3; task K-4).
 * OWNER: Lane K. Lane-0 skeleton (empty) so controllers and the module compile before the lane starts.
 */
@Injectable()
export class SalesMonthsService {
  constructor(readonly prisma: PrismaService) {}
}
