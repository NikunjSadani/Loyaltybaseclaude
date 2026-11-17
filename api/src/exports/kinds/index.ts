import { buildExportKindRegistry } from '../export-kinds';
import { BATCH1_EXPORT_KINDS } from './batch1';
import { BATCH2_EXPORT_KINDS } from './batch2';

/** Every registered export kind (built once at load; duplicate ids throw). */
export const EXPORT_KINDS = buildExportKindRegistry([BATCH1_EXPORT_KINDS, BATCH2_EXPORT_KINDS]);
