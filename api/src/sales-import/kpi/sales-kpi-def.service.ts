import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Importer-owned KPI definitions CRUD + definitionsHash + the draft-filter tester (plan §5.2, §6.2, §6.2a; task K-2).
 * OWNER: Lane K. Lane-0 skeleton (empty) so controllers and the module compile before the lane starts.
 */
@Injectable()
export class SalesKpiDefService {
  constructor(readonly prisma: PrismaService) {}
}
