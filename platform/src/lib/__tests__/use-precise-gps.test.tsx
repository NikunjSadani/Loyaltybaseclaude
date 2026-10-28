/**
 * use-precise-gps.test.tsx — the pre-warm hook that starts a background GPS watch while enabled.
 *
 * PW-HOOK1: enabled=true (geo-fence tenant) → starts the watch on mount
 * PW-HOOK2: enabled=false (non-gated tenant) → NEVER starts a watch (Deoleo byte-identical)
 * PW-HOOK3: unmount clears the watch (no leak)
 * PW-HOOK4: flipping enabled false→true starts it; true→false stops it
 */

import React from 'react';
import { render, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { usePreciseGpsPreWarm } from '../use-precise-gps';

const realGeo = navigator.geolocation;
const watchPosition = vi.fn().mockReturnValue(77);
const clearWatch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  watchPosition.mockReturnValue(77);
  Object.defineProperty(navigator, 'geolocation', {
    value: { watchPosition, clearWatch, getCurrentPosition: vi.fn() },
    configurable: true,
  });
});
afterEach(() => {
  Object.defineProperty(navigator, 'geolocation', { value: realGeo, configurable: true });
});

function Harness({ enabled }: { enabled: boolean }) {
  const handle = usePreciseGpsPreWarm(enabled);
  return <div data-testid="h">{handle ? 'watching' : 'idle'}</div>;
}

describe('usePreciseGpsPreWarm', () => {
  it('PW-HOOK1: starts the watch on mount for a geo-fence tenant', () => {
    render(<Harness enabled />);
    expect(watchPosition).toHaveBeenCalledTimes(1);
  });

  it('PW-HOOK2: never starts a watch for a non-gated tenant', () => {
    render(<Harness enabled={false} />);
    expect(watchPosition).not.toHaveBeenCalled();
  });

  it('PW-HOOK3: clears the watch on unmount', () => {
    const { unmount } = render(<Harness enabled />);
    expect(watchPosition).toHaveBeenCalledTimes(1);
    unmount();
    expect(clearWatch).toHaveBeenCalledWith(77);
  });

  it('PW-HOOK4: starts when enabled flips on, stops when it flips off', () => {
    const { rerender } = render(<Harness enabled={false} />);
    expect(watchPosition).not.toHaveBeenCalled();
    act(() => rerender(<Harness enabled />));
    expect(watchPosition).toHaveBeenCalledTimes(1);
    act(() => rerender(<Harness enabled={false} />));
    expect(clearWatch).toHaveBeenCalledWith(77);
  });
});
