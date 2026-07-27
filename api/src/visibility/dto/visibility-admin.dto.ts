import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { validateFormSchema } from '../visibility-form.helper';

/**
 * visibility-admin.dto.ts — GIFSY_ADMIN authoring DTOs for the Visibility (POSM)
 * feature: the per-tenant capture CONFIG (outlet scope / frequency / allowed sales
 * levels / geo-fence) and the versioned capture FORM.
 *
 * Design: docs/plans/VISIBILITY-POSM-DESIGN.md §1 (D5/D6/D8/D10), §6.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Config (D5/D6/D8/D10)
// ─────────────────────────────────────────────────────────────────────────────

export class GeoFenceDto {
  @IsBoolean()
  enabled!: boolean;

  /** Geo-fence radius in metres. Positive integer 1..5000 (design suggests 50). */
  @IsInt()
  @Min(1)
  @Max(5000)
  radiusMeters!: number;
}

export class SetVisibilityConfigDto {
  /** Outlet scope = list of OutletType.code (e.g. ["SSS","SSS_TOT"]); may be empty. */
  @IsArray()
  @IsString({ each: true })
  outletScope!: string[];

  /** Captures required per calendar month → windows. Integer 1..4. */
  @IsInt()
  @Min(1)
  @Max(4)
  frequencyPerMonth!: number;

  /** SalesHierarchyLevel.code values that may capture; may be empty. */
  @IsArray()
  @IsString({ each: true })
  allowedSalesLevels!: string[];

  @IsObject()
  @ValidateNested()
  @Type(() => GeoFenceDto)
  geoFence!: GeoFenceDto;
}

// ─────────────────────────────────────────────────────────────────────────────
// Versioned capture form (D9/D11/D16)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Custom class-validator decorator: validates the formSchema structure using the pure
 * `validateFormSchema` helper. Each structural error is concatenated into a single
 * validation message.
 */
function IsValidVisibilityFormSchema(validationOptions?: ValidationOptions) {
  // eslint-disable-next-line @typescript-eslint/ban-types
  return function (object: Object, propertyName: string) {
    registerDecorator({
      name: 'isValidVisibilityFormSchema',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return validateFormSchema(value).length === 0;
        },
        defaultMessage(args: ValidationArguments): string {
          return validateFormSchema(args.value).join(' | ');
        },
      },
    });
  };
}

export class UpsertVisibilityFormDto {
  @IsObject()
  @IsValidVisibilityFormSchema()
  formSchema!: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Outlets-in-scope listing (admin)
// ─────────────────────────────────────────────────────────────────────────────

export class ScopeOutletsQueryDto {
  /** Optional free-text filter over outlet name / code. */
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsString()
  zone?: string;

  @IsOptional()
  @IsString()
  state?: string;
}
