import { prismaLogConfig, prismaQueryLogEnabled } from './prisma.service';

describe('prismaLogConfig (memory-safety)', () => {
  it('does NOT emit query events by default (production)', () => {
    const cfg = prismaLogConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv);
    expect(cfg.some((c) => c.level === 'query')).toBe(false);
    expect(cfg).toEqual([
      { emit: 'stdout', level: 'error' },
      { emit: 'stdout', level: 'warn' },
    ]);
    expect(prismaQueryLogEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('enables query events only when PRISMA_LOG_QUERIES=true', () => {
    expect(prismaQueryLogEnabled({ PRISMA_LOG_QUERIES: 'TRUE' } as NodeJS.ProcessEnv)).toBe(true);
    expect(prismaQueryLogEnabled({ PRISMA_LOG_QUERIES: '1' } as NodeJS.ProcessEnv)).toBe(false);
    const cfg = prismaLogConfig({ PRISMA_LOG_QUERIES: 'true' } as NodeJS.ProcessEnv);
    expect(cfg[0]).toEqual({ emit: 'event', level: 'query' });
  });
});
