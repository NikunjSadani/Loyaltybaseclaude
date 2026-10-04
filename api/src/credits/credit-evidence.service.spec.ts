import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CreditEvidenceService } from './credit-evidence.service';
import type { JwtPayload } from '../common/decorators/current-user.decorator';

/**
 * CreditEvidenceService — B1 batch audit-evidence.
 * Covers the security-relevant branches: tenant isolation, magic-byte type gate (client
 * mimetype ignored), size/count caps, add-only-after-confirm, and view-key tenant pinning.
 */

const USER: JwtPayload = { sub: 'u1', role: 'CLIENT_ADMIN', clientId: 'deoleo' } as JwtPayload;

// A minimal valid PNG (8-byte signature + filler) so sniffFileType accepts it.
function pngBuf(): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
}
function pngFile(name = 'audit.png', size?: number): Express.Multer.File {
  const buffer = pngBuf();
  return { originalname: name, buffer, size: size ?? buffer.length } as Express.Multer.File;
}

function makeService(over: {
  batch?: unknown;
  count?: number;
  attachment?: unknown;
} = {}) {
  const prisma = {
    creditBatch: {
      findFirst: jest.fn().mockResolvedValue(
        over.batch === undefined
          ? { id: 'b1', clientId: 'deoleo', status: 'PENDING_CONFIRM' }
          : over.batch,
      ),
    },
    creditBatchAttachment: {
      count: jest.fn().mockResolvedValue(over.count ?? 0),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(over.attachment ?? null),
      findFirst: jest.fn().mockResolvedValue(over.attachment ?? null),
      delete: jest.fn().mockResolvedValue({}),
    },
  };
  const storage = {
    generateKey: jest.fn((folder: string, name: string) => `${folder}/uuid-${name}`),
    uploadFile: jest.fn().mockResolvedValue('gs://bucket/key'),
    downloadBytes: jest.fn().mockResolvedValue({ bytes: pngBuf(), contentType: 'image/png' }),
    deleteFile: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new CreditEvidenceService(prisma as never, storage as never);
  return { svc, prisma, storage };
}

describe('CreditEvidenceService', () => {
  it('uploads valid files to a tenant-foldered key and persists metadata', async () => {
    const { svc, prisma, storage } = makeService();
    await svc.uploadEvidence(USER, 'b1', [pngFile()]);
    expect(storage.uploadFile).toHaveBeenCalledTimes(1);
    // key must be under credit-evidence/<clientId>/<batchId>/
    const key = storage.generateKey.mock.calls[0][0];
    expect(key).toBe('credit-evidence/deoleo/b1');
    expect(prisma.creditBatchAttachment.createMany).toHaveBeenCalledTimes(1);
    const data = prisma.creditBatchAttachment.createMany.mock.calls[0][0].data;
    expect(data[0]).toMatchObject({ clientId: 'deoleo', batchId: 'b1', contentType: 'image/png', uploadedById: 'u1' });
  });

  it('404s when the batch is not in the caller tenant', async () => {
    const { svc, storage } = makeService({ batch: null });
    await expect(svc.uploadEvidence(USER, 'b1', [pngFile()])).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.uploadFile).not.toHaveBeenCalled();
  });

  it('rejects a disguised file by magic bytes even if the name looks fine', async () => {
    const { svc, storage } = makeService();
    const htmlAsPng = { originalname: 'evil.png', buffer: Buffer.from('<html>x</html>'), size: 14 } as Express.Multer.File;
    await expect(svc.uploadEvidence(USER, 'b1', [htmlAsPng])).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.uploadFile).not.toHaveBeenCalled();
  });

  it('rejects an oversize file and stores nothing', async () => {
    const { svc, storage } = makeService();
    await expect(svc.uploadEvidence(USER, 'b1', [pngFile('big.png', 11 * 1024 * 1024)])).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(storage.uploadFile).not.toHaveBeenCalled();
  });

  it('rejects when no files are provided', async () => {
    const { svc } = makeService();
    await expect(svc.uploadEvidence(USER, 'b1', [])).rejects.toBeInstanceOf(BadRequestException);
  });

  it('enforces the per-batch total cap', async () => {
    const { svc, storage } = makeService({ count: 100 });
    await expect(svc.uploadEvidence(USER, 'b1', [pngFile()])).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.uploadFile).not.toHaveBeenCalled();
  });

  it('validates ALL files before storing ANY (one bad file fails the whole upload)', async () => {
    const { svc, storage } = makeService();
    const bad = { originalname: 'x.png', buffer: Buffer.from('nope'), size: 4 } as Express.Multer.File;
    await expect(svc.uploadEvidence(USER, 'b1', [pngFile(), bad])).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.uploadFile).not.toHaveBeenCalled();
  });

  it('view: streams inline for an image owned by the tenant', async () => {
    const { svc } = makeService({
      attachment: { clientId: 'deoleo', fileKey: 'credit-evidence/deoleo/b1/uuid-a.png', fileName: 'a.png', contentType: 'image/png' },
    });
    const out = await svc.viewEvidence(USER, 'att1');
    expect(out.inline).toBe(true);
    expect(out.contentType).toBe('image/png');
  });

  it('view: serves a PDF as a download (not inline) so embedded JS cannot run in-origin', async () => {
    const { svc, storage } = makeService({
      attachment: { clientId: 'deoleo', fileKey: 'credit-evidence/deoleo/b1/uuid-a.pdf', fileName: 'a.pdf', contentType: 'application/pdf' },
    });
    storage.downloadBytes.mockResolvedValueOnce({ bytes: Buffer.from('%PDF-1.4'), contentType: 'application/pdf' });
    const out = await svc.viewEvidence(USER, 'att1');
    expect(out.inline).toBe(false);
    expect(out.contentType).toBe('application/pdf');
  });

  it('upload: cleans up already-stored objects when a later GCS write fails (no orphans)', async () => {
    const { svc, storage } = makeService();
    storage.uploadFile.mockResolvedValueOnce('ok').mockRejectedValueOnce(new Error('gcs down'));
    await expect(svc.uploadEvidence(USER, 'b1', [pngFile('a.png'), pngFile('b.png')])).rejects.toThrow();
    expect(storage.deleteFile).toHaveBeenCalledTimes(1); // the first (successfully uploaded) object
  });

  it('view: 404s a cross-tenant attachment', async () => {
    const { svc } = makeService({
      attachment: { clientId: 'OTHER', fileKey: 'credit-evidence/OTHER/b1/uuid-a.png', fileName: 'a.png', contentType: 'image/png' },
    });
    await expect(svc.viewEvidence(USER, 'att1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('view: 404s when the key tenant folder does not match the caller (defence-in-depth)', async () => {
    const { svc } = makeService({
      // clientId row says deoleo but the key path points elsewhere → deny
      attachment: { clientId: 'deoleo', fileKey: 'credit-evidence/OTHER/b1/uuid-a.png', fileName: 'a.png', contentType: 'image/png' },
    });
    await expect(svc.viewEvidence(USER, 'att1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('delete: removes an attachment while the batch is PENDING_CONFIRM', async () => {
    const { svc, prisma, storage } = makeService({
      attachment: { id: 'att1', fileKey: 'credit-evidence/deoleo/b1/uuid-a.png' },
    });
    await svc.deleteEvidence(USER, 'b1', 'att1');
    expect(prisma.creditBatchAttachment.delete).toHaveBeenCalledWith({ where: { id: 'att1' } });
    expect(storage.deleteFile).toHaveBeenCalled();
  });

  it('delete: blocked once the batch is CONFIRMED (add-only audit trail)', async () => {
    const { svc, prisma } = makeService({ batch: { id: 'b1', clientId: 'deoleo', status: 'CONFIRMED' } });
    await expect(svc.deleteEvidence(USER, 'b1', 'att1')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.creditBatchAttachment.delete).not.toHaveBeenCalled();
  });
});
