import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Help & videos console DTOs. Decorators enforce TYPES + generous outer caps; the precise, human-worded rules
 * (trimmed lengths, role codes, 3–6 steps to publish) live in HelpAdminService so a PATCH is validated on the
 * MERGED row. UpdateHelpTopicDto is hand-written (every field optional, no initializers).
 */
export class CreateHelpTopicDto {
  @IsIn(['SALES', 'PARTNER'])
  audience!: 'SALES' | 'PARTNER';

  @IsString()
  @MaxLength(500)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  roles?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  steps?: string[];
}

export class UpdateHelpTopicDto {
  @IsOptional()
  @IsIn(['SALES', 'PARTNER'])
  audience?: 'SALES' | 'PARTNER';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  roles?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  steps?: string[];

  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;
}

export class ReorderHelpTopicsDto {
  @IsIn(['SALES', 'PARTNER'])
  audience!: 'SALES' | 'PARTNER';

  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  ids!: string[];
}
