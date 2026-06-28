import { sniffFileType } from './file-signature';

describe('sniffFileType (AF-10 magic-bytes)', () => {
  it('detects JPEG (FF D8 FF)', () => {
    expect(sniffFileType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toEqual({ mime: 'image/jpeg', ext: 'jpg' });
  });

  it('detects PNG (89 50 4E 47 0D 0A 1A 0A)', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    expect(sniffFileType(png)).toEqual({ mime: 'image/png', ext: 'png' });
  });

  it('detects GIF (GIF8)', () => {
    expect(sniffFileType(Buffer.from('GIF89a'))).toEqual({ mime: 'image/gif', ext: 'gif' });
  });

  it('detects WEBP (RIFF....WEBP)', () => {
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]);
    expect(sniffFileType(webp)).toEqual({ mime: 'image/webp', ext: 'webp' });
  });

  it('detects PDF (%PDF)', () => {
    expect(sniffFileType(Buffer.from('%PDF-1.7'))).toEqual({ mime: 'application/pdf', ext: 'pdf' });
  });

  it('detects a PDF behind a leading UTF-8 BOM (scanner output)', () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('%PDF-1.4')]);
    expect(sniffFileType(bom)).toEqual({ mime: 'application/pdf', ext: 'pdf' });
  });

  it('detects TIFF (II*\\0 and MM\\0*)', () => {
    expect(sniffFileType(Buffer.from([0x49, 0x49, 0x2a, 0x00]))).toEqual({ mime: 'image/tiff', ext: 'tiff' });
    expect(sniffFileType(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))).toEqual({ mime: 'image/tiff', ext: 'tiff' });
  });

  it('detects BMP (BM)', () => {
    expect(sniffFileType(Buffer.from([0x42, 0x4d, 0x00, 0x00]))).toEqual({ mime: 'image/bmp', ext: 'bmp' });
  });

  it('detects HEIC (iOS photo: ftyp box + HEIF brand)', () => {
    const heic = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]), // box size
      Buffer.from('ftyp'),
      Buffer.from('heic'),
    ]);
    expect(sniffFileType(heic)).toEqual({ mime: 'image/heic', ext: 'heic' });
  });

  it('rejects an ftyp box with a NON-image brand (e.g. mp4)', () => {
    const mp4 = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from('ftyp'),
      Buffer.from('isom'),
    ]);
    expect(sniffFileType(mp4)).toBeNull();
  });

  it('rejects an HTML polyglot that merely CONTAINS %PDF later (not at offset 0)', () => {
    const poly = Buffer.from('<html><script>x</script>%PDF-1.4');
    expect(sniffFileType(poly)).toBeNull();
  });

  it('rejects an HTML/script payload (spoofed image)', () => {
    expect(sniffFileType(Buffer.from('<html><script>alert(1)</script>'))).toBeNull();
  });

  it('rejects an SVG payload', () => {
    expect(sniffFileType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull();
  });

  it('rejects too-short / empty / null buffers', () => {
    expect(sniffFileType(Buffer.from([0xff]))).toBeNull();
    expect(sniffFileType(Buffer.alloc(0))).toBeNull();
    expect(sniffFileType(null)).toBeNull();
    expect(sniffFileType(undefined)).toBeNull();
  });

  it('does NOT mistake a RIFF-but-not-WEBP container for an image', () => {
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVE')]);
    expect(sniffFileType(wav)).toBeNull();
  });
});
