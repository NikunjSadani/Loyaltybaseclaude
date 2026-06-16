import { Type } from 'class-transformer';
import {
  IsArray,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
  MinLength,
} from 'class-validator';
import { UserRole, UserStatus } from '@prisma/client';

/**
 * DTOs for admin/users — ported from platform/src/app/api/admin/users/*.
 * The Zod role enum is the full UserRole set; we reuse Prisma's UserRole enum.
 */

export class CreateUserDto {
  @Matches(/^\d{10}$/, { message: 'Phone must be 10 digits' })
  phone!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsEnum(UserRole)
  role!: UserRole;

  @IsOptional()
  @IsEmail()
  email?: string;
}

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @IsOptional()
  @Matches(/^\d{10}$/, { message: 'Phone must be 10 digits' })
  phone?: string;
}

export class ListUsersQueryDto {
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;
}

/**
 * Bulk-edit — discriminated by `action`. Validation of the per-action fields
 * is performed in the service (mirrors the Next route's manual checks), so the
 * DTO keeps every branch's fields optional.
 */
export class BulkEditUsersDto {
  @IsString()
  @MinLength(1)
  action!: string; // 'resign' | 'reassign_outlet'

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  employeeCodes?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  outletIds?: string[];

  @IsOptional()
  @IsString()
  newXsrEmployeeCode?: string;
}
