'use client';

/**
 * LocationGatePanel — the full-panel "location needed" screen shown INSTEAD of the KYC wizard / visibility capture
 * form while the location gate is blocking (docs/plans/LOCATION-GATE.md). The flow behind it stays mounted (hidden),
 * so nothing the rep entered is lost. Two states:
 *   • checking — "Checking your location…" (polite live region) — first check only;
 *   • blocked  — a platform-specific guide with a "Test again" button. The heading takes focus when the guide first
 *                appears; during a re-test the guide STAYS (button reads "Checking…", aria-disabled so focus is kept),
 *                and each result is announced in a polite live region.
 */
import { useEffect, useRef } from 'react';
import { Loader2, MapPinOff, RefreshCw } from 'lucide-react';
import { locationGuide } from '@/lib/location-gate';
import type { LocationGateState } from '@/lib/use-location-gate';

export function LocationGatePanel({
  gate,
  purpose,
  className = '',
}: {
  gate: Pick<LocationGateState, 'status' | 'reason' | 'platform' | 'recheck' | 'testing' | 'attempts'>;
  /** What the rep is trying to do — "start or submit a KYC" / "capture visibility". */
  purpose: string;
  className?: string;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const blocked = gate.status === 'blocked' && gate.reason !== null;
  const testing = gate.testing;

  // Focus the heading when the guide FIRST appears (not on every re-test — the button keeps focus then).
  useEffect(() => {
    if (blocked) headingRef.current?.focus();
  }, [blocked]);

  if (!blocked) {
    return (
      <div
        data-testid="location-gate-checking"
        role="status"
        aria-live="polite"
        className={`flex flex-col items-center gap-3 py-14 text-center ${className}`}
      >
        <Loader2 className="h-7 w-7 animate-spin text-[var(--brand-primary)]" aria-hidden="true" />
        <p className="text-sm font-semibold text-gray-800">Checking your location…</p>
        <p className="text-xs text-gray-500 max-w-xs">
          If your phone asks to allow location for this site, tap <strong>Allow</strong>.
        </p>
      </div>
    );
  }

  const guide = locationGuide(gate.platform, gate.reason!);
  const announcement = testing
    ? 'Checking your location…'
    : gate.attempts > 1
      ? `Still no location. ${guide.title}.`
      : '';
  return (
    <section
      data-testid="location-gate-blocked"
      data-reason={gate.reason}
      data-platform={gate.platform}
      aria-labelledby="location-gate-title"
      className={`rounded-2xl border border-amber-200 bg-amber-50/60 px-4 py-5 ${className}`}
    >
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center shrink-0" aria-hidden="true">
          <MapPinOff className="h-5 w-5 text-amber-700" />
        </div>
        <div className="min-w-0">
          <h2
            id="location-gate-title"
            ref={headingRef}
            tabIndex={-1}
            className="text-base font-bold text-gray-900 outline-none"
          >
            {guide.title}
          </h2>
          <p className="text-xs text-gray-700 mt-1">
            Location is required to {purpose} for this programme. {guide.intro}
          </p>
        </div>
      </div>

      <ol className="mt-4 space-y-2 list-decimal pl-5 text-[13px] text-gray-800">
        {guide.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>

      {guide.footnote && <p className="mt-3 text-[11px] text-gray-500">{guide.footnote}</p>}

      <button
        type="button"
        data-testid="location-gate-test-again"
        onClick={() => {
          if (!testing) void gate.recheck();
        }}
        aria-disabled={testing}
        className={`mt-5 w-full py-3 rounded-xl text-sm font-bold bg-[var(--brand-primary)] text-white flex items-center justify-center gap-2 ${testing ? 'opacity-60 cursor-wait' : ''}`}
      >
        {testing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
        {testing ? 'Checking…' : 'Test again'}
      </button>
      {!testing && gate.attempts > 1 && (
        <p data-testid="location-gate-still-blocked" className="mt-2 text-center text-[11px] text-amber-800">
          Still no location — check the steps above, then test again.
        </p>
      )}
      <p className="sr-only" role="status" aria-live="polite" data-testid="location-gate-live">
        {announcement}
      </p>
    </section>
  );
}

export default LocationGatePanel;
