import { IsObject, IsString, MinLength } from 'class-validator';

/**
 * Body for PUT /v1/admin/target-config — ported from
 * platform/src/app/api/admin/target-config/route.ts.
 *
 * Target configs are stored as a JSON blob array under the `target_configs`
 * ProgramSetting key (NO `Target` model is referenced — that World-A model is
 * dropped). The payload is a single config object with an `id`; the rest of the
 * shape is opaque and persisted verbatim, mirroring the source route.
 */
export class UpsertTargetConfigDto {
  @IsString()
  @MinLength(1, { message: 'Expected a TargetConfig object with an id' })
  id!: string;

  // The remaining config fields are opaque JSON, stored verbatim.
  [key: string]: unknown;
}

/** Marker DTO to keep the config body validated as an object at the boundary. */
export class TargetConfigBodyDto {
  @IsObject()
  config!: Record<string, unknown>;
}
