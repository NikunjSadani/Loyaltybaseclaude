import { validate } from 'class-validator';
import { IsArray, IsOptional } from 'class-validator';
import { isImageRef, IsImageRef } from './is-image-ref.validator';

describe('isImageRef (predicate)', () => {
  it('accepts absolute https URLs', () => {
    expect(isImageRef('https://x.com/a.jpg')).toBe(true);
  });

  it('accepts absolute http URLs', () => {
    expect(isImageRef('http://x.com/a.jpg')).toBe(true);
  });

  it('accepts the gift-image proxy path with a query', () => {
    expect(isImageRef('/api/gift-images?key=abc')).toBe(true);
  });

  it('accepts the bare gift-image proxy path', () => {
    expect(isImageRef('/api/gift-images')).toBe(true);
  });

  // Superset guard: the previous `@IsUrl()` used validator.js defaults (protocol
  // optional, ftp allowed), so these MUST still pass — otherwise editing an item
  // holding a legacy value regresses into the same "can't save" failure.
  it.each([
    ['a protocol-less host URL', 'cdn.example.com/a.jpg'],
    ['an ftp URL with a host', 'ftp://files.example.com/a.jpg'],
    ['a legacy GCS https URL', 'https://storage.googleapis.com/bucket/x.png'],
  ])('accepts %s (superset of the old @IsUrl)', (_label, value) => {
    expect(isImageRef(value)).toBe(true);
  });

  it.each([
    ['a plain word', 'notaurl'],
    ['a javascript: scheme', 'javascript:alert(1)'],
    ['a data: URI', 'data:image/png;base64,xx'],
    ['a protocol-relative host', '//evil.com/x'],
    ['an arbitrary absolute path', '/etc/passwd'],
    ['a TLD-less host', 'ftp://x'],
    ['a look-alike proxy path', '/api/gift-imagesX'],
    ['a non-string (number)', 123 as unknown],
    ['null', null as unknown],
    ['undefined', undefined as unknown],
  ])('rejects %s', (_label, value) => {
    expect(isImageRef(value as string)).toBe(false);
  });
});

class ImageArrayDto {
  @IsOptional()
  @IsArray()
  @IsImageRef({ each: true })
  imageUrls?: string[];
}

describe('@IsImageRef({ each: true })', () => {
  it('passes for an array of valid refs (URL + proxy path)', async () => {
    const dto = new ImageArrayDto();
    dto.imageUrls = ['https://x.com/a.jpg', '/api/gift-images?key=x'];
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('fails when one element is invalid', async () => {
    const dto = new ImageArrayDto();
    dto.imageUrls = ['https://x.com/a.jpg', 'nope'];
    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('imageUrls');
    expect(errors[0].constraints).toBeDefined();
    expect(Object.values(errors[0].constraints!).join(' ')).toContain(
      'must be an image URL or uploaded image reference',
    );
  });

  it('passes when the field is omitted (optional)', async () => {
    const dto = new ImageArrayDto();
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});
