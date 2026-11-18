/**
 * M7: an out-of-range batch number is a 400 (never a 500 from an Int overflow in the database).
 */
import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BatchNumberPipe, MAX_BATCH_NUMBER } from './voucher-dispersal.controller';
import { ListDispersalRowsQueryDto } from './dto/voucher-dispersal.dto';

describe('batch number bounds', () => {
  const pipe = new BatchNumberPipe();
  it('path :n — whole number 1..MAX, else 400', () => {
    expect(pipe.transform('2')).toBe(2);
    expect(pipe.transform(String(MAX_BATCH_NUMBER))).toBe(MAX_BATCH_NUMBER);
    for (const bad of ['0', '-1', '1.5', 'abc', '', '99999999999', String(MAX_BATCH_NUMBER + 1)]) {
      expect(() => pipe.transform(bad)).toThrow(BadRequestException);
    }
  });

  it('rows ?batch= — over the bound is a validation error (400)', async () => {
    const over = await validate(plainToInstance(ListDispersalRowsQueryDto, { batch: '99999999999' }));
    expect(over.map((e) => e.property)).toContain('batch');
    expect(await validate(plainToInstance(ListDispersalRowsQueryDto, { batch: '3' }))).toEqual([]);
  });
});
