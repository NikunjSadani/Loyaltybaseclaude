import {
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * RBAC Option-X (P1) — DTOs for the self-service Gifsy role editor CRUD.
 *
 * Deliberately loose on the permission KEYS themselves: class-validator only
 * checks they are strings. Semantic validation (every key is a real Permission,
 * and the reserved-grant "Lock 1" override) lives in GifsyRolesService so the
 * error messages can enumerate the offending keys. `allowReserved` is the
 * conscious-override flag the FE editor sets when the owner acknowledges the
 * reserved-permission warning.
 */
export class CreateGifsyRoleDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsArray()
  @IsString({ each: true })
  permissions!: string[];

  @IsOptional()
  @IsBoolean()
  allowReserved?: boolean;
}

export class UpdateGifsyRoleDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissions?: string[];

  @IsOptional()
  @IsBoolean()
  allowReserved?: boolean;
}
