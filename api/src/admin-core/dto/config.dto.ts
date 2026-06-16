import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * DTOs for the JSON-blob config sub-domains — hierarchy-config, task-config,
 * kpi-config, gift-config. Ported from the corresponding Next routes.
 *
 * kpi-config and gift-config PUT bodies are raw arrays in the source; NestJS
 * cannot bind a top-level array to a DTO class, so those controllers accept the
 * array directly and the service validates `Array.isArray(...)` (mirrors source).
 */

// ── hierarchy-config ──────────────────────────────────────────────────────────
// PUT body: { employees: HierarchyEmployee[] }. The source only checks
// Array.isArray(employees); employee shape is validated by the persistence layer.
export class HierarchyConfigDto {
  @IsArray()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  employees!: any[];
}

// ── task-config ───────────────────────────────────────────────────────────────
export class CustomTaskItemDto {
  @IsString()
  id!: string;

  @IsString()
  title!: string;

  @IsString()
  subtitle!: string;

  @IsIn(['high', 'medium', 'low'])
  priority!: 'high' | 'medium' | 'low';

  @IsOptional()
  @IsString()
  startsAt?: string;

  @IsOptional()
  @IsString()
  endsAt?: string;
}

export class TaskConfigDto {
  @IsString()
  @MinLength(1, { message: 'Label is required' })
  customTaskLabel!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomTaskItemDto)
  customTaskItems!: CustomTaskItemDto[];
}
