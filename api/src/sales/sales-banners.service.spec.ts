import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../common/guards/roles.guard';
import { SalesController } from './sales.controller';
import { PartnerController } from '../partner/partner.controller';
import { BANNER_SETTING_KEY, istToday, SalesBannersService, selectSalesBanners } from './sales-banners.service';
import type { JwtPayload } from '../common/decorators/current-user.decorator';

const banner = (over: Record<string, unknown> = {}) => ({
  id: 'b1', active: true, type: 'text', title: 'T', body: 'B', ctaLabel: '', ctaUrl: '', videoUrl: '', bgColor: 'red',
  audience: 'ALL', priority: 0, startDate: '', endDate: '', showInSalesApp: true, updatedAt: '2026-11-01T00:00:00Z',
  ...over,
});

describe('selectSalesBanners (pure)', () => {
  const today = '2026-11-21';

  it('only active + showInSalesApp banners; missing showInSalesApp = not for sales', () => {
    const out = selectSalesBanners(
      [
        banner({ id: 'yes' }),
        banner({ id: 'inactive', active: false }),
        banner({ id: 'partner-only', showInSalesApp: false }),
        { ...banner({ id: 'legacy' }), showInSalesApp: undefined },
      ],
      today,
    );
    expect(out.map((b) => b.id)).toEqual(['yes']);
  });

  it('date window inclusive on both ends; empty = no bound', () => {
    const out = selectSalesBanners(
      [
        banner({ id: 'starts-today', startDate: today }),
        banner({ id: 'ends-today', endDate: today }),
        banner({ id: 'future', startDate: '2026-11-22' }),
        banner({ id: 'expired', endDate: '2026-11-20' }),
        banner({ id: 'open' }),
      ],
      today,
    );
    expect(out.map((b) => b.id).sort()).toEqual(['ends-today', 'open', 'starts-today']);
  });

  it('every partner audience is shown to sales (audience is an outlet-type target, not a sales one)', () => {
    const out = selectSalesBanners(['ALL', 'SSS', 'WHOLESALER', 'SUB_STOCKIST'].map((a) => banner({ id: a, audience: a })), today);
    expect(out).toHaveLength(4);
  });

  it('sorted by priority (stable); returns display fields only — no audience / flags / updatedAt', () => {
    const out = selectSalesBanners([banner({ id: 'p2', priority: 2 }), banner({ id: 'p0a' }), banner({ id: 'p0b' })], today);
    expect(out.map((b) => b.id)).toEqual(['p0a', 'p0b', 'p2']);
    expect(Object.keys(out[0]).sort()).toEqual(
      ['bgColor', 'body', 'ctaLabel', 'ctaUrl', 'endDate', 'id', 'priority', 'startDate', 'title', 'type', 'videoUrl'],
    );
  });

  it('odd data never throws: null / non-array / null entries → []', () => {
    expect(selectSalesBanners(null, today)).toEqual([]);
    expect(selectSalesBanners({ x: 1 }, today)).toEqual([]);
    expect(selectSalesBanners([null, 3, 'x'], today)).toEqual([]);
  });

  it('istToday uses the IST calendar day', () => {
    expect(istToday(new Date('2026-11-20T19:00:00Z'))).toBe('2026-11-21'); // 00:30 IST
    expect(istToday(new Date('2026-11-20T18:00:00Z'))).toBe('2026-11-20'); // 23:30 IST
  });
});

describe('SalesBannersService.getBanners', () => {
  const user = (clientId: string | undefined): JwtPayload => ({ sub: 'u1', role: 'SALES_SO', clientId } as unknown as JwtPayload);
  const make = (rows: Record<string, unknown>) => {
    const findFirst = jest.fn(async (args: { where: { clientId: string; settingKey: string } }) =>
      rows[args.where.clientId] !== undefined ? { settingValue: rows[args.where.clientId] } : null);
    const svc = new SalesBannersService({ programSetting: { findFirst } } as never);
    return { svc, findFirst };
  };
  const NOW = new Date('2026-11-21T06:00:00Z');

  it('reads ONLY the caller tenant’s banner_config row (tenant isolation)', async () => {
    const { svc, findFirst } = make({
      bajaj: { banners: [banner({ id: 'bajaj-b' })], popups: [{ id: 'pop' }] },
      deoleo: { banners: [banner({ id: 'deoleo-b' })] },
    });
    const res = await svc.getBanners(user('bajaj'), NOW);
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst.mock.calls[0][0]).toMatchObject({ where: { clientId: 'bajaj', settingKey: BANNER_SETTING_KEY } });
    expect(res.banners.map((b) => b.id)).toEqual(['bajaj-b']);
    expect(res).not.toHaveProperty('popups'); // popups have no sales switch — never returned
  });

  it('no config row (every prod tenant today) → { banners: [] }, no throw', async () => {
    const { svc } = make({});
    await expect(svc.getBanners(user('bajaj'), NOW)).resolves.toEqual({ banners: [] });
  });

  it('a caller with no tenant never issues an unscoped read', async () => {
    const { svc, findFirst } = make({ bajaj: { banners: [banner()] } });
    await expect(svc.getBanners(user(undefined), NOW)).resolves.toEqual({ banners: [] });
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe('GET /v1/sales/banners role gate', () => {
  const rolesFor = (handler: unknown, cls: unknown) =>
    new Reflector().getAllAndOverride<string[]>('roles', [handler as never, cls as never]);
  const guardFor = (handler: unknown, cls: unknown) => {
    const guard = new RolesGuard(new Reflector());
    return (role: string) =>
      guard.canActivate({
        switchToHttp: () => ({ getRequest: () => ({ user: { role, clientId: 'bajaj' } }) }),
        getHandler: () => handler,
        getClass: () => cls,
      } as unknown as ExecutionContext);
  };

  it('every SALES_* role passes; partner / admin roles are refused', () => {
    expect(rolesFor(SalesController.prototype.getBanners, SalesController)).toEqual(
      ['SALES_HO', 'SALES_STATE_HEAD', 'SALES_ASM', 'SALES_SO', 'SALES_ISR'],
    );
    const can = guardFor(SalesController.prototype.getBanners, SalesController);
    for (const r of ['SALES_HO', 'SALES_STATE_HEAD', 'SALES_ASM', 'SALES_SO', 'SALES_ISR']) expect(can(r)).toBe(true);
    for (const r of ['SSS', 'WHOLESALER', 'CLIENT_ADMIN']) expect(() => can(r)).toThrow(ForbiddenException);
  });

  it('the partner read is unchanged: still partner roles only', () => {
    expect(rolesFor(PartnerController.prototype.getBanners, PartnerController)).toEqual(['SSS', 'WHOLESALER', 'SUB_STOCKIST']);
  });
});
