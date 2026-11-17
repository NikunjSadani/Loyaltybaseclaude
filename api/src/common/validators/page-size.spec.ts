import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListChannelPartnersQueryDto } from '../../admin-programs/dto/channel-partners.dto';
import { ListGiftMastersQueryDto } from '../../gift-catalogue/dto/gift-catalogue.dto';
import { ListKycQueryDto } from '../../kyc/dto/kyc.dto';
import { ListLeaderboardQueryDto } from '../../leaderboard/dto/leaderboard.dto';
import {
  BatchDetailQueryDto,
  ListBatchesQueryDto,
  ListTransactionsQueryDto,
} from '../../payouts/dto/payouts.dto';
import { ListTicketsQueryDto } from '../../tickets/dto/tickets.dto';
import { KYC_LIST_MAX_LIMIT, PAGE_SIZE_MAX } from './page-size';

/**
 * Memory-safety (2026-11-13): every list DTO's `limit` is bounded, so `?limit=100000`
 * is a 400 at the ValidationPipe instead of a whole-tenant load.
 */
const cases: Array<[string, new () => object, number]> = [
  ['channel partners', ListChannelPartnersQueryDto, PAGE_SIZE_MAX],
  ['gift masters', ListGiftMastersQueryDto, PAGE_SIZE_MAX],
  ['KYC list (admin KYC screen asks for 500)', ListKycQueryDto, KYC_LIST_MAX_LIMIT],
  ['leaderboard', ListLeaderboardQueryDto, PAGE_SIZE_MAX],
  ['payout transactions', ListTransactionsQueryDto, PAGE_SIZE_MAX],
  ['payout batches', ListBatchesQueryDto, PAGE_SIZE_MAX],
  ['payout batch detail', BatchDetailQueryDto, PAGE_SIZE_MAX],
  ['tickets', ListTicketsQueryDto, PAGE_SIZE_MAX],
];

describe.each(cases)('%s: limit is capped', (_name, Dto, max) => {
  it(`accepts limit=${max} (query strings are converted)`, async () => {
    expect(await validate(plainToInstance(Dto, { limit: String(max) }))).toHaveLength(0);
  });

  it('rejects limit above the cap', async () => {
    const errors = await validate(plainToInstance(Dto, { limit: String(max + 1) }));
    expect(errors.map((e) => e.property)).toContain('limit');
  });

  it('rejects ?limit=100000', async () => {
    const errors = await validate(plainToInstance(Dto, { limit: '100000' }));
    expect(errors.map((e) => e.property)).toContain('limit');
  });
});

describe('caps', () => {
  it('default ceiling is 100; the KYC list keeps 500 for its screen', () => {
    expect(PAGE_SIZE_MAX).toBe(100);
    expect(KYC_LIST_MAX_LIMIT).toBe(500);
  });
});
