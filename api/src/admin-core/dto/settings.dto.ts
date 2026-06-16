import { Allow, IsOptional, IsString, MinLength } from 'class-validator';

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
