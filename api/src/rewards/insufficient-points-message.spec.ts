import { insufficientPointsMessage } from './rewards.service';

describe('insufficientPointsMessage (fix round 3 B6 — never "Available: −2986")', () => {
  it('a negative balance is said plainly', () => {
    expect(insufficientPointsMessage(500, -2986)).toBe(
      "Not available while the balance is negative (−2,986 pts) — it's repaid from the next earnings.",
    );
  });
  it('a balance at or above zero keeps the existing wording exactly', () => {
    expect(insufficientPointsMessage(500, 120)).toBe('Insufficient points. Required: 500, Available: 120');
    expect(insufficientPointsMessage(500, 0)).toBe('Insufficient points. Required: 500, Available: 0');
  });
});
