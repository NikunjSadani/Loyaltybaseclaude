import { EventEmitter } from 'events';
import { HttpException, HttpStatus } from '@nestjs/common';
import { lastValueFrom, of, throwError, Observable } from 'rxjs';
import {
  HEAVY_OP_BUSY_MESSAGE,
  HeavyOpInterceptor,
  HeavyOpLimiter,
} from './heavy-op-limiter';

class FakeRes extends EventEmitter {
  headers: Record<string, string> = {};
  writableFinished = false;
  destroyed = false;
  setHeader(k: string, v: string) {
    this.headers[k] = v;
  }
}

function ctx(res: FakeRes) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ method: 'GET', originalUrl: '/v1/x' }),
      getResponse: () => res,
    }),
    getHandler: () => ({ name: 'h' }),
  } as never;
}

describe('HeavyOpLimiter', () => {
  it('allows at most 2 concurrent slots; release frees one; release is idempotent', () => {
    const l = new HeavyOpLimiter(2);
    const a = l.tryAcquire('a');
    const b = l.tryAcquire('b');
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(l.tryAcquire('c')).toBeNull();
    a!();
    a!(); // idempotent — must not free a second slot
    expect(l.inUse).toBe(1);
    expect(l.tryAcquire('d')).toBeTruthy();
    expect(l.tryAcquire('e')).toBeNull();
  });

  it('run() releases in finally on success and on error, and 503s when busy', async () => {
    const l = new HeavyOpLimiter(1);
    await expect(l.run('ok', async () => 1)).resolves.toBe(1);
    expect(l.inUse).toBe(0);
    await expect(l.run('boom', async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(l.inUse).toBe(0);

    let unblock!: () => void;
    const p = l.run('long', () => new Promise<void>((r) => { unblock = r; }));
    const err = await l.run('second', async () => 2).catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect((err as HttpException).message).toBe(HEAVY_OP_BUSY_MESSAGE);
    unblock();
    await p;
    expect(l.inUse).toBe(0);
  });

  it('safety timer force-releases a leaked slot', () => {
    jest.useFakeTimers();
    try {
      const l = new HeavyOpLimiter(1, 1000);
      expect(l.tryAcquire('leak')).toBeTruthy();
      expect(l.inUse).toBe(1);
      jest.advanceTimersByTime(1001);
      expect(l.inUse).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('HeavyOpInterceptor', () => {
  it('third concurrent request → 503 with Retry-After: 30', () => {
    const l = new HeavyOpLimiter(2);
    const i = new HeavyOpInterceptor(l);
    const next = { handle: () => of('ok') };
    i.intercept(ctx(new FakeRes()), next);
    i.intercept(ctx(new FakeRes()), next);
    const res3 = new FakeRes();
    let thrown: unknown;
    try {
      i.intercept(ctx(res3), next);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(503);
    expect((thrown as HttpException).message).toBe(HEAVY_OP_BUSY_MESSAGE);
    expect(res3.headers['Retry-After']).toBe('30');
    expect(l.inUse).toBe(2);
  });

  it('holds the slot after the handler observable completes until the response finishes (streams)', async () => {
    const l = new HeavyOpLimiter(2);
    const i = new HeavyOpInterceptor(l);
    const res = new FakeRes();
    await lastValueFrom(i.intercept(ctx(res), { handle: () => of('stream') }));
    // Handler returned a StreamableFile, stream still flowing → slot still held.
    expect(l.inUse).toBe(1);
    res.emit('finish');
    expect(l.inUse).toBe(0);
    res.emit('close'); // both events fire in practice — still only one release
    expect(l.inUse).toBe(0);
  });

  it('releases on client abort (close without finish)', () => {
    const l = new HeavyOpLimiter(2);
    const i = new HeavyOpInterceptor(l);
    const res = new FakeRes();
    i.intercept(ctx(res), { handle: () => new Observable(() => undefined) });
    expect(l.inUse).toBe(1);
    res.emit('close');
    expect(l.inUse).toBe(0);
  });

  it('releases when the handler errors (the exception filter finishes the response)', async () => {
    const l = new HeavyOpLimiter(2);
    const i = new HeavyOpInterceptor(l);
    const res = new FakeRes();
    await expect(
      lastValueFrom(i.intercept(ctx(res), { handle: () => throwError(() => new Error('bad')) })),
    ).rejects.toThrow('bad');
    res.emit('finish');
    expect(l.inUse).toBe(0);
  });

  it('does not hold a slot when the response is already closed', () => {
    const l = new HeavyOpLimiter(2);
    const i = new HeavyOpInterceptor(l);
    const res = new FakeRes();
    res.destroyed = true;
    i.intercept(ctx(res), { handle: () => of(1) });
    expect(l.inUse).toBe(0);
  });
});

describe('@HeavyOp() through a real Nest HTTP stack (DI + exception filter)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Controller, Get } = require('@nestjs/common');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Test } = require('@nestjs/testing');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const request = require('supertest');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AllExceptionsFilter } = require('./filters/all-exceptions.filter');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { HeavyOp, heavyOpLimiter } = require('./heavy-op-limiter');

  let gate!: () => void;
  const blocked = new Promise<void>((r) => { gate = r; });

  class SlowController {
    async slow() {
      await blocked;
      return { ok: true };
    }
    fast() {
      return { ok: true };
    }
  }
  Controller('h')(SlowController);
  const d1 = Object.getOwnPropertyDescriptor(SlowController.prototype, 'slow')!;
  Get('slow')(SlowController.prototype, 'slow', d1);
  HeavyOp()(SlowController.prototype, 'slow', d1);
  const d2 = Object.getOwnPropertyDescriptor(SlowController.prototype, 'fast')!;
  Get('fast')(SlowController.prototype, 'fast', d2);
  HeavyOp()(SlowController.prototype, 'fast', d2);

  it('2 heavy requests run, the 3rd gets 503 + Retry-After: 30 + the busy message; slots free afterwards', async () => {
    const mod = await Test.createTestingModule({ controllers: [SlowController] }).compile();
    const app = mod.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    const server = app.getHttpServer();
    const base = heavyOpLimiter.inUse;
    try {
      const p1 = request(server).get('/h/slow');
      const p2 = request(server).get('/h/slow');
      const r1 = p1.then((x: unknown) => x);
      const r2 = p2.then((x: unknown) => x);
      // wait until both hold a slot
      for (let i = 0; i < 100 && heavyOpLimiter.inUse < base + 2; i++) await new Promise((r) => setTimeout(r, 10));
      expect(heavyOpLimiter.inUse).toBe(base + 2);

      const busy = await request(server).get('/h/fast');
      expect(busy.status).toBe(503);
      expect(busy.headers['retry-after']).toBe('30');
      expect(busy.body).toEqual({ success: false, error: HEAVY_OP_BUSY_MESSAGE });

      gate();
      expect(((await r1) as { status: number }).status).toBe(200);
      expect(((await r2) as { status: number }).status).toBe(200);
      for (let i = 0; i < 100 && heavyOpLimiter.inUse > base; i++) await new Promise((r) => setTimeout(r, 10));
      expect(heavyOpLimiter.inUse).toBe(base);
      expect((await request(server).get('/h/fast')).status).toBe(200);
    } finally {
      gate();
      await app.close();
    }
  });
});
