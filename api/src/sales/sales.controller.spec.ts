// TDD: SalesController (non-file-upload endpoints only)
import { Test, TestingModule } from '@nestjs/testing';
import { SalesController }  from './sales.controller';
import { SalesService }     from './sales.service';
import { CreateUploadDto, ProcessRowsDto } from './dto/sales.dto';

const mockService = {
  createUpload:           jest.fn(),
  processPointsAwardRows: jest.fn(),
  listUploads:            jest.fn(),
};

const admin = { sub: 'admin_1', role: 'GIFSY_ADMIN', clientId: 'deoleo', name: 'Admin', phone: '9999999999' };

describe('SalesController', () => {
  let controller: SalesController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SalesController],
      providers: [{ provide: SalesService, useValue: mockService }],
    }).compile();
    controller = module.get<SalesController>(SalesController);
    jest.clearAllMocks();
  });

  it('should be defined', () => expect(controller).toBeDefined());

  it('POST /sales/uploads — creates an upload record (file already on GCS)', async () => {
    mockService.createUpload.mockResolvedValue({ id: 'upload_1', status: 'PENDING' });

    const dto: CreateUploadDto = {
      fileName:      'june-sales.xlsx',
      fileUrl:       'gs://gifsy-platform-files/june-sales.xlsx',
      fileKey:       'june-sales.xlsx',
      fileSizeBytes: 4096,
    };
    const result = await controller.createUpload(dto, admin as any);

    expect(mockService.createUpload).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: 'june-sales.xlsx', clientId: 'deoleo' }),
    );
    expect(result.status).toBe('PENDING');
  });

  it('POST /sales/uploads/:id/process — processes pre-parsed rows', async () => {
    mockService.processPointsAwardRows.mockResolvedValue({ processedRows: 1, successRows: 1 });

    const dto: ProcessRowsDto = {
      rows: [{ partnerId: 'cp_1', skuCode: 'SKU-001', invoicePoints: 50 }],
    };
    const result = await controller.processRows('upload_1', dto, admin as any);

    expect(mockService.processPointsAwardRows).toHaveBeenCalledWith('deoleo', 'upload_1', dto.rows);
    expect(result.successRows).toBe(1);
  });

  it('GET /sales/uploads — lists uploads for client', async () => {
    mockService.listUploads.mockResolvedValue({ data: [], total: 0 });
    const result = await controller.listUploads(admin as any, {});
    expect(mockService.listUploads).toHaveBeenCalledWith('deoleo', expect.any(Object));
    expect(result.total).toBe(0);
  });
});
