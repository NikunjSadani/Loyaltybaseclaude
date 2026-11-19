// -----------------------------------------------------------------------------
// install-dialog-state — "is the InstallPrompt modal on screen right now?"
//
// InstallPrompt publishes its open state here; the Bajaj NotificationReminder reads it and stays closed while the
// install modal is open, so two aria-modal dialogs are never on screen together (the reminder opens when the install
// modal closes, and steps aside if the install modal opens later). Publishing has no effect on any UI by itself —
// for every tenant other than Bajaj nothing reads it.
// -----------------------------------------------------------------------------
import { useSyncExternalStore } from 'react';

let open = false;
const listeners = new Set<() => void>();

export function setInstallDialogOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  listeners.forEach((l) => l());
}

export function isInstallDialogOpen(): boolean {
  return open;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useInstallDialogOpen(): boolean {
  return useSyncExternalStore(subscribe, isInstallDialogOpen, () => false);
}
