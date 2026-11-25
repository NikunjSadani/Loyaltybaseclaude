/**
 * Target upload preview → confirm (owner decision 2026-11-25): the controller dispatch + the query DTO.
 * The service behaviour (preview writes nothing, apply == preview, double-apply guard) is in targets.service.spec.ts.
 */
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { TargetsController } from './targets.controller';
import { UploadTargetsQueryDto } from './dto/targets.dto';
import type { TargetsService } from './targets.service';
import type { ExportsService } from '../exports/exports.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { JwtPayload } from '../common/decorators/current-user.decorator';

const user = { sub: 'u1', clientId: 'c1', role: 'CLIENT_ADMIN', phone: '', name: '' } as JwtPayload;
const file = { buffer: Buffer.from('x'), originalname: 't.xlsx' } as Express.Multer.File;
const TOKEN = `${'a'.repeat(64)}.${'b'.repeat(32)}`;

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

  it('?confirmToken= → apply with that token', async () => {
    const { ctrl, targets } = make();
    await ctrl.uploadTargets(user, file, { confirmToken: TOKEN });
    expect(targets.uploadTargets).toHaveBeenCalledWith(user, file, { confirmToken: TOKEN });
    expect(targets.previewTargetUpload).not.toHaveBeenCalled();
  });

  it('no params → direct apply, exactly as before (scripts / e2e harness)', async () => {
    const { ctrl, targets } = make();
    await ctrl.uploadTargets(user, file, {});
    expect(targets.uploadTargets).toHaveBeenCalledWith(user, file, undefined);
  });
});

describe('UploadTargetsQueryDto', () => {
  const errs = (q: Record<string, unknown>) =>
    validateSync(plainToInstance(UploadTargetsQueryDto, q), { whitelist: true, forbidNonWhitelisted: true });

  it('accepts preview=1 and a well-formed confirmToken', () => {
    expect(errs({ preview: '1' })).toHaveLength(0);
    expect(errs({ confirmToken: TOKEN })).toHaveLength(0);
    expect(errs({})).toHaveLength(0);
  });

  it('rejects a malformed token and an unknown preview value', () => {
    expect(errs({ confirmToken: 'abc' })).not.toHaveLength(0);
    expect(errs({ preview: 'yes' })).not.toHaveLength(0);
  });
});
