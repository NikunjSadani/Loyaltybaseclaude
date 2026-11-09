import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Per-tenant column mapping CRUD (GET/PUT admin/sales-import/profile; plan §5.2, task K-1).
 * OWNER: Lane K. Lane-0 skeleton (empty) so controllers and the module compile before the lane starts.
 */
@Injectable()
export class SalesProfileService {
  constructor(readonly prisma: PrismaService) {}
}
