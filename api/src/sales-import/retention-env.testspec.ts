import { SALES_RETENTION_V2_ENV } from './retention-window';

/** Test helper: runs `fn` with SALES_RETENTION_V2 set to `value` (undefined = unset), restoring the env afterwards. */
export async function withRetentionV2<T>(value: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env[SALES_RETENTION_V2_ENV];
  if (value === undefined) delete process.env[SALES_RETENTION_V2_ENV];
  else process.env[SALES_RETENTION_V2_ENV] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[SALES_RETENTION_V2_ENV];
    else process.env[SALES_RETENTION_V2_ENV] = prev;
  }
}
