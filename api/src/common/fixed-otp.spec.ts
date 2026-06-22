import { isFixedOtpAllowed } from './fixed-otp';

const DEV_DB   = 'postgresql://u:p@127.0.0.1:5433/gifsy_dev';
const STG_DB   = 'postgresql://u:p@10.0.0.1:5432/gifsy_staging';
const PROD_DB  = 'postgresql://u:p@10.0.0.1:5432/gifsy_prod';
const PROD_DBQ = 'postgresql://u:p@10.0.0.1:5432/gifsy_prod?sslmode=require';

describe('isFixedOtpAllowed', () => {
  it('allows in non-production NODE_ENV (local/dev/test)', () => {
    expect(isFixedOtpAllowed({ NODE_ENV: 'development', DATABASE_URL: DEV_DB })).toBe(true);
    expect(isFixedOtpAllowed({ NODE_ENV: 'test', DATABASE_URL: DEV_DB })).toBe(true);
  });

  it('refuses in production by default (no opt-in flag)', () => {
    expect(isFixedOtpAllowed({ NODE_ENV: 'production', DATABASE_URL: STG_DB })).toBe(false);
  });

  it('allows in production-NODE_ENV staging when ALLOW_FIXED_OTP=true (the opt-in)', () => {
    expect(isFixedOtpAllowed({ NODE_ENV: 'production', ALLOW_FIXED_OTP: 'true', DATABASE_URL: STG_DB })).toBe(true);
  });

  it('HARD-refuses on the prod DB even with ALLOW_FIXED_OTP=true (defense-in-depth)', () => {
    expect(isFixedOtpAllowed({ NODE_ENV: 'production', ALLOW_FIXED_OTP: 'true', DATABASE_URL: PROD_DB })).toBe(false);
    expect(isFixedOtpAllowed({ NODE_ENV: 'production', ALLOW_FIXED_OTP: 'true', DATABASE_URL: PROD_DBQ })).toBe(false);
  });

  it('HARD-refuses on the prod DB even if NODE_ENV is misconfigured to non-production', () => {
    expect(isFixedOtpAllowed({ NODE_ENV: 'development', DATABASE_URL: PROD_DB })).toBe(false);
  });

  it('treats ALLOW_FIXED_OTP values other than exactly "true" as off', () => {
    expect(isFixedOtpAllowed({ NODE_ENV: 'production', ALLOW_FIXED_OTP: '1', DATABASE_URL: STG_DB })).toBe(false);
    expect(isFixedOtpAllowed({ NODE_ENV: 'production', ALLOW_FIXED_OTP: 'TRUE', DATABASE_URL: STG_DB })).toBe(false);
    expect(isFixedOtpAllowed({ NODE_ENV: 'production', ALLOW_FIXED_OTP: '', DATABASE_URL: STG_DB })).toBe(false);
  });

  it('the prod-deny is word-bounded: a non-prod DB containing the substring is not denied by layer 1', () => {
    // gifsy_prod_clone is not the prod DB; in dev NODE_ENV it stays allowed (layer 2).
    expect(isFixedOtpAllowed({ NODE_ENV: 'development', DATABASE_URL: 'postgresql://u:p@h/gifsy_prod_clone' })).toBe(true);
  });

  it('on the opt-in path, requires the DB to be positively gifsy_staging (not just "not prod")', () => {
    // production + flag but an unexpected DB name (e.g. a future env or DR replica) → refused
    expect(isFixedOtpAllowed({ NODE_ENV: 'production', ALLOW_FIXED_OTP: 'true', DATABASE_URL: 'postgresql://u:p@h/gifsy_prod_clone' })).toBe(false);
    expect(isFixedOtpAllowed({ NODE_ENV: 'production', ALLOW_FIXED_OTP: 'true', DATABASE_URL: 'postgresql://u:p@h/gifsy_uat' })).toBe(false);
  });
});
