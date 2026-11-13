import { Controller, INestApplication, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as fs from 'fs';
import * as path from 'path';
import request from 'supertest';
import { AllExceptionsFilter } from './filters/all-exceptions.filter';
import {
  fileTooLargeMessage,
  LimitedFileInterceptor,
  MEDIA_UPLOAD_MAX_BYTES,
  SPREADSHEET_UPLOAD_MAX_BYTES,
} from './upload-limits';

const LIMIT = 1024; // 1 KB for the test route

@Controller('t')
class UploadTestController {
  @Post('upload')
  @UseInterceptors(LimitedFileInterceptor('file', LIMIT))
  upload(@UploadedFile() file: Express.Multer.File) {
    return { size: file?.size ?? null };
  }

  @Post('filtered')
  @UseInterceptors(
    LimitedFileInterceptor('file', LIMIT, {
      fileFilter: (_req, f, cb) => cb(null, /\.xlsx$/i.test(f.originalname)),
    }),
  )
  filtered(@UploadedFile() file: Express.Multer.File) {
    return { got: !!file };
  }
}

describe('LimitedFileInterceptor (memory-safety: multer enforces the size before buffering)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ controllers: [UploadTestController] }).compile();
    app = mod.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it('accepts a file at/under the limit', async () => {
    const res = await request(app.getHttpServer())
      .post('/t/upload')
      .attach('file', Buffer.alloc(LIMIT, 1), 'a.bin');
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ size: LIMIT });
  });

  it('rejects an over-limit file with 413 and a clear message', async () => {
    const res = await request(app.getHttpServer())
      .post('/t/upload')
      .attach('file', Buffer.alloc(LIMIT + 1, 1), 'a.bin');
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ success: false, error: fileTooLargeMessage(LIMIT) });
  });

  it('passes other multer options (fileFilter) through', async () => {
    const ok = await request(app.getHttpServer()).post('/t/filtered').attach('file', Buffer.from('x'), 'a.xlsx');
    expect(ok.body).toEqual({ got: true });
    const skipped = await request(app.getHttpServer()).post('/t/filtered').attach('file', Buffer.from('x'), 'a.csv');
    expect(skipped.body).toEqual({ got: false });
  });

  it('message wording', () => {
    expect(fileTooLargeMessage(MEDIA_UPLOAD_MAX_BYTES)).toBe(
      'The file is too large — the limit is 5 MB. Please upload a smaller file.',
    );
    expect(fileTooLargeMessage(SPREADSHEET_UPLOAD_MAX_BYTES)).toContain('10 MB');
  });
});

/**
 * Regression sweep: every multer interceptor in a controller must carry a size limit.
 * A bare `FileInterceptor('file')` lets multer buffer up to Cloud Run's 32 MiB body cap
 * before any service-side size check runs.
 */
describe('every upload route has a multer size limit', () => {
  const SRC = path.resolve(__dirname, '..');
  function walk(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) return walk(p);
      return /\.controller\.ts$/.test(d.name) ? [p] : [];
    });
  }

  it('no unbounded FileInterceptor / FilesInterceptor / FileFieldsInterceptor / AnyFilesInterceptor', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const src = fs.readFileSync(file, 'utf8');
      const re = /(?<![A-Za-z])(FileInterceptor|FilesInterceptor|FileFieldsInterceptor|AnyFilesInterceptor)\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const window = src.slice(m.index, m.index + 300);
        if (!/fileSize\s*:/.test(window)) {
          const line = src.slice(0, m.index).split('\n').length;
          offenders.push(`${path.relative(SRC, file)}:${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
