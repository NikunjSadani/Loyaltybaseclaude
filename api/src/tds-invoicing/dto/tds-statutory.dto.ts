/**
 * DTO for PUT /v1/admin/tds/statutory — the platform-level, FY-effective statutory TDS config.
 *
 * The STRICT per-field validation (FY label format + uniqueness, rate 0..95, threshold > 0, all
 * integers, closed-FY immutability) is done by validateStatutoryEntries in
 * TdsStatutoryConfigService so the error messages name the exact offending field/index — a single
 * source owns the money-path validation.
 *
 * IMPORTANT: the global ValidationPipe runs with { whitelist: true }, which STRIPS properties that
 * carry no class-validator decorator. A previous version declared `entries: unknown[]` with no
 * nested type, so the pipe emptied each entry object before the service saw it → every PUT 400'd
 * ("entries[0] must be an object"). The nested StatutoryEntryDto with @Allow() on each field marks
 * them whitelisted (kept, not validated here), and @ValidateNested + @Type make class-transformer
 * instantiate the nested objects so the fields survive to the strict service-level validator.
 */
import { Allow, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

/** One effective-dated entry. Fields are @Allow()'d (whitelisted through the pipe) — the real
 *  strict validation lives in validateStatutoryEntries. */
class StatutoryEntryDto {
  @Allow() effectiveFromFy?: unknown;
  @Allow() r194rWithPanPct?: unknown;
  @Allow() r194rNoPanPct?: unknown;
  @Allow() c194cIndividualPct?: unknown;
  @Allow() c194cOtherPct?: unknown;
  @Allow() c194cNoPanPct?: unknown;
  @Allow() thr194cSingleRupees?: unknown;
  @Allow() thr194cFyRupees?: unknown;
  @Allow() thr194rFyRupees?: unknown;
}

export class SetTdsStatutoryDto {
  /** The effective-dated statutory entries (see StoredStatutoryEntry). Strict-validated in the service. */
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StatutoryEntryDto)
  entries!: StatutoryEntryDto[];
}
