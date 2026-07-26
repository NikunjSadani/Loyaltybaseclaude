import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SchemeAdminService } from './scheme-admin.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import {
  CreateSchemeAdminDto,
  RosterQueryDto,
  RosterUploadDto,
  SetAudienceDto,
  SetSchemeStatusDto,
  UpdateSchemeAdminDto,
  UpsertEnrollmentFormAdminDto,
} from './dto/scheme-admin.dto';

/**
 * Scheme ADMIN authoring API — Wave-0 scheme data-collection (§13.4).
 *
 * GIFSY_ADMIN only (D2). `@Roles('GIFSY_ADMIN')` is the real gate — RolesGuard is
 * always-on and independent of the RBAC master-flag; a GIFSY_ADMIN passes every
 * @RequirePermission check regardless. Responses are enveloped by the global
 * TransformInterceptor. The enroll / enrollments-view / export / reject / broadcast
 * / report endpoints in §13.4 belong to other streams and are not defined here.
 *
 * NOTE: these endpoint paths intentionally overlap the reward-era SchemesController
 * (POST /schemes, PATCH /schemes/:id, …). The module wiring / retirement of the old
 * routes is done by the orchestrator (this stream owns new files only).
 */
@Controller('schemes')
export class SchemeAdminController {
  constructor(private readonly admin: SchemeAdminService) {}

  /** POST /v1/schemes — create as DRAFT (default) or ACTIVE. */
  @Post()
  @Roles('GIFSY_ADMIN')
  @RequirePermission('schemes:write')
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateSchemeAdminDto) {
    return this.admin.create(user, dto);
  }

  /** PATCH /v1/schemes/:id — edit-in-place (no duplicate). */
  @Patch(':id')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('schemes:write')
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateSchemeAdminDto,
  ) {
    return this.admin.update(user, id, dto);
  }

  /** PATCH /v1/schemes/:id/status — activate / pause (valid SchemeStatus only). */
  @Patch(':id/status')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('schemes:write')
  setStatus(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: SetSchemeStatusDto,
  ) {
    return this.admin.setStatus(user, id, dto);
  }

  /** PUT /v1/schemes/:id/enrollment-form — versioned upsert (appends a snapshot, D11). */
  @Put(':id/enrollment-form')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('schemes:write')
  upsertEnrollmentForm(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpsertEnrollmentFormAdminDto,
  ) {
    return this.admin.upsertEnrollmentForm(user, id, dto);
  }

  /** POST /v1/schemes/:id/audience — store audienceConfig + materialize a frozen snapshot. */
  @Post(':id/audience')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('schemes:write')
  setAudience(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: SetAudienceDto,
  ) {
    return this.admin.setAudience(user, id, dto);
  }

  /** POST /v1/schemes/:id/roster/upload — Mode-B Excel roster (chunked, dedup). */
  @Post(':id/roster/upload')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('schemes:write')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB ceiling — bound parse memory
      fileFilter: (_req, file, cb) =>
        /\.(xlsx|xls)$/i.test(file.originalname)
          ? cb(null, true)
          : cb(new Error('Only .xlsx / .xls roster files are accepted'), false),
    }),
  )
  uploadRoster(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: RosterUploadDto,
  ) {
    return this.admin.uploadRoster(user, id, file, dto);
  }

  /** GET /v1/schemes/:id/roster — paginated roster listing. */
  @Get(':id/roster')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('schemes:read')
  getRoster(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query() query: RosterQueryDto,
  ) {
    return this.admin.getRoster(user, id, query);
  }
}
