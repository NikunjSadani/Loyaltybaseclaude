import { Body, Controller, Get, HttpCode, HttpStatus, INestApplication, Logger, Post } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { SkipThrottle, Throttle, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { AuthController } from '../../auth/auth.controller';
import { AuthService } from '../../auth/auth.service';
import { Public } from '../decorators/roles.decorator';
import { IdentityThrottlerGuard, THROTTLE_KEY_BY } from './identity-throttler.guard';

/**
 * Per-identity throttling (2026-11-10). Prod logs showed 220 × 429 on POST /v1/auth/send-otp and none
 * elsewhere: every login arrives through the Next server action / proxy, so `req.ip` is effectively one
 * value and the stock ThrottlerGuard put ALL users of ALL tenants into ONE bucket per route per instance.
 *
 * In this suite every supertest request comes from 127.0.0.1 — i.e. the exact "one shared IP" condition
 * prod has — so a cross-user refusal here is the prod bug reproduced.
 */
const SECRET = 'test-throttle-secret';

@Controller('probe')
class ProbeController {
  /** Authenticated (no @Public) — tight limit so the test stays small. */
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Get('me')
  me() { return { ok: true }; }

  /** Public, IP-keyed (unchanged behaviour). */
  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Get('open')
  open() { return { ok: true }; }

  @Public()
  @SkipThrottle()
  @Get('skipped')
  skipped() { return { ok: true }; }

  /** Public route that echoes a body — proves the phone key is opt-in per route, not global. */
  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('public-with-phone')
  @HttpCode(HttpStatus.OK)
  publicWithPhone(@Body() _b: unknown) { return { ok: true }; }
}

describe('IdentityThrottlerGuard', () => {
  let app: INestApplication;
  let jwt: JwtService;
  let warn: jest.SpyInstance;
  const authService = {
    sendOtp:   jest.fn().mockResolvedValue({ success: true, expiresIn: 600 }),
    verifyOtp: jest.fn().mockResolvedValue({ accessToken: 'a', refreshToken: 'r', user: {} }),
    refreshToken: jest.fn().mockResolvedValue({ accessToken: 'a', refreshToken: 'r' }),
  };
  const savedEnv = { JWT_SECRET: process.env.JWT_SECRET, FIXED_OTP: process.env.FIXED_OTP };

  beforeEach(async () => {
    process.env.JWT_SECRET = SECRET;
    delete process.env.FIXED_OTP;
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        // Same global default as app.module.ts (60 / 60 s).
        ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 60_000, limit: 60 }] }),
      ],
      controllers: [AuthController, ProbeController],
      providers: [
        { provide: AuthService, useValue: authService },
        { provide: APP_GUARD, useClass: IdentityThrottlerGuard },
      ],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
    jwt = new JwtService({ secret: SECRET });
  });

  afterEach(async () => {
    await app.close();
    warn.mockRestore();
    process.env.JWT_SECRET = savedEnv.JWT_SECRET;
    if (savedEnv.FIXED_OTP === undefined) delete process.env.FIXED_OTP; else process.env.FIXED_OTP = savedEnv.FIXED_OTP;
  });

  const sendOtp   = (body: unknown) => request(app.getHttpServer()).post('/auth/send-otp').send(body as object);
  const verifyOtp = (body: unknown) => request(app.getHttpServer()).post('/auth/verify-otp').send(body as object);
  const phone = (i: number) => `98765${String(43200 + i).padStart(5, '0')}`;
  const allWarnText = () => warn.mock.calls.map((c) => c.map((a: unknown) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')).join('\n');

  it('the real send-otp / verify-otp handlers carry the phone key marker', () => {
    expect(Reflect.getMetadata(THROTTLE_KEY_BY, AuthController.prototype.sendOtp)).toBe('phone');
    expect(Reflect.getMetadata(THROTTLE_KEY_BY, AuthController.prototype.verifyOtp)).toBe('phone');
  });

  describe('send-otp (5/min) — keyed per phone', () => {
    it('8 different phones from the SAME ip in the same minute are all accepted (no cross-user refusal)', async () => {
      for (let i = 0; i < 8; i++) {
        const res = await sendOtp({ phone: phone(i), channel: 'SMS', clientId: 'deoleo' });
        expect(res.status).toBe(200);
      }
    });

    it('the same phone 6× → the 6th is refused with the unchanged 429 body', async () => {
      for (let i = 0; i < 5; i++) {
        expect((await sendOtp({ phone: phone(1), channel: 'SMS', clientId: 'deoleo' })).status).toBe(200);
      }
      const sixth = await sendOtp({ phone: phone(1), channel: 'SMS', clientId: 'deoleo' });
      expect(sixth.status).toBe(429);
      expect(sixth.body.message).toBe('ThrottlerException: Too Many Requests');
      // another phone is unaffected by that bucket
      expect((await sendOtp({ phone: phone(2), channel: 'SMS', clientId: 'deoleo' })).status).toBe(200);
    });

    it('formatting variants and a different/absent clientId of the same number share ONE bucket', async () => {
      const variants = [
        { phone: '9876543210', clientId: 'deoleo' },
        { phone: '98765 43210', clientId: 'bajaj' },
        { phone: '98765-43210' },
        { phone: '9876543210', clientId: 'anything-else' },
        { phone: ' 9876543210 ', clientId: 'deoleo' },
      ];
      for (const v of variants) expect((await sendOtp({ ...v, channel: 'SMS' })).status).toBe(200);
      expect((await sendOtp({ phone: '9876543210', channel: 'SMS', clientId: 'deoleo' })).status).toBe(429);
    });

    it('missing body / missing phone / malformed phone → IP fallback (never throws), shared IP bucket', async () => {
      const bad: unknown[] = [undefined, {}, { phone: 12345 }, { phone: 'abc' }, { phone: '123' }];
      // The guard lets them through (no ValidationPipe in this harness, so the handler may 500 on an
      // absent body — in the app the pipe answers 400). What matters: not throttled, guard didn't throw.
      for (const b of bad) expect((await sendOtp(b)).status).not.toBe(429);
      // 5 IP-keyed hits used the IP bucket; the 6th malformed request is refused …
      expect((await sendOtp({ phone: '+91 98765 4321' })).status).toBe(429);
      // … while a well-formed phone (own bucket) still goes through.
      expect((await sendOtp({ phone: phone(3), channel: 'SMS', clientId: 'deoleo' })).status).toBe(200);
    });

    it('getTracker never throws and returns a prefixed key for every malformed body', async () => {
      const guard = new IdentityThrottlerGuard(
        { throttlers: [{ name: 'default', ttl: 60_000, limit: 60 }] },
        { increment: jest.fn() } as never,
        new Reflector(),
        { get: () => SECRET } as never,
      );
      const ctx = {
        getHandler: () => AuthController.prototype.sendOtp,
        getClass:   () => AuthController,
      } as never;
      const track = (req: Record<string, unknown>) =>
        (guard as unknown as { getTracker: (r: unknown, c: unknown) => Promise<string> }).getTracker(req, ctx);
      for (const body of [undefined, null, 'str', 42, [], {}, { phone: null }, { phone: {} }, { phone: '12345678901' }]) {
        await expect(track({ ip: '10.0.0.1', body })).resolves.toBe('ip:10.0.0.1');
      }
      await expect(track({ body: {} })).resolves.toBe('ip:unknown');
      const k = await track({ ip: '10.0.0.1', body: { phone: '9876543210' } });
      expect(k).toMatch(/^phone:[0-9a-f]{64}$/);
      expect(k).not.toContain('9876543210');
    });

    it('the throttle 429 logs a structured warn with route + key kind and NEVER the raw phone', async () => {
      const raw = '9123456789';
      for (let i = 0; i < 6; i++) await sendOtp({ phone: raw, channel: 'SMS', clientId: 'deoleo' });
      const text = allWarnText();
      expect(text).toContain('throttle.rejected');
      expect(text).toContain('send-otp');
      expect(text).toContain('"keyKind":"phone"');
      expect(text).toContain('6789');           // last-4 for support correlation
      expect(text).not.toContain(raw);
      expect(text).not.toContain('912345');     // no longer prefix of the number either
    });
  });

  describe('verify-otp (10/min) — keyed per phone', () => {
    it('same phone 11× → 11th refused; a different phone is unaffected', async () => {
      for (let i = 0; i < 10; i++) {
        expect((await verifyOtp({ phone: phone(4), otp: '123456', clientId: 'deoleo' })).status).toBe(200);
      }
      expect((await verifyOtp({ phone: phone(4), otp: '123456', clientId: 'deoleo' })).status).toBe(429);
      expect((await verifyOtp({ phone: phone(5), otp: '123456', clientId: 'deoleo' })).status).toBe(200);
    });

    it('send-otp and verify-otp buckets for one phone are independent (per-route, as before)', async () => {
      for (let i = 0; i < 5; i++) await sendOtp({ phone: phone(6), channel: 'SMS', clientId: 'deoleo' });
      expect((await sendOtp({ phone: phone(6), channel: 'SMS', clientId: 'deoleo' })).status).toBe(429);
      expect((await verifyOtp({ phone: phone(6), otp: '123456', clientId: 'deoleo' })).status).toBe(200);
    });

    it('rotating clientId cannot buy extra verify attempts on one phone (OTP rows are phone-keyed)', async () => {
      for (let i = 0; i < 10; i++) {
        expect((await verifyOtp({ phone: phone(7), otp: '000000', clientId: `t${i}` })).status).toBe(200);
      }
      expect((await verifyOtp({ phone: phone(7), otp: '000000', clientId: 't99' })).status).toBe(429);
    });
  });

  describe('authenticated routes — keyed per user', () => {
    const bearer = (sub: string) => `Bearer ${jwt.sign({ sub, clientId: 'deoleo', role: 'CHANNEL_PARTNER' })}`;
    const me = (auth?: string) => {
      const r = request(app.getHttpServer()).get('/probe/me');
      return auth ? r.set('Authorization', auth) : r;
    };

    it('two users from the same ip do not share a bucket', async () => {
      const a = bearer('user-a');
      const b = bearer('user-b');
      for (let i = 0; i < 3; i++) expect((await me(a)).status).toBe(200);
      expect((await me(a)).status).toBe(429);
      for (let i = 0; i < 3; i++) expect((await me(b)).status).toBe(200);
      const text = allWarnText();
      expect(text).toContain('"keyKind":"user"');
    });

    it('a fresh token for the same user shares that user\'s bucket', async () => {
      for (let i = 0; i < 3; i++) expect((await me(bearer('user-c'))).status).toBe(200);
      expect((await me(bearer('user-c'))).status).toBe(429);
    });

    it('invalid / wrong-secret / expired / missing token → IP fallback (shared ip bucket)', async () => {
      const wrongSecret = `Bearer ${new JwtService({ secret: 'other' }).sign({ sub: 'user-d' })}`;
      const expired = `Bearer ${jwt.sign({ sub: 'user-d', exp: Math.floor(Date.now() / 1000) - 60 })}`;
      expect((await me('Bearer not-a-jwt')).status).toBe(200);
      expect((await me(wrongSecret)).status).toBe(200);
      expect((await me(expired)).status).toBe(200);
      expect((await me()).status).toBe(429); // 4th IP-keyed hit
      expect(allWarnText()).toContain('"keyKind":"ip"');
      // a valid user is NOT caught by that exhausted ip bucket
      expect((await me(bearer('user-e'))).status).toBe(200);
    });

    it('a valid token whose payload has no sub → IP fallback', async () => {
      const noSub = `Bearer ${jwt.sign({ clientId: 'deoleo' })}`;
      for (let i = 0; i < 3; i++) expect((await me(noSub)).status).toBe(200);
      expect((await me()).status).toBe(429);
    });
  });

  describe('refresh (IP-keyed, own generous limit)', () => {
    it('stays IP-keyed (no phone marker) and carries its own 1000/min @Throttle', () => {
      expect(Reflect.getMetadata(THROTTLE_KEY_BY, AuthController.prototype.refresh)).toBeUndefined();
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', AuthController.prototype.refresh)).toBe(1000);
      expect(Reflect.getMetadata('THROTTLER:TTLdefault', AuthController.prototype.refresh)).toBe(60_000);
    });

    it('silent refresh from many users behind ONE ip is not capped at the 60/min global default', async () => {
      for (let i = 0; i < 75; i++) {
        const res = await request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken: `rt-${i}` });
        expect(res.status).toBe(200);
      }
    });
  });

  describe('unchanged behaviour', () => {
    it('@Public routes stay IP-keyed even when a valid bearer is present', async () => {
      const auth = `Bearer ${jwt.sign({ sub: 'user-f' })}`;
      for (let i = 0; i < 3; i++) {
        expect((await request(app.getHttpServer()).get('/probe/open').set('Authorization', auth)).status).toBe(200);
      }
      expect((await request(app.getHttpServer()).get('/probe/open')).status).toBe(429);
    });

    it('a body phone on a route WITHOUT the marker is ignored (IP-keyed)', async () => {
      for (let i = 0; i < 3; i++) {
        const res = await request(app.getHttpServer()).post('/probe/public-with-phone').send({ phone: phone(10 + i) });
        expect(res.status).toBe(200);
      }
      expect((await request(app.getHttpServer()).post('/probe/public-with-phone').send({ phone: phone(20) })).status).toBe(429);
    });

    it('@SkipThrottle routes are never throttled', async () => {
      for (let i = 0; i < 70; i++) {
        expect((await request(app.getHttpServer()).get('/probe/skipped')).status).toBe(200);
      }
    });
  });
});
