import { generateNumericOtp } from './otp';

describe('generateNumericOtp (AF-10 CSPRNG)', () => {
  it('always returns a 6-digit string in [100000, 999999]', () => {
    for (let i = 0; i < 2000; i++) {
      const otp = generateNumericOtp();
      expect(otp).toMatch(/^\d{6}$/);
      const n = Number(otp);
      expect(n).toBeGreaterThanOrEqual(100000);
      expect(n).toBeLessThanOrEqual(999999);
    }
  });

  it('produces varied output (not a constant)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generateNumericOtp());
    expect(seen.size).toBeGreaterThan(150); // overwhelmingly unique across 200 draws
  });
});
