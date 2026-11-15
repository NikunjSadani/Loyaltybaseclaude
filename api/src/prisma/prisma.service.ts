import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

/**
 * Query-event logging is OFF unless `PRISMA_LOG_QUERIES=true` (memory-safety 2026-11-13).
 * Previously `{ emit: 'event', level: 'query' }` was always on with no listener, so every
 * query built a throw-away event object — garbage churn on a heap that has crashed.
 */
export function prismaQueryLogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PRISMA_LOG_QUERIES ?? '').trim().toLowerCase() === 'true';
}

export function prismaLogConfig(
  env: NodeJS.ProcessEnv = process.env,
): Array<{ emit: 'event' | 'stdout'; level: 'query' | 'error' | 'warn' }> {
  const base: Array<{ emit: 'event' | 'stdout'; level: 'query' | 'error' | 'warn' }> = [
    { emit: 'stdout', level: 'error' },
    { emit: 'stdout', level: 'warn' },
  ];
  return prismaQueryLogEnabled(env) ? [{ emit: 'event', level: 'query' }, ...base] : base;
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const adapter = new PrismaPg(pool);
    super({ adapter, log: prismaLogConfig() });
    if (prismaQueryLogEnabled()) {
      // Debug-only: print each query (duration + SQL). Never on by default — in
      // production the event objects (incl. big `IN (…)` param lists) are pure heap churn.
      (this as unknown as { $on: (e: 'query', cb: (ev: { query: string; duration: number }) => void) => void }).$on(
        'query',
        (ev) => this.logger.log(`${ev.duration}ms ${ev.query}`),
      );
    }
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Database connected');
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Database disconnected');
  }

  /** Soft-delete helper — sets deletedAt instead of hard delete */
  async softDelete(model: string, id: string): Promise<void> {
    await (this as any)[model].update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
