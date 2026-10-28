'use client';

import { useEffect, useState } from 'react';
import { startPreciseWatch, type PreciseWatchHandle } from './geo-acquire';

/**
 * usePreciseGpsPreWarm — start a high-accuracy background GPS watch (pre-warm) while `enabled`,
 * and tear it down on unmount / when it flips off. Returns the live watch handle (or null).
 *
 * Call sites gate `enabled` to geo-fence tenants only (`features.outletMasterGeo`) AND to the
 * moment the rep reaches the capture surface (board-photo step mounting / capture sheet open),
 * so the watch has a head start and a precise fix is usually already in hand at capture time.
 * A non-gated tenant (Deoleo) passes `enabled=false` → no watch is ever started (byte-identical).
 */
export function usePreciseGpsPreWarm(enabled: boolean): PreciseWatchHandle | null {
  const [handle, setHandle] = useState<PreciseWatchHandle | null>(null);

  useEffect(() => {
    if (!enabled) {
      setHandle(null);
      return;
    }
    const h = startPreciseWatch();
    setHandle(h);
    return () => {
      h.stop();
      setHandle(null);
    };
  }, [enabled]);

  return handle;
}
