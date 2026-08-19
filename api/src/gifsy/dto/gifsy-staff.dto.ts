import {
  ArrayUnique,
  IsArray,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { UserStatus } from '@prisma/client';

/**
 * DTOs for the RBAC Option-X Gifsy STAFF-management API (/v1/gifsy/staff).
 *
 * These are the platform-operator "staff" who sit BELOW the GIFSY_ADMIN owner: each is a
 * `role: 'GIFSY_STAFF'`, `clientId: 'gifsy'` user whose effective access comes entirely
 * from an assigned custom `GifsyRole` (user.gifsyRoleId). The `role` column is never taken
 * from the client — it is always pinned to GIFSY_STAFF by the service.
 */
export class CreateGifsyStaffDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @Matches(/^\d{10}$/, { message: 'Phone must be 10 digits' })
  phone!: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  /** id of the GifsyRole (clientId 'gifsy') that grants this staff member's permissions. */
  @IsString()
  @MinLength(1)
  gifsyRoleId!: string;

  /**
   * RBAC Option-X (P5) — tenant slugs (Client.id) this staff may assume/operate in. Optional;
   * omit or [] to create a staff with NO tenant access yet (deny-by-default). The service
   * validates each slug against a live Client row.
   */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  assumableClientIds?: string[];
}

/**
 * Partial update. Every field is optional; deactivate / reactivate / role-reassign / edit
 * all flow through the same PATCH (mirrors admin updateUser). `role` is intentionally NOT
 * updatable here — a GIFSY_STAFF stays GIFSY_STAFF; access changes via `gifsyRoleId`.
 */
export class UpdateGifsyStaffDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @Matches(/^\d{10}$/, { message: 'Phone must be 10 digits' })
  phone?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  gifsyRoleId?: string;

  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  /**
   * RBAC Option-X (P5) — set-semantics: when PRESENT, replaces the staff's tenant grants with
   * EXACTLY this set ([] revokes all). When OMITTED (undefined), grants are left untouched.
   * Removing a tenant here revokes the staff's live sessions (they must re-login and can only
   * re-assume a still-granted tenant). Each slug is validated against a live Client row.
   */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  assumableClientIds?: string[];
}
