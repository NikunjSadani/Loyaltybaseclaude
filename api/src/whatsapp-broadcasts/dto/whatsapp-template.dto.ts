import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * WhatsApp template-library DTOs (Gifsy-operator only).
 *
 * ⚠️ NESTED VALIDATION + THE GLOBAL WHITELIST PIPE: the app runs a global
 * ValidationPipe with `whitelist:true` + `forbidNonWhitelisted:true`. A nested
 * object/array field is only recognised (and kept) when it carries BOTH
 * `@ValidateNested()` AND `@Type(() => Class)` — without the `@Type` the transformer
 * never instantiates the nested class, `whitelist` strips it, and a payload that DID
 * include the field 400s. (This is the exact bug that broke the TDS + notification-
 * templates saves.) `variableContract` therefore uses both.
 */
export const WHATSAPP_TEMPLATE_CATEGORIES = ['MARKETING', 'UTILITY', 'AUTHENTICATION'] as const;
export type WhatsappTemplateCategoryDto = (typeof WHATSAPP_TEMPLATE_CATEGORIES)[number];

/** One ordered variable in a template's body ({{1}}…{{n}}) → a human label. */
export class VariableContractItemDto {
  @IsInt()
  @Min(1)
  index!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label!: string;
}

export class CreateWhatsappTemplateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  msg91TemplateName!: string;

  @IsIn(WHATSAPP_TEMPLATE_CATEGORIES as unknown as string[], {
    message: `category must be one of: ${WHATSAPP_TEMPLATE_CATEGORIES.join(', ')}`,
  })
  category!: WhatsappTemplateCategoryDto;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  languageCode?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  bodyText!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => VariableContractItemDto)
  variableContract?: VariableContractItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(50)
  headerType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  footer?: string;
}

/**
 * PATCH — every field optional. Category kept as a constrained @IsIn when present.
 * `status` is NOT settable here: archiving is DELETE (soft-archive), and re-activation
 * is a deliberate future action, not a generic edit.
 */
export class UpdateWhatsappTemplateDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  msg91TemplateName?: string;

  @IsOptional()
  @IsIn(WHATSAPP_TEMPLATE_CATEGORIES as unknown as string[], {
    message: `category must be one of: ${WHATSAPP_TEMPLATE_CATEGORIES.join(', ')}`,
  })
  category?: WhatsappTemplateCategoryDto;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  languageCode?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  bodyText?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => VariableContractItemDto)
  variableContract?: VariableContractItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(50)
  headerType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  footer?: string;
}
