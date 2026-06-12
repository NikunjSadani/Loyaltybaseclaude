// TDD: KycController
// Covers: submit, firstApprove, reject, bulkGst, bulkPennyDrop, gifsyApprove, approvePhoto, list

import { Test, TestingModule } from '@nestjs/testing';
import { KycController } from './kyc.controller';
import { KycService }    from './kyc.service';
import {
  SubmitKycDto, RejectKycDto, ApprovePhotoDto,
  BulkGstDto, BulkPennyDropDto,
} from './dto/kyc.dto';

const mockService = {
  submitKyc:                  jest.fn(),
  firstApprove:               jest.fn(),
  rejectKyc:                  jest.fn(),
  processBulkGstVerification: jest.fn(),
  processBulkPennyDrop:       jest.fn(),
  gifsyFinalApprove:          jest.fn(),
  approvePhoto:               jest.fn(),
  listSubmissions:            jest.fn(),
};

const user = { sub: 'user_1', role: 'SALES_ISR', clientId: 'deoleo' };

describe('KycController', () => {
  let controller: KycController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [KycController],
      providers:   [{ provide: KycService, useValue: mockService }],
    }).compile();
    controller = module.get<KycController>(KycController);
    jest.clearAllMocks();
  });

  it('should be defined', () => expect(controller).toBeDefined());

  // ── Submit ──────────────────────────────────────────────────────────────────

  it('POST /kyc/submit — delegates to service.submitKyc', async () => {
    mockService.submitKyc.mockResolvedValue({ id: 'kyc_1', status: 'PENDING_SO_APPROVAL' });

    const dto: SubmitKycDto = {
      partnerId: 'cp_1',
      phones: { XSR: '', SO: '9999999999', ASM: '', RSM: '', ZM: '', NM: '' },
    };
    const result = await controller.submit(user as any, dto);

    expect(mockService.submitKyc).toHaveBeenCalledWith(
      expect.objectContaining({ submitterUserId: 'user_1', submitterRole: 'SALES_ISR', clientId: 'deoleo', partnerId: 'cp_1' }),
    );
    expect(result.status).toBe('PENDING_SO_APPROVAL');
  });

  // ── First approve ────────────────────────────────────────────────────────────

  it('POST /kyc/:id/approve — delegates to service.firstApprove', async () => {
    const approver = { sub: 'user_2', role: 'SALES_SO', clientId: 'deoleo' };
    mockService.firstApprove.mockResolvedValue({ id: 'kyc_1', status: 'PENDING_GIFSY' });

    const result = await controller.firstApprove('kyc_1', approver as any);

    expect(mockService.firstApprove).toHaveBeenCalledWith('kyc_1', 'SALES_SO', 'user_2');
    expect(result.status).toBe('PENDING_GIFSY');
  });

  // ── Reject ──────────────────────────────────────────────────────────────────

  it('POST /kyc/:id/reject — delegates to service.rejectKyc', async () => {
    mockService.rejectKyc.mockResolvedValue({ id: 'kyc_1', status: 'REJECTED' });

    const dto: RejectKycDto = { reason: 'Invalid documents' };
    await controller.reject('kyc_1', user as any, dto);

    expect(mockService.rejectKyc).toHaveBeenCalledWith('kyc_1', 'SALES_ISR', 'user_1', 'Invalid documents');
  });

  // ── Bulk GST ─────────────────────────────────────────────────────────────────

  it('POST /kyc/bulk/gst — delegates to service.processBulkGstVerification', async () => {
    mockService.processBulkGstVerification.mockResolvedValue({ processed: 2, verified: 2, rejected: 0, errors: [] });
    const admin = { sub: 'admin_1', role: 'GIFSY_ADMIN', clientId: 'deoleo' };

    const dto: BulkGstDto = {
      rows: [
        { kycId: 'kyc_1', gstVerified: true,  reason: 'OK' },
        { kycId: 'kyc_2', gstVerified: true,  reason: 'OK' },
      ],
    };
    const result = await controller.bulkGst(admin as any, dto);

    expect(mockService.processBulkGstVerification).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ kycId: 'kyc_1' })]),
      'admin_1',
    );
    expect(result.processed).toBe(2);
  });

  // ── Bulk penny drop ──────────────────────────────────────────────────────────

  it('POST /kyc/bulk/penny-drop — delegates to service.processBulkPennyDrop', async () => {
    mockService.processBulkPennyDrop.mockResolvedValue({ processed: 1, verified: 1, rejected: 0, errors: [] });
    const admin = { sub: 'admin_1', role: 'GIFSY_ADMIN', clientId: 'deoleo' };

    const dto: BulkPennyDropDto = {
      rows: [{ kycId: 'kyc_1', bankVerified: true, reason: 'Penny drop success' }],
    };
    const result = await controller.bulkPennyDrop(admin as any, dto);

    expect(mockService.processBulkPennyDrop).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ kycId: 'kyc_1' })]),
      'admin_1',
    );
    expect(result.verified).toBe(1);
  });

  // ── Gifsy final approve ──────────────────────────────────────────────────────

  it('POST /kyc/:id/gifsy-approve — delegates to service.gifsyFinalApprove', async () => {
    mockService.gifsyFinalApprove.mockResolvedValue({ id: 'kyc_1', status: 'APPROVED' });
    const admin = { sub: 'admin_1', role: 'GIFSY_ADMIN', clientId: 'deoleo' };

    const result = await controller.gifsyApprove('kyc_1', admin as any);

    expect(mockService.gifsyFinalApprove).toHaveBeenCalledWith('kyc_1', 'admin_1');
    expect(result.status).toBe('APPROVED');
  });

  // ── Photo approve ────────────────────────────────────────────────────────────

  it('POST /kyc/:id/photo — delegates to service.approvePhoto', async () => {
    mockService.approvePhoto.mockResolvedValue(undefined);
    const admin = { sub: 'admin_1', role: 'GIFSY_ADMIN', clientId: 'deoleo' };

    const dto: ApprovePhotoDto = { approved: true };
    await controller.approvePhoto('kyc_1', admin as any, dto);

    expect(mockService.approvePhoto).toHaveBeenCalledWith('kyc_1', 'admin_1', true, undefined);
  });

  // ── List ─────────────────────────────────────────────────────────────────────

  it('GET /kyc — delegates to service.listSubmissions', async () => {
    mockService.listSubmissions.mockResolvedValue({ data: [], total: 0, page: 1 });

    const result = await controller.list({ status: 'PENDING_GIFSY', page: '1', limit: '20' });

    expect(mockService.listSubmissions).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'PENDING_GIFSY', page: 1, limit: 20 }),
    );
    expect(result.total).toBe(0);
  });
});
