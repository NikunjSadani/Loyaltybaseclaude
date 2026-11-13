import { Readable } from 'node:stream';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { KycController } from '../../kyc/kyc.controller';
import { ExportsService } from '../../exports/exports.service';
import { KycService } from '../../kyc/kyc.service';
import { SchemeReportController } from '../../schemes/scheme-report.controller';
import { SchemeReportService } from '../../schemes/scheme-report.service';
import { SchemeNotifyService } from '../../schemes/scheme-notify.service';
import { IdentityThrottlerGuard } from './identity-throttler.guard';


// Dozens of sequential supertest round-trips per test: under full-suite load these exceed jest's
// 5 s default (seen 2026-11-10), so give the HTTP-loop tests real headroom.
jest.setTimeout(30_000);
/**
 * L3 (audit 2026-11-10) — the two PUBLIC tokenized viewers sit behind the same shared-IP root cause
 * as login: a reviewer's gallery fires one GET per document/photo through the Next rewrite (one IP),
 * so at the 60/min global default every reviewer on every tenant shared one bucket → broken images.
 * Each request is authorised SOLELY by an HS256-signed, short-lived, single-object token
 * (typ 'docview' / 'schememedia'; any failure → bare 404), so — exactly like gift-image — they are
 * exempt with @SkipThrottle.
 */
describe('tokenized viewers are not throttled (L3)', () => {
  let app: INestApplication;
  const bytes = Buffer.from('img');
  const kyc = { viewDocument: jest.fn().mockImplementation(async () => ({ stream: Readable.from([bytes]), size: bytes.length, contentType: 'image/png', inline: true })) };
  const reports = { viewMediaByToken: jest.fn().mockImplementation(async () => ({ stream: Readable.from([bytes]), size: bytes.length, contentType: 'image/png', inline: true })) };

  beforeEach(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret';
    const mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 60_000, limit: 60 }] }),
      ],
      controllers: [KycController, SchemeReportController],
      providers: [
        { provide: KycService, useValue: kyc },
        // KycController's export endpoints (review-dump / rejected-export) go through ExportsService.
        { provide: ExportsService, useValue: {} },
        { provide: SchemeReportService, useValue: reports },
        { provide: SchemeNotifyService, useValue: {} },
        { provide: APP_GUARD, useClass: IdentityThrottlerGuard },
      ],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterEach(async () => { await app.close(); });

  it('both handlers carry @SkipThrottle metadata', () => {
    expect(Reflect.getMetadata('THROTTLER:SKIPdefault', KycController.prototype.viewDocument)).toBe(true);
    expect(Reflect.getMetadata('THROTTLER:SKIPdefault', SchemeReportController.prototype.viewMedia)).toBe(true);
  });

  it('GET /kyc/documents/view: 80 views from one IP in a minute are all served', async () => {
    for (let i = 0; i < 80; i++) {
      const res = await request(app.getHttpServer()).get(`/kyc/documents/view?token=t${i}`);
      expect(res.status).toBe(200);
    }
    expect(kyc.viewDocument).toHaveBeenCalledTimes(80);
  });

  it('GET /schemes/media/view: 80 views from one IP in a minute are all served', async () => {
    for (let i = 0; i < 80; i++) {
      const res = await request(app.getHttpServer()).get(`/schemes/media/view?token=t${i}`);
      expect(res.status).toBe(200);
    }
    expect(reports.viewMediaByToken).toHaveBeenCalledTimes(80);
  });

  it('response headers are unchanged (no-store, nosniff)', async () => {
    const res = await request(app.getHttpServer()).get('/kyc/documents/view?token=x');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
