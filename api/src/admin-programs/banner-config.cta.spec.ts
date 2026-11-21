import { BadRequestException } from '@nestjs/common';
import { BannerConfigService, invalidCtaLinks, isAllowedCtaUrl } from './banner-config.service';

describe('banner CTA link validation (audit fix 2026-11-21)', () => {
  it.each(['', '   ', undefined, null, 'https://example.com', 'http://example.com/x?y=1', 'HTTPS://Example.com'])(
    'allows %p',
    (v) => expect(isAllowedCtaUrl(v)).toBe(true),
  );
  it.each(['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', '/partner/rewards', 'www.example.com', 'ftp://x.com', 'https://', 'https://a b.com', 42])(
    'refuses %p',
    (v) => expect(isAllowedCtaUrl(v)).toBe(false),
  );

  it('names every bad banner / popup', () => {
    expect(invalidCtaLinks({
      banners: [{ title: 'Diwali', ctaUrl: 'javascript:x' }, { title: 'OK', ctaUrl: 'https://a.com' }, { title: '', ctaUrl: '/x' }],
      popups: [{ title: 'Pop', ctaUrl: 'data:x' }],
    })).toEqual(['Banner "Diwali" — button link "javascript:x"', 'Banner "#3" — button link "/x"', 'Popup "Pop" — button link "data:x"']);
  });

  it('PUT with a bad link → 400 with a clear message; nothing written', async () => {
    const prisma = { programSetting: { upsert: jest.fn() }, auditLog: { create: jest.fn() } };
    const svc = new BannerConfigService(prisma as never);
    const user = { sub: 'a1', role: 'CLIENT_ADMIN', clientId: 'bajaj' } as never;
    const err = await svc
      .update(user, { banners: [{ title: 'Diwali', ctaUrl: 'javascript:alert(1)' }] as never, popups: [] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toBe(
      'Button links must start with http:// or https:// (or be left blank). Fix: Banner "Diwali" — button link "javascript:alert(1)".',
    );
    expect(prisma.programSetting.upsert).not.toHaveBeenCalled();
    // a valid config still saves
    await svc.update(user, { banners: [{ title: 'Diwali', ctaUrl: 'https://bajaj.example/offer' }] as never, popups: [] });
    expect(prisma.programSetting.upsert).toHaveBeenCalledTimes(1);
  });
});
