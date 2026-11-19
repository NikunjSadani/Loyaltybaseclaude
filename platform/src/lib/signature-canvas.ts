/**
 * isSignatureCanvasBlank — true when a signature pad canvas carries NO ink (every pixel fully transparent or pure
 * white). Used before a KYC submit on location-gate tenants so a pad that is marked "signed" but whose canvas was
 * reset (remount, resize) never sends a blank consent signature (release-gate review 2026-11-19, LOCATION-GATE.md).
 *
 * Returns false when the canvas cannot be read (no 2D context, e.g. a test DOM, or a security error) — "unknown" must
 * never block a real signature.
 */
export function isSignatureCanvasBlank(canvas: HTMLCanvasElement | null | undefined): boolean {
  if (!canvas || !canvas.width || !canvas.height) return !!canvas; // a 0×0 canvas holds nothing
  let data: Uint8ClampedArray;
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof ctx.getImageData !== 'function') return false;
    data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  } catch {
    return false;
  }
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 0) continue;
    if (data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255) continue; // white background
    return false; // ink
  }
  return true;
}
