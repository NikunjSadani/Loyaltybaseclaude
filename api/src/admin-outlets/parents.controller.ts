import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ParentsService } from './parents.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { CreateParentDto } from './dto/admin-parents.dto';

/**
 * Admin · Parent owners — the non-operating owner entity of the parent-child owner-group
 * feature (docs/plans/PARTNER-MULTI-OUTLET.md §2.2). List + create are admin actions; the
 * straight-to-Gifsy approval of a parent's own details is a GIFSY_ADMIN action (same gate as
 * the outlet Gifsy approval, `kyc:gifsy_approve`).
 */
@Controller('admin/parents')
export class ParentsController {
  constructor(private readonly parents: ParentsService) {}

  @Get()
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER')
  @RequirePermission('partners:read')
  list(@CurrentUser() user: JwtPayload) {
    return this.parents.listParents(user);
  }

  @Post()
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('partners:manage_outlets')
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateParentDto) {
    return this.parents.createParent(user, dto);
  }

  @Post(':id/approve')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('kyc:gifsy_approve')
  approve(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.parents.approveParent(user, id);
  }
}
