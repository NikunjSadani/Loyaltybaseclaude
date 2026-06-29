'use client';

// -----------------------------------------------------------------------------
// PwaAppSettings — the PERSISTENT Profile-page entry point for PWA install + push.
//
// The install/notification banners only ever SNOOZE (3 days) on decline; this card
// is the always-available way for a user to install the app or turn notifications
// on/off whenever they choose. Each section is independently flag-gated and the
// whole card renders null when both flags are OFF (the default).
//
// Reuses the same iOS-Safari / standalone detection as InstallPrompt and the same
// install-prompt store, so it can trigger install even though the browser fired
// `beforeinstallprompt` earlier on load.
// -----------------------------------------------------------------------------
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Smartphone, Bell } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { isIosSafari } from '@/lib/pwa/platform-detect';
import { useInstallPrompt } from '@/lib/pwa/install-prompt-store';
import { subscribeToPush, unsubscribeFromPush } from '@/lib/pwa/push';

function pushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    typeof Notification !== 'undefined'
  );
}

const primaryBtnStyle: CSSProperties = {
  padding: '0.45rem 0.9rem',
  borderRadius: '0.6rem',
  border: 'none',
  background: 'var(--brand-primary, #111827)',
  color: '#fff',
  fontWeight: 600,
  fontSize: '0.8125rem',
  cursor: 'pointer',
};

/* ─── Install section ──────────────────────────────────────────────────────── */

function InstallSection() {
  const { canInstall, installed, promptInstall } = useInstallPrompt();
  const [ios, setIos] = useState(false);

  useEffect(() => {
    setIos(isIosSafari());
  }, []);

  let body: ReactNode;
  if (installed) {
    body = <p className="text-sm text-gray-500">App installed ✓</p>;
  } else if (canInstall) {
    body = (
      <button type="button" onClick={() => void promptInstall()} style={primaryBtnStyle}>
        Install app
      </button>
    );
  } else if (ios) {
    body = (
      <p className="text-sm text-gray-600">
        To install: tap Share, then Add to Home Screen.
      </p>
    );
  } else {
    body = (
      <p className="text-sm text-gray-500">
        Open this site in your mobile browser to install the app.
      </p>
    );
  }

  return (
    <div className="flex items-start gap-3">
      <div className="p-2 bg-gray-50 rounded-lg shrink-0">
        <Smartphone className="h-5 w-5 text-gray-500" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 mb-1">Install app</p>
        {body}
      </div>
    </div>
  );
}

/* ─── Notifications section ────────────────────────────────────────────────── */

function NotificationsSection() {
  // 'unsupported' marks browsers without the Push API (render nothing for them).
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    'unsupported',
  );
  // Local "subscription turned off" flag — browser permission stays 'granted' but
  // we've removed the push subscription, so they stop receiving notifications.
  const [pushOff, setPushOff] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!pushSupported()) {
      setPermission('unsupported');
      return;
    }
    setPermission(Notification.permission);
  }, []);

  if (permission === 'unsupported') return null;

  const enable = async () => {
    setBusy(true);
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result === 'granted') {
        await subscribeToPush();
        setPushOff(false);
      }
    } catch {
      /* requestPermission unsupported / rejected — fail silently */
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setBusy(true);
    try {
      await unsubscribeFromPush();
      setPushOff(true);
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  };

  const reEnable = async () => {
    setBusy(true);
    try {
      await subscribeToPush();
      setPushOff(false);
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  };

  let body: ReactNode;
  if (permission === 'granted') {
    body = pushOff ? (
      <div className="flex items-center gap-3">
        <p className="text-sm text-gray-600">Notifications: Off</p>
        <button type="button" onClick={() => void reEnable()} disabled={busy} style={primaryBtnStyle}>
          Turn on
        </button>
      </div>
    ) : (
      <div className="flex items-center gap-3">
        <p className="text-sm text-gray-600">Notifications: On</p>
        <button
          type="button"
          onClick={() => void turnOff()}
          disabled={busy}
          className="text-sm font-medium text-gray-600 hover:underline"
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
        >
          Turn off
        </button>
      </div>
    );
  } else if (permission === 'denied') {
    body = (
      <p className="text-sm text-gray-600">
        Notifications are blocked. To re-enable, allow notifications for this site in
        your browser settings.
      </p>
    );
  } else {
    // 'default'
    body = (
      <button type="button" onClick={() => void enable()} disabled={busy} style={primaryBtnStyle}>
        Enable notifications
      </button>
    );
  }

  return (
    <div className="flex items-start gap-3">
      <div className="p-2 bg-gray-50 rounded-lg shrink-0">
        <Bell className="h-5 w-5 text-gray-500" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 mb-1">Notifications</p>
        {body}
      </div>
    </div>
  );
}

/* ─── Card ─────────────────────────────────────────────────────────────────── */

export default function PwaAppSettings() {
  const [supportsPush, setSupportsPush] = useState(false);

  useEffect(() => {
    setSupportsPush(pushSupported());
  }, []);

  // Read the flags at render (not module load) so they stay test-stubbable and
  // Next still inlines the NEXT_PUBLIC_* values.
  const installEnabled = process.env.NEXT_PUBLIC_PWA_INSTALL_ENABLED === 'true';
  const pushEnabled = process.env.NEXT_PUBLIC_PWA_PUSH_ENABLED === 'true';

  const showInstall = installEnabled;
  const showNotifications = pushEnabled && supportsPush;

  // Render nothing when no section will actually display: install section off AND
  // (push flag off OR push unsupported on this browser). This also covers the
  // "both flags off" default. Empty cards are never shown.
  if (!showInstall && !showNotifications) return null;

  return (
    <Card data-testid="pwa-app-settings">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Smartphone className="h-4 w-4" /> App &amp; Notifications
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {showInstall && <InstallSection />}
          {showNotifications && <NotificationsSection />}
        </div>
      </CardContent>
    </Card>
  );
}
