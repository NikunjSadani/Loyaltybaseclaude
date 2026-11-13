import { Controller, Get, INestApplication, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import { createHash } from 'crypto';
import * as http from 'node:http';
import { PassThrough, Readable } from 'node:stream';
import request from 'supertest';
import { StorageService } from '../storage/storage.service';
import { VisibilityMediaService } from '../visibility/visibility-media.service';
import { streamObjectResponse } from './stream-object';

/**
 * Memory-safety (2026-11-13): photo/document proxies stream from storage instead of
 * buffering the whole object. These tests drive a real HTTP server through
 * streamObjectResponse — the helper every proxy controller now returns.
 */
let nextStream: () => Readable;
const created: Readable[] = [];

@Controller('media')
class MediaTestController {
  @Get()
  view(@Query('kind') kind: string, @Res({ passthrough: true }) res: Response) {
    const stream = nextStream();
    created.push(stream);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return streamObjectResponse(res, { stream, size: kind === 'big' ? 3 * 64 * 1024 : 5 }, {
      type: 'image/jpeg',
      disposition: 'inline',
    });
  }
}

describe('streamObjectResponse (media proxies stream, never buffer)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ controllers: [MediaTestController] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    created.length = 0;
  });

  it('pipes the object with type, inline disposition, Content-Length and the caller headers', async () => {
    nextStream = () => Readable.from([Buffer.from('ab'), Buffer.from('cde')]);
    const res = await request(app.getHttpServer()).get('/media').buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).toString()).toBe('abcde');
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['content-disposition']).toBe('inline');
    expect(res.headers['content-length']).toBe('5');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('a storage error before any byte is sent → bare 404 envelope, never the storage message', async () => {
    nextStream = () => {
      const s = new PassThrough();
      setImmediate(() => s.destroy(new Error('No such object: gifsy-bucket/kyc/secret.pdf')));
      return s;
    };
    const res = await request(app.getHttpServer()).get('/media');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Not found' });
    expect(JSON.stringify(res.body)).not.toContain('gifsy-bucket');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('destroys the storage stream when the client aborts mid-transfer', async () => {
    let src!: PassThrough;
    nextStream = () => {
      src = new PassThrough();
      src.write(Buffer.alloc(64 * 1024, 1)); // first chunk, then stall (never ends)
      return src;
    };
    const server = app.getHttpServer();
    if (!server.listening) await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve) => {
      const req = http.get({ port, path: '/media?kind=big' }, (res) => {
        res.once('data', () => {
          req.destroy(); // client goes away after the first chunk
          resolve();
        });
      });
      req.on('error', () => resolve());
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(src.destroyed).toBe(true);
  });
});

describe('StorageService.openBoundedObject', () => {
  async function svcWith(stat: { size: number; contentType: string } | null) {
    const mod = await Test.createTestingModule({
      providers: [StorageService, { provide: ConfigService, useValue: { get: () => undefined } }],
    }).compile();
    const svc = mod.get(StorageService);
    jest.spyOn(svc, 'statObject').mockResolvedValue(stat);
    const open = jest.spyOn(svc, 'openReadStream').mockReturnValue(Readable.from([Buffer.from('x')]));
    return { svc, open };
  }

  it('returns null (no read opened) for a missing object', async () => {
    const { svc, open } = await svcWith(null);
    await expect(svc.openBoundedObject('k')).resolves.toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it('returns null (no read opened) when the object exceeds the cap', async () => {
    const { svc, open } = await svcWith({ size: 6 * 1024 * 1024, contentType: 'image/png' });
    await expect(svc.openBoundedObject('k', 5 * 1024 * 1024)).resolves.toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it('returns the stream + stored size/type within the cap', async () => {
    const { svc, open } = await svcWith({ size: 1234, contentType: 'image/png' });
    const out = await svc.openBoundedObject('k');
    expect(out).toEqual({ stream: expect.any(Readable), size: 1234, contentType: 'image/png' });
    expect(open).toHaveBeenCalledWith('k');
  });
});

describe('VisibilityMediaService.computeImageHashFromStream', () => {
  const svc = new VisibilityMediaService({} as never);

  it('equals the buffered SHA-256 for the same bytes', async () => {
    const bytes = Buffer.from('a fairly ordinary photo payload');
    const streamed = await svc.computeImageHashFromStream(
      Readable.from([bytes.subarray(0, 7), bytes.subarray(7)]),
    );
    expect(streamed).toBe(svc.computeImageHash(bytes));
    expect(streamed).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('returns null when the stream errors (photo skipped, as a failed download was before)', async () => {
    const s = new PassThrough();
    setImmediate(() => s.destroy(new Error('boom')));
    await expect(svc.computeImageHashFromStream(s)).resolves.toBeNull();
  });
});
