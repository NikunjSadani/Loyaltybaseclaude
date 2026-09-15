import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateRewardCatalogDto, UpdateRewardCatalogDto } from './rewards.dto';

/**
 * Regression: an UPLOADED gift image resolves to the same-origin proxy path
 * `/api/gift-images?key=...`, which `@IsUrl` rejected ("each value in imageUrls
 * must be a URL address"). `@IsImageRef` must now accept it while still
 * rejecting non-URL garbage.
 */
describe('reward catalog DTO — imageUrls accepts the upload proxy path', () => {
  const base = {
    categoryId: 'cat1',
    code: 'C1',
    name: 'Gift',
    pointsCost: 100,
    redemptionMode: 'GIFT_CARD',
  };

  it('accepts an uploaded proxy path in imageUrls (no errors)', async () => {
    const dto = plainToInstance(CreateRewardCatalogDto, {
      ...base,
      imageUrls: ['/api/gift-images?key=x'],
    });
    const errors = await validate(dto);
    const imageErr = errors.find((e) => e.property === 'imageUrls');
    expect(imageErr).toBeUndefined();
  });

  it('accepts an absolute URL in imageUrls (no errors)', async () => {
    const dto = plainToInstance(CreateRewardCatalogDto, {
      ...base,
      imageUrls: ['https://cdn.example.com/a.jpg'],
    });
    const errors = await validate(dto);
    const imageErr = errors.find((e) => e.property === 'imageUrls');
    expect(imageErr).toBeUndefined();
  });

  it('rejects a non-URL string in imageUrls', async () => {
    const dto = plainToInstance(UpdateRewardCatalogDto, {
      imageUrls: ['nope'],
    });
    const errors = await validate(dto);
    const imageErr = errors.find((e) => e.property === 'imageUrls');
    expect(imageErr).toBeDefined();
    expect(Object.values(imageErr!.constraints!).join(' ')).toContain(
      'must be an image URL or uploaded image reference',
    );
  });
});
