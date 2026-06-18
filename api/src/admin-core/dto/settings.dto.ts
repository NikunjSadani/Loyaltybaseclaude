import { Allow, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import type { VisibilityCaptureMode } from '../../tenant/tenant.service';

/**
 * DTOs for admin/settings — ported from platform/src/app/api/admin/settings/route.ts.
 * The Zod schema there allows `value: z.any()`, so `value` is left untyped here.
 */
export class UpsertSettingDto {
  @IsString()
  @MinLength(1)
  key!: string;

  // @Allow() whitelists the property without constraining its type — the
  // faithful equivalent of the source's `value: z.any()` (accepts scalars,
  // objects, or arrays). Needed because the global pipe sets forbidNonWhitelisted.
  @Allow()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value!: any;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  description?: string;
}

/**
 * DTO for PUT /v1/admin/settings/visibility-capture-mode.
 * Only the two valid enum values are accepted; anything else produces a 400.
 */
export class SetVisibilityCaptureModeDto {
  @IsEnum(['PHOTO_APPROVAL', 'AMOUNT_UPLOAD'] as const, {
    message: 'mode must be PHOTO_APPROVAL or AMOUNT_UPLOAD',
  })
  mode!: VisibilityCaptureMode;
}
