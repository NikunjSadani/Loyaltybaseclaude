/**
 * DTO for PUT /v1/admin/tds/statutory — the platform-level, FY-effective statutory TDS config.
 *
 * The shallow shape is validated here (`entries` must be an array); the STRICT per-field
 * validation (FY label format + uniqueness, rate 0..95, threshold >= 0, all integers) is done by
 * validateStatutoryEntries in TdsStatutoryConfigService so the error messages name the exact
 * offending field/index. Deliberately not @ValidateNested — the element schema is enforced there,
 * not via class-validator, so a single source owns the money-path validation.
 */
import { IsArray } from 'class-validator';

export class SetTdsStatutoryDto {
  /** The effective-dated statutory entries (see StoredStatutoryEntry). Strict-validated in the service. */
  @IsArray()
  entries!: unknown[];
}
