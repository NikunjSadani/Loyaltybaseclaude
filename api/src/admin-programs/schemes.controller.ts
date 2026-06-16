import { Controller, Get, Param } from '@nestjs/common';
import { SchemesService } from './schemes.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';

/**
 * Schemes admin — re-homed from
 * platform/src/app/api/admin/schemes/[id]/enrollments/export onto /v1.
 * Returns an xlsx StreamableFile download.
 */
@Controller('admin/schemes')
export class SchemesController {
  constructor(private readonly schemes: SchemesService) {}

  @Get(':id/enrollments/export')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('schemes:export')
  exportEnrollments(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.schemes.exportEnrollments(user, id);
  }
}
