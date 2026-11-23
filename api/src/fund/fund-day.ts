import { BadRequestException } from '@nestjs/common';
import { IST_OFFSET_MIN, istDateKey } from '../common/ist-date';

/** 'YYYY-MM-DD' (an IST calendar day) → the instant that day starts in IST. 400 on an impossible date. */
export function istDayStart(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) - IST_OFFSET_MIN * 60_000);
  if (Number.isNaN(dt.getTime()) || istDateKey(dt) !== key) throw new BadRequestException(`"${key}" is not a valid date`);
  return dt;
}
