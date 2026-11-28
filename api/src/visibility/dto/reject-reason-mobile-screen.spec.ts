import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import * as dto from './visibility-capture.dto';
import { VISIBILITY_REASON_LABELS } from '../visibility-report-labels';

// Owner 2026-11-28: new reject reason "Photo of a mobile screen" (a rep photographs a phone showing an image).
describe('visibility reject reason MOBILE_SCREEN_PHOTO', () => {
  it('is a controlled reason code with a human label', () => {
    expect(dto.VISIBILITY_REJECT_REASON_CODES).toContain('MOBILE_SCREEN_PHOTO');
    expect(VISIBILITY_REASON_LABELS.MOBILE_SCREEN_PHOTO).toBe('Photo of a mobile screen');
    for (const c of dto.VISIBILITY_REJECT_REASON_CODES) expect(VISIBILITY_REASON_LABELS[c]).toBeTruthy();
  });

  it('every DTO that validates reasonCode accepts it', async () => {
    const classes = Object.values(dto).filter((v): v is new () => object => typeof v === 'function');
    let checked = 0;
    for (const C of classes) {
      const ok = plainToInstance(C, { decision: 'REJECTED', reasonCode: 'MOBILE_SCREEN_PHOTO' });
      const bad = plainToInstance(C, { decision: 'REJECTED', reasonCode: 'NOT_A_REASON' });
      const badErrs = (await validate(bad)).filter((e) => e.property === 'reasonCode');
      if (!badErrs.length) continue; // this DTO doesn't validate reasonCode
      checked++;
      const okErrs = (await validate(ok)).filter((e) => e.property === 'reasonCode');
      expect(okErrs).toEqual([]);
    }
    expect(checked).toBeGreaterThan(0);
  });
});