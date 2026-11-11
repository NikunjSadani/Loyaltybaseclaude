/**
 * Whole-rupee amount inputs (owner decision 2026-11-11, ALL tenants): every place a member or
 * sales rep TYPES a redemption ₹ amount (variable vouchers + cash payouts) accepts whole rupees
 * only. The backend enforces the same rule (RedeemDto.amount @IsInt → 400 "Enter a whole-rupee
 * amount"); this is the matching UX so a decimal never even reaches the server.
 *
 * Behaviour (the field never displays a decimal, and "750.5" can never become "7505"):
 *   - a typed "." is refused AND the fractional digits typed right after it are dropped, so
 *     typing "750.5" leaves "750". This works three ways, because Android on-screen keyboards
 *     report keydown key "Unidentified": (1) keydown "."; (2) beforeinput whose data contains
 *     "." / ","; (3) a change whose value contains "." (truncated, then later APPENDED digits
 *     are dropped). The fraction state ends on any edit that isn't a pure digit append
 *     (Backspace, cursor move + type, paste) or on blur;
 *   - typing "," "e" "E" "+" "-" is refused (commas are just thousands separators);
 *   - pasting / autofilling / IME text keeps the WHOLE-RUPEE part: "750.5" → "750",
 *     "1,250.75" → "1250", "₹ 900" → "900".
 */

import type React from 'react';

/** The whole-rupee digits in arbitrary text ('' when none). Truncates at the decimal point. */
export function wholeRupeesFromText(text: string): string {
  const noGrouping = (text ?? '').replace(/,/g, '');
  const intPart = noGrouping.split('.')[0];
  return intPart.replace(/\D/g, '');
}

const REFUSED_KEYS = new Set([',', 'e', 'E', '+', '-']);
const NAV_KEYS = new Set(['Tab', 'Shift', 'Control', 'Alt', 'Meta', 'Enter', 'Unidentified', 'Process']);

/** Per-element state lives on the DOM node (dataset) — no extra React state needed. */
function startFraction(el: HTMLInputElement) {
  el.dataset.fraction = '1';
}
function endFraction(el: HTMLInputElement) {
  delete el.dataset.fraction;
}

/**
 * Props for a controlled whole-rupee <input>: spread onto the element and render `value`
 * yourself. `onValue` receives the sanitised digit string.
 */
export function wholeRupeeInputProps(onValue: (digits: string) => void) {
  const emit = (el: HTMLInputElement, digits: string) => {
    el.dataset.last = digits;
    onValue(digits);
  };
  return {
    type: 'text' as const,
    inputMode: 'numeric' as const,
    pattern: '[0-9]*',
    autoComplete: 'off',
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      const el = e.currentTarget;
      if (e.key === '.') {
        e.preventDefault();
        startFraction(el); // swallow the fractional digits that follow
        return;
      }
      if (el.dataset.fraction === '1') {
        if (/^\d$/.test(e.key)) { e.preventDefault(); return; }
        if (!NAV_KEYS.has(e.key)) endFraction(el);
      }
      if (REFUSED_KEYS.has(e.key)) e.preventDefault();
    },
    // Android / IME: keydown is "Unidentified", but beforeinput carries the text being inserted.
    onBeforeInput: (e: React.FormEvent<HTMLInputElement>) => {
      const el = e.currentTarget;
      const data = (e.nativeEvent as InputEvent | undefined)?.data ?? (e as unknown as { data?: string }).data;
      if (typeof data !== 'string' || data === '') return;
      if (data.includes('.')) {
        e.preventDefault();
        startFraction(el);
        const whole = wholeRupeesFromText(data); // e.g. "5.25" inserted at once → keep "5"
        if (whole) emit(el, wholeRupeesFromText(el.value + whole));
        return;
      }
      if (el.dataset.fraction === '1' && /^\d+$/.test(data)) { e.preventDefault(); return; }
      if (/[,eE+\-]/.test(data)) {
        e.preventDefault();
        const digits = data.replace(/\D/g, '');
        if (digits) emit(el, wholeRupeesFromText(el.value + digits));
      }
    },
    onBlur: (e: React.FocusEvent<HTMLInputElement>) => endFraction(e.currentTarget),
    onPaste: (e: React.ClipboardEvent<HTMLInputElement>) => {
      e.preventDefault();
      const el = e.currentTarget;
      endFraction(el);
      const pasted = wholeRupeesFromText(e.clipboardData.getData('text'));
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      emit(el, wholeRupeesFromText(el.value.slice(0, start) + pasted + el.value.slice(end)));
    },
    // Last line of defence (any input path the handlers above didn't see).
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      const el = e.target;
      const raw = el.value;
      const last = el.dataset.last ?? '';
      if (/[.]/.test(raw)) {
        startFraction(el);
        emit(el, wholeRupeesFromText(raw));
        return;
      }
      if (el.dataset.fraction === '1') {
        // Pure digit APPEND after a decimal point → those are fractional digits: drop them.
        if (raw.length > last.length && raw.startsWith(last) && /^\d+$/.test(raw.slice(last.length))) {
          emit(el, last);
          return;
        }
        endFraction(el);
      }
      emit(el, wholeRupeesFromText(raw));
    },
  };
}
