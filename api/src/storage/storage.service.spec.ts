import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { StorageService } from './storage.service';

const mockConfig = { get: jest.fn(() => undefined) };

describe('StorageService', () => {
  let service: StorageService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [StorageService, { provide: ConfigService, useValue: mockConfig }],
    }).compile();
    service = module.get(StorageService);
  });

  describe('generateKey', () => {
    it('namespaces by folder + YYYY-MM and a uuid, preserving the extension', () => {
      const key = service.generateKey('kyc', 'pan card.JPG');
      expect(key).toMatch(/^kyc\/\d{4}-\d{2}\/[0-9a-f-]+-pan_card\.JPG$/);
    });

    it('sanitizes unsafe filename characters', () => {
      const key = service.generateKey('docs', 'a/b*c?.pdf');
      // path.basename strips the dir; remaining unsafe chars become underscores
      expect(key).toMatch(/^docs\/\d{4}-\d{2}\/[0-9a-f-]+-.*\.pdf$/);
      expect(key).not.toContain('*');
      expect(key).not.toContain('?');
    });
  });
});
