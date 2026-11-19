'use client';

// -----------------------------------------------------------------------------
// NotificationReminder — the Bajaj "turn on notifications" reminder (owner decision 2026-11-19).
//
// Rendered ONLY by PushSubscriptionManager's Bajaj branch (it replaces the old one-line "Enable notifications"
// bottom bar for Bajaj, so the two can never show together). Every other tenant never mounts it.
//
// A modal dialog: heading (focused on open), numbered device-specific steps, focusable buttons; Escape / × /
// "Remind me later" close it (a backdrop tap does NOT — closing hides it for the session, so it must be explicit).
// While open: body scroll locked, the rest of the page inert + aria-hidden. Content comes from notificationGuide():
//   • enable        → "Enable notifications" (requestPermission from THIS tap → subscribe on grant)
//   • blocked       → numbered re-enable steps + "Done — check again" (re-reads Notification.permission)
//   • install-first → iPhone browser tab: Add to Home Screen steps, no Enable button
//   • ios-too-old / unsupported → one plain line
// Every outcome that is not a success is said out loud in a polite live region (no silent pass-through).
// -----------------------------------------------------------------------------
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { subscribeToPush } from '@/lib/pwa/push';
import {
  browserLabel,
  notificationGuide,
  type NotificationGuideInput,
  type NotificationState,
} from '@/lib/pwa/notification-guide';

const primaryBtn: CSSProperties = {
  width: '100%',
  padding: '0.7rem 1rem',
  borderRadius: '0.7rem',
  border: 'none',
  background: 'var(--brand-primary, #111827)',
  color: '#fff',
  fontWeight: 700,
  fontSize: '0.9rem',
  cursor: 'pointer',
};

const secondaryBtn: CSSProperties = {
  width: '100%',
  padding: '0.6rem 1rem',
  borderRadius: '0.7rem',
  border: '1px solid #d1d5db',
  background: '#ffffff',
  color: '#1f2937',
  fontWeight: 600,
  fontSize: '0.875rem',
  cursor: 'pointer',
};

function readPermission(): NotificationState {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export interface NotificationReminderProps extends Omit<NotificationGuideInput, 'state'> {
  initialState: NotificationState;
  onClose: () => void;
}

export default function NotificationReminder({ initialState, onClose, ...guideInput }: NotificationReminderProps) {
  const [state, setState] = useState<NotificationState>(initialState);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const guide = notificationGuide({ ...guideInput, state });

  // Escape closes (same as "Remind me later"); Tab stays inside the dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !cardRef.current) return;
      const focusables = Array.from(
        cardRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'),
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === headingRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Lock the page behind the dialog: no background scroll, and the rest of the page is inert + hidden from
  // assistive tech while it's open (restored exactly on close).
  useEffect(() => {
    const root = cardRef.current?.closest('[data-notif-reminder-root]') ?? null;
    if (!root) return; // nothing on screen → lock nothing
    const body = document.body;
    const prevOverflow = body.style.overflow;
    body.style.overflow = 'hidden';
    const touched: Array<{ el: Element; hadInert: boolean; ariaHidden: string | null }> = [];
    Array.from(body.children).forEach((el) => {
      if (el === root || el.contains(root) || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return;
      touched.push({ el, hadInert: el.hasAttribute('inert'), ariaHidden: el.getAttribute('aria-hidden') });
      el.setAttribute('inert', '');
      el.setAttribute('aria-hidden', 'true');
    });
    return () => {
      body.style.overflow = prevOverflow;
      touched.forEach(({ el, hadInert, ariaHidden }) => {
        if (!hadInert) el.removeAttribute('inert');
        if (ariaHidden === null) el.removeAttribute('aria-hidden');
        else el.setAttribute('aria-hidden', ariaHidden);
      });
    };
  }, []);

  // Focus the heading on open; give focus back to whatever had it when the reminder closes. Declared AFTER the
  // inert effect so, on close, the page is un-inerted before focus returns to it.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    headingRef.current?.focus();
    return () => {
      previous?.focus?.();
    };
  }, []);

  // Granted (by Enable or after the user fixed it in Settings) → subscribe, then close (or say why it didn't land).
  // subscribeToPush never throws — it reports 'subscribed' | 'unavailable' | 'denied' | 'error'.
  const finishGranted = async () => {
    const result = await subscribeToPush();
    if (result === 'subscribed') {
      onClose();
      return;
    }
    setState('granted');
    setMessage(
      'Notifications are allowed, but we couldn’t finish setting them up. We’ll try again the next time you open the app.',
    );
  };

  const enable = async () => {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      // Requested from THIS tap (Safari/iOS require a user gesture).
      let result: NotificationPermission;
      try {
        result = await Notification.requestPermission();
      } catch {
        result = 'default';
      }
      // Trust the browser's CURRENT state over the promise's answer (as the automatic ask does).
      const real = readPermission();
      if (result === 'granted' || real === 'granted') {
        await finishGranted();
        return;
      }
      if (real === 'denied') {
        setState('denied');
        setMessage('Notifications were blocked. Follow the steps below to turn them back on.');
        return;
      }
      if (result === 'denied') {
        // Answer 'denied' but the permission still reads 'default': the browser is holding the prompt back for now
        // (Chrome's embargo after repeated dismissals) — NOT a block in Site settings, so no Blocked-list steps.
        const browser = browserLabel(guideInput.platform, guideInput.androidBrowser);
        const name = browser === 'your browser' ? 'Your browser' : browser;
        setMessage(
          `${name} is blocking the prompt for now — try again later, or allow notifications for this site in ${
            browser === 'Chrome' ? 'Chrome’s Site settings' : 'the browser’s site settings'
          }.`,
        );
        return;
      }
      setMessage('The permission request didn’t appear. Tap “Enable notifications” again, or use Profile → Notifications.');
    } finally {
      setBusy(false);
    }
  };

  const checkAgain = async () => {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      const now = readPermission();
      if (now === 'granted') {
        await finishGranted();
        return;
      }
      setState(now);
      setMessage(
        now === 'denied'
          ? 'Still blocked — check the steps above, then tap “Done — check again”.'
          : now === 'default'
            ? 'Notifications are no longer blocked. Tap “Enable notifications” to turn them on.'
            : 'Notifications aren’t available here.',
      );
    } finally {
      setBusy(false);
    }
  };

  // Nothing left to say (e.g. granted and the subscription failed → we still show the message; granted + no message → close).
  if (!guide && !message) return null;

  const oneLine = guide && (guide.kind === 'ios-too-old' || guide.kind === 'unsupported');
  // Granted but the subscription didn't land → say exactly that (never "Notifications are on").
  const title = guide ? guide.title : 'Notifications allowed — setup not finished';

  return (
    // The backdrop deliberately does NOT dismiss: closing hides the reminder for the whole session, so it takes an
    // explicit "Remind me later", × or Escape — never a stray tap.
    <div
      data-notif-reminder-root=""
      style={{
        position: 'fixed',
        inset: 0,
        // Just below InstallPrompt's modal (2147483646): if both open, the install card sits on top and this
        // reminder is what's left after it closes.
        zIndex: 2147483645,
        background: 'rgba(17,24,39,0.55)',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        padding: '1rem',
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="notif-reminder-title"
        aria-describedby="notif-reminder-intro"
        data-testid="notif-reminder"
        data-kind={guide?.kind ?? 'granted'}
        style={{
          position: 'relative',
          width: 'min(94vw, 26rem)',
          maxHeight: 'calc(100vh - 2rem)',
          overflowY: 'auto',
          background: '#ffffff',
          color: '#111827',
          borderRadius: '1rem',
          boxShadow: '0 20px 50px rgba(0,0,0,0.30)',
          padding: '1.25rem 1.25rem 1rem',
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            position: 'absolute',
            top: '0.5rem',
            right: '0.5rem',
            padding: '0.25rem 0.55rem',
            borderRadius: '0.5rem',
            border: 'none',
            background: 'transparent',
            color: '#4b5563',
            fontSize: '1.35rem',
            lineHeight: 1,
            cursor: 'pointer',
          }}
        >
          ×
        </button>

        <h2
          id="notif-reminder-title"
          ref={headingRef}
          tabIndex={-1}
          style={{ fontSize: '1.05rem', fontWeight: 700, margin: '0 2rem 0.4rem 0', outline: 'none' }}
        >
          {title}
        </h2>
        <p id="notif-reminder-intro" style={{ fontSize: '0.875rem', lineHeight: 1.45, color: '#374151', margin: 0 }}>
          {guide ? guide.intro : message}
        </p>

        {guide && !oneLine && guide.steps.length > 0 && (
          <ol
            data-testid="notif-reminder-steps"
            style={{
              margin: '0.85rem 0 0',
              paddingLeft: '1.25rem',
              listStyle: 'decimal',
              fontSize: '0.85rem',
              lineHeight: 1.45,
              color: '#1f2937',
            }}
          >
            {guide.steps.map((s) => (
              <li key={s} style={{ marginBottom: '0.35rem' }}>
                {s}
              </li>
            ))}
          </ol>
        )}
        {guide?.footnote && !oneLine && (
          <p style={{ fontSize: '0.75rem', color: '#4b5563', margin: '0.5rem 0 0' }}>{guide.footnote}</p>
        )}

        {guide && message && (
          <p data-testid="notif-reminder-message" style={{ fontSize: '0.8rem', color: '#92400e', margin: '0.75rem 0 0' }}>
            {message}
          </p>
        )}
        <p className="sr-only" role="status" aria-live="polite">
          {message}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '1rem' }}>
          {guide?.kind === 'enable' && (
            <button type="button" onClick={() => void enable()} disabled={busy} aria-busy={busy} style={primaryBtn}>
              {busy ? 'Waiting…' : 'Enable notifications'}
            </button>
          )}
          {guide?.kind === 'blocked' && (
            <button type="button" onClick={() => void checkAgain()} disabled={busy} aria-busy={busy} style={primaryBtn}>
              {busy ? 'Checking…' : 'Done — check again'}
            </button>
          )}
          <button type="button" onClick={onClose} style={secondaryBtn}>
            {oneLine || !guide ? 'OK' : 'Remind me later'}
          </button>
        </div>
      </div>
    </div>
  );
}
