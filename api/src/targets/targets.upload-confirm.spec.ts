/**
 * Target upload preview → confirm (owner decision 2026-11-25): the controller dispatch + the query DTO.
 * The service behaviour (preview writes nothing, apply == preview, double-apply guard) is in targets.service.spec.ts.
 */
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { TargetsController } from './targets.controller';
import { UploadTargetsQueryDto } from './dto/targets.dto';
import { TargetsService } from './targets.service';
import type { ExportsService } from '../exports/exports.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { JwtPayload } from '../common/decorators/current-user.decorator';

const user = { sub: 'u1', clientId: 'c1', role: 'CLIENT_ADMIN', phone: '', name: '' } as JwtPayload;
const file = { buffer: Buffer.from('x'), originalname: 't.xlsx' } as Express.Multer.File;
const TOKEN = `${'a'.repeat(64)}.${'b'.repeat(32)}.${'1'.repeat(13)}.${'c'.repeat(64)}`;

function make() {
  const targets = {
    previewTargetUpload: jest.fn().mockResolvedValue({ preview: true }),
    uploadTargets: jest.fn().mockResolvedValue({ batchId: 'b1' }),
  };
  const ctrl = new TargetsController(
    targets as unknown as TargetsService,
    {} as ExportsService,
    {} as PrismaService,
  );
  return { ctrl, targets };
}

describe('POST /admin/targets/upload dispatch', () => {
  it('?preview=1 → previewTargetUpload only (never the apply)', async () => {
    const { ctrl, targets } = make();
    await ctrl.uploadTargets(user, file, { preview: '1' });
    expect(targets.previewTargetUpload).toHaveBeenCalledWith(user, file);
    expect(targets.uploadTargets).not.toHaveBeenCalled();
  });

  it('?preview=1 wins even when a confirmToken is also sent (preview never writes)', async () => {
    const { ctrl, targets } = make();
    await ctrl.uploadTargets(user, file, { preview: 'true', confirmToken: TOKEN });
    expect(targets.uploadTargets).not.toHaveBeenCalled();
  });

  it('?confirmToken=&ack= → apply with that token and the acknowledgements bound to count + fingerprint', async () => {
    const { ctrl, targets } = make();
    await ctrl.uploadTargets(user, file, { confirmToken: TOKEN, ack: 'REJECTED_ROWS:1:0123456789abcdef,OVERWRITE:12:fedcba9876543210' });
    expect(targets.uploadTargets).toHaveBeenCalledWith(user, file, {
      confirmToken: TOKEN,
      acknowledged: [
        { category: 'REJECTED_ROWS', count: 1, fingerprint: '0123456789abcdef' },
        { category: 'OVERWRITE', count: 12, fingerprint: 'fedcba9876543210' },
      ],
    });
    expect(targets.previewTargetUpload).not.toHaveBeenCalled();
  });

  it('?confirmToken= without ack → apply with NO acknowledgements (the service then enforces them)', async () => {
    const { ctrl, targets } = make();
    await ctrl.uploadTargets(user, file, { confirmToken: TOKEN });
    expect(targets.uploadTargets).toHaveBeenCalledWith(user, file, { confirmToken: TOKEN, acknowledged: [] });
  });

  it('no params → handed to the service WITHOUT a token, which refuses it ("Preview the file first") for every tenant', async () => {
    const { ctrl, targets } = make();
    await ctrl.uploadTargets(user, file, {});
    expect(targets.uploadTargets).toHaveBeenCalledWith(user, file, undefined);
    expect(TargetsService.confirmRequired(user.clientId)).toBe(true);
  });
});

describe('GET /admin/targets/batches/:id/file', () => {
  it('streams the kept file as an attachment, never cached, with a sanitised name', async () => {
    const { Readable } = await import('node:stream');
    const openBatchFile = jest.fn().mockResolvedValue({
      stream: Readable.from(['abc']), size: 3, contentType: 'application/vnd.ms-excel', fileName: 'Q4 "targets"\r\n.xlsx',
    });
    const ctrl = new TargetsController(
      { openBatchFile } as unknown as TargetsService, {} as ExportsService, {} as PrismaService,
    );
    const headers: Record<string, string> = {};
    const res = { setHeader: (k: string, v: string) => { headers[k] = v; }, once: jest.fn() };
    const out = await ctrl.downloadBatchFile(user, 'tgtup_x', res as never);
    expect(openBatchFile).toHaveBeenCalledWith(user, 'tgtup_x');
    expect(headers['Cache-Control']).toBe('no-store');
    const h = out.getHeaders();
    expect(h.disposition).toBe('attachment; filename="Q4 _targets_.xlsx"');
    expect(h.length).toBe(3);
  });
});

describe('UploadTargetsQueryDto', () => {
  const errs = (q: Record<string, unknown>) =>
    validateSync(plainToInstance(UploadTargetsQueryDto, q), { whitelist: true, forbidNonWhitelisted: true });

  it('accepts preview=1 and a well-formed confirmToken', () => {
    expect(errs({ preview: '1' })).toHaveLength(0);
    expect(errs({ confirmToken: TOKEN })).toHaveLength(0);
    expect(errs({})).toHaveLength(0);
    expect(errs({ confirmToken: TOKEN, ack: '' })).toHaveLength(0);
    expect(errs({ confirmToken: TOKEN, ack: 'REJECTED_ROWS:1:0123456789abcdef,OVERWRITE:12:fedcba9876543210' })).toHaveLength(0);
    // a well-shaped but forged token passes validation ON PURPOSE: the service refuses AND audits it
    expect(errs({ confirmToken: 'abc' })).toHaveLength(0);
  });

  it('rejects garbage characters / lengths and an unknown preview value', () => {
    expect(errs({ confirmToken: 'not a token!' })).not.toHaveLength(0);
    expect(errs({ confirmToken: 'a'.repeat(301) })).not.toHaveLength(0);
    expect(errs({ preview: 'yes' })).not.toHaveLength(0);
    expect(errs({ ack: 'OVERWRITE;DROP' })).not.toHaveLength(0);
  });
});
