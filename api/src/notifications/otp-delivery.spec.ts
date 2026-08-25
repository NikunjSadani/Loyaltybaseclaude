// Unit tests for captureOtpDeliveryHandle — the light D1 OTP delivery-handle capture (Wave 3).
// Verifies: the guarded SENT + requestId write, a null requestId (DEV bypass) still marked SENT,
// the falsy-id no-op, and the never-throws safety contract (a DB failure must not break OTP send).
// Run: npx jest src/notifications/otp-delivery.spec.ts

import { captureOtpDeliveryHandle } from './otp-delivery';
import type { PrismaService } from '../prisma/prisma.service';

function makePrisma() {
  return {
    otpCode: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  } as unknown as PrismaService & { otpCode: { updateMany: jest.Mock } };
}

describe('captureOtpDeliveryHandle', () => {
  it('writes msg91RequestId + deliveryStatus SENT, guarded on deliveryStatus null', async () => {
    const prisma = makePrisma();
    await captureOtpDeliveryHandle(prisma, 'otp_1', { requestId: 'req-abc' });
    expect(prisma.otpCode.updateMany).toHaveBeenCalledWith({
      where: { id: 'otp_1', deliveryStatus: null },
      data: { msg91RequestId: 'req-abc', deliveryStatus: 'SENT' },
    });
  });

  it('stores a null requestId (DEV bypass) but still marks the row SENT', async () => {
    const prisma = makePrisma();
    await captureOtpDeliveryHandle(prisma, 'otp_1', { requestId: null });
    expect(prisma.otpCode.updateMany).toHaveBeenCalledWith({
      where: { id: 'otp_1', deliveryStatus: null },
      data: { msg91RequestId: null, deliveryStatus: 'SENT' },
    });
  });

  it('treats an undefined sendResult as a null requestId', async () => {
    const prisma = makePrisma();
    await captureOtpDeliveryHandle(prisma, 'otp_1', undefined);
    expect(prisma.otpCode.updateMany.mock.calls[0][0].data.msg91RequestId).toBeNull();
  });

  it('is a no-op when the otpCodeId is falsy', async () => {
    const prisma = makePrisma();
    await captureOtpDeliveryHandle(prisma, undefined, { requestId: 'req-abc' });
    await captureOtpDeliveryHandle(prisma, null, { requestId: 'req-abc' });
    expect(prisma.otpCode.updateMany).not.toHaveBeenCalled();
  });

  it('NEVER throws — a DB failure is swallowed so OTP send/verify is unaffected', async () => {
    const prisma = makePrisma();
    prisma.otpCode.updateMany.mockRejectedValueOnce(new Error('db down'));
    await expect(captureOtpDeliveryHandle(prisma, 'otp_1', { requestId: 'req-abc' })).resolves.toBeUndefined();
  });
});
