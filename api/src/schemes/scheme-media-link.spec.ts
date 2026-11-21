/**
 * scheme-media-link — the signed-in "Open photo" / "Open file" links of the scheme Excel exports, plus the route
 * contract of the viewer page's media endpoint (GET /v1/schemes/media/file).
 * Run: npx jest src/schemes/scheme-media-link.spec.ts
 */
import { PATH_METADATA } from '@nestjs/common/constants';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { PERMISSION_KEY } from '../common/decorators/require-permission.decorator';
import { SchemeEnrollmentController } from './scheme-enrollment.controller';
import {
  createSchemeMediaLinkWriter,
  mediaSafe,
  SCHEME_LINK_LIMIT,
  schemeMediaKeyOf,
  schemeMediaLinkText,
  schemeMediaPath,
} from './scheme-media-link';

const KEY = 'scheme-media/deoleo/2026-09/0b7c9f2e-shop front.jpg';

describe('scheme-media-link', () => {
  afterEach(() => {
    SCHEME_LINK_LIMIT.perSheet = 60_000;
  });

  it('viewer path = /schemes/photo?key=<encoded key>', () => {
    expect(schemeMediaPath(KEY)).toBe(`/schemes/photo?key=${encodeURIComponent(KEY)}`);
    expect(schemeMediaPath(KEY)).not.toContain('scheme-media/');
  });

  it('link text: images → "Open photo"; PDFs / unknown → "Open file"', () => {
    for (const k of ['a.jpg', 'a.JPEG', 'a.png', 'a.webp', 'a.heic', 'a.gif']) expect(schemeMediaLinkText(`scheme-media/t/m/${k}`)).toBe('Open photo');
    for (const k of ['a.pdf', 'a.PDF', 'noext']) expect(schemeMediaLinkText(`scheme-media/t/m/${k}`)).toBe('Open file');
  });

  it('detects a stored key by VALUE: bare string or {key, geo}; ignores other strings / objects', () => {
    expect(schemeMediaKeyOf(KEY)).toBe(KEY);
    expect(schemeMediaKeyOf({ key: KEY, geo: { lat: 1, lng: 2 } })).toBe(KEY);
    expect(schemeMediaKeyOf('shop@upi')).toBe('');
    expect(schemeMediaKeyOf('visibility-media/x.jpg')).toBe('');
    expect(schemeMediaKeyOf({ lat: 1 })).toBe('');
    expect(schemeMediaKeyOf([KEY])).toBe('');
  });

  it('production link = https://<primary domain>/schemes/photo?key=…; a staging-looking primary falls back to <slug>.gifsy.in with a note', () => {
    const env = { TENANT_LINK_ENV: 'production' };
    const w = createSchemeMediaLinkWriter({ clientId: 'deoleo', callerOrigin: 'http://localhost:3000', domainRows: [{ domain: 'rewards.deoleo.in', isPrimary: true }], env });
    expect(w.cell(KEY)).toEqual({ __hyperlink: true, text: 'Open photo', target: `https://rewards.deoleo.in/schemes/photo?key=${encodeURIComponent(KEY)}` });
    expect(w.host).toBe('rewards.deoleo.in');
    const s = createSchemeMediaLinkWriter({ clientId: 'deoleo', callerOrigin: '', domainRows: [{ domain: 'uat-deoleo.gifsy.in', isPrimary: true }], env });
    expect((s.cell(KEY) as { target: string }).target.startsWith('https://deoleo.gifsy.in/schemes/photo?key=')).toBe(true);
    expect(s.note).toContain('looks like a staging host');
  });

  it('local link uses the caller origin (one local FE)', () => {
    const w = createSchemeMediaLinkWriter({ clientId: 'deoleo', callerOrigin: 'http://localhost:3000', domainRows: [], env: { TENANT_LINK_ENV: 'local' } });
    expect((w.cell(KEY) as { target: string }).target).toBe(`http://localhost:3000/schemes/photo?key=${encodeURIComponent(KEY)}`);
  });

  it('caps hyperlinks per writer (sheet): the rest are the URL as text, counted', () => {
    SCHEME_LINK_LIMIT.perSheet = 2;
    const w = createSchemeMediaLinkWriter({ clientId: 'deoleo', callerOrigin: '', domainRows: [], env: { TENANT_LINK_ENV: 'production' } });
    const cells = [w.cell(KEY), w.cell(KEY), w.cell(KEY)];
    expect(typeof cells[0]).toBe('object');
    expect(typeof cells[1]).toBe('object');
    expect(cells[2]).toBe(`https://deoleo.gifsy.in/schemes/photo?key=${encodeURIComponent(KEY)}`);
    expect([w.links, w.asText]).toEqual([2, 1]);
  });

  it('mediaSafe: key → link; non-key values unchanged; arrays of several never leak a key', () => {
    const cell = (k: string) => ({ __hyperlink: true as const, text: 'L', target: k });
    expect(mediaSafe(KEY, cell)).toEqual(cell(KEY));
    expect(mediaSafe('North', cell)).toBe('North');
    expect(mediaSafe(42, cell)).toBe(42);
    expect(mediaSafe([KEY, KEY], cell)).toBe('(file), (file)');
  });

  it('GET /v1/schemes/media/file: static path, same roles + schemes:read as the in-app stream', () => {
    const proto = SchemeEnrollmentController.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    const file = proto.viewMediaFile;
    const inApp = proto.viewMedia;
    expect(Reflect.getMetadata(PATH_METADATA, file)).toBe('media/file');
    expect(Reflect.getMetadata(ROLES_KEY, file)).toEqual(Reflect.getMetadata(ROLES_KEY, inApp));
    expect(Reflect.getMetadata(ROLES_KEY, file)).toEqual(expect.arrayContaining(['GIFSY_ADMIN', 'CLIENT_ADMIN', 'SALES_SO', 'SSS']));
    expect(Reflect.getMetadata(PERMISSION_KEY, file)).toBe('schemes:read');
    expect(Reflect.getMetadata('isPublic', file)).toBeUndefined();
  });
});
