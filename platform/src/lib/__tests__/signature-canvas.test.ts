/**
 * isSignatureCanvasBlank — never send a blank consent signature (LOCATION-GATE.md, release-gate review CRITICAL).
 */
import { describe, expect, it } from 'vitest';
import { isSignatureCanvasBlank } from '../signature-canvas';

function canvasWith(pixels: number[] | null, w = 2, h = 1): HTMLCanvasElement {
  return {
    width: w,
    height: h,
    getContext: () => (pixels === null ? null : { getImageData: () => ({ data: new Uint8ClampedArray(pixels) }) }),
  } as unknown as HTMLCanvasElement;
}

describe('isSignatureCanvasBlank', () => {
  it('an all-transparent canvas (pad reset after a remount) is blank', () => {
    expect(isSignatureCanvasBlank(canvasWith([0, 0, 0, 0, 0, 0, 0, 0]))).toBe(true);
  });
  it('white background only is blank', () => {
    expect(isSignatureCanvasBlank(canvasWith([255, 255, 255, 255, 0, 0, 0, 0]))).toBe(true);
  });
  it('any ink is NOT blank', () => {
    expect(isSignatureCanvasBlank(canvasWith([0, 0, 0, 0, 20, 20, 20, 255]))).toBe(false);
  });
  it('an unreadable canvas (no 2D context) is never treated as blank — unknown must not block a real signature', () => {
    expect(isSignatureCanvasBlank(canvasWith(null))).toBe(false);
  });
  it('no canvas → not blank (nothing to judge); a 0×0 canvas → blank', () => {
    expect(isSignatureCanvasBlank(null)).toBe(false);
    expect(isSignatureCanvasBlank(canvasWith([], 0, 0))).toBe(true);
  });
});
