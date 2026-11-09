import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { SALES_IMPORT_MAX_FILE_BYTES } from '../sales-import.contract';
import { SALES_IMPORT_LIST_MAX_LIMIT } from './sales-import-upload.service';

/** POST admin/sales-import/uploads (CreateSalesImportUploadRequest). The extension is checked in the service. */
export class CreateSalesImportUploadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  filename!: string;

  @IsInt()
  @Min(1)
  @Max(SALES_IMPORT_MAX_FILE_BYTES)
  sizeBytes!: number;
}

/** GET admin/sales-import?cursor&limit */
export class ListSalesImportsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cursor?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(SALES_IMPORT_LIST_MAX_LIMIT)
  limit?: number;
}
