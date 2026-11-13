/**
 * Feature modules the gifsy-exports WORKER job must load so a kind's `run` can resolve the services it needs through
 * `ctx.moduleRef.get(X, { strict: false })` (e.g. KycModule for signed document links). The API loads every module
 * anyway (AppModule); the worker loads only these, plus the @Global basics (Config, Prisma, Storage, Tenant, Rbac).
 *
 * Report lanes: append the module of any service your kind resolves. worker-module.spec.ts compiles the worker module,
 * so a missing dependency fails a test instead of a job run.
 */
import type { Type } from '@nestjs/common';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const EXPORT_WORKER_FEATURE_MODULES: Array<Type<any>> = [];
