// TDD: AuthController
// Integration tests — verifies HTTP layer behaviour

import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { Reflector } from '@nestjs/core';

const mockAuthService = {
  sendOtp:     jest.fn(),
  verifyOtp:   jest.fn(),
  refreshToken: jest.fn(),
};

describe('AuthController', () => {
  let controller: AuthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: mockAuthService },
        Reflector,
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('sendOtp', () => {
    it('should call authService.sendOtp with phone and channel', async () => {
      mockAuthService.sendOtp.mockResolvedValue({ success: true, expiresIn: 600 });

      const result = await controller.sendOtp({ phone: '9876543210', channel: 'SMS' });

      expect(mockAuthService.sendOtp).toHaveBeenCalledWith('9876543210', 'SMS');
      expect(result.success).toBe(true);
    });
  });

  describe('verifyOtp', () => {
    it('should call authService.verifyOtp and return tokens', async () => {
      const tokens = { accessToken: 'jwt.token', refreshToken: 'refresh.token', user: {} };
      mockAuthService.verifyOtp.mockResolvedValue(tokens);

      const result = await controller.verifyOtp({
        phone: '9876543210', otp: '1234', clientId: 'deoleo',
      });

      expect(mockAuthService.verifyOtp).toHaveBeenCalledWith('9876543210', '1234', 'deoleo');
      expect(result.accessToken).toBe('jwt.token');
    });
  });

  describe('me', () => {
    it('should return user info from JWT payload', () => {
      const payload = { sub: 'user_1', role: 'RETAILER', clientId: 'deoleo', phone: '9876543210', name: 'Test User' };
      const result  = controller.me(payload);

      expect(result).toEqual({ id: 'user_1', role: 'RETAILER', clientId: 'deoleo' });
    });
  });
});
