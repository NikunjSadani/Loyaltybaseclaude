/**
 * Whole-rupee amount inputs (owner decision 2026-11-11, ALL tenants): every place a member or
 * sales rep TYPES a redemption ₹ amount (variable vouchers + cash payouts) accepts whole rupees
 * only. The backend enforces the same rule (RedeemDto.amount @IsInt → 400 "Enter a whole-rupee
 * amount"); this is the matching UX so a decimal never even reaches the server.
 *
 * Rules (the field never displays a decimal, and "750.5" / "750,5" can never become "7505"):
 *   - DECIMAL MARK: "." always; "," whenever it can't be a thousands separator — i.e. it is NOT
 *     followed by a digit group (3 digits, or the Indian 2-digit lakh/crore group followed by
 *     another ","). So a "," typed at the END of the value is a decimal mark (we can't know a
 *     group will follow), as is "750,5"; "1,250" and "1,25,000" pasted are separators.
 *   - Inserting text (typed key, Android beforeinput, paste) splices it at the selection and
 *     keeps only the whole-rupee part: "1.5" over a selected "500" → "1"; paste "750,5" → "750".
 *   - FRACTION STATE: after a decimal mark is entered at the END of a non-empty value, the
 *     digits typed next are fractional and are dropped. It works on desktop (keydown) and on
 *     Android on-screen keyboards (keydown "Unidentified" → beforeinput data, and a final
 *     change-event guard). It ends on any delete (beforeinput inputType "delete*", Backspace /
 *     Delete, or a change that isn't a pure digit append), a cursor move, paste, or blur. It
 *     never starts on an empty field.
 *   - "e" "E" "+" "-" are refused.
 */

import type React from 'react';

/**
 * Index of the decimal break in `text`: the first "." or the first "," that is not a thousands
 * separator, else -1. A "," is a separator only when followed by exactly 3 digits (then a non-
 * digit or the end), or by 2 digits and another "," (Indian grouping: 1,25,000).
 */
export function decimalBreakIndex(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '.') return i;
    if (c === ',') {
      const rest = text.slice(i + 1);
      const isGroup = /^\d{3}(?!\d)/.test(rest) || /^\d{2},/.test(rest);
      if (!isGroup) return i;
    }
  }
  return -1;
}

/** The whole-rupee digits in arbitrary text ('' when none). Truncates at the decimal break. */
export function wholeRupeesFromText(text: string): string {
  const t = text ?? '';
  const brk = decimalBreakIndex(t);
  return (brk === -1 ? t : t.slice(0, brk)).replace(/\D/g, '');
}

const REFUSED_KEYS = new Set(['e', 'E', '+', '-']);
const PASSIVE_KEYS = new Set(['Tab', 'Shift', 'Control', 'Alt', 'Meta', 'Enter', 'Unidentified', 'Process', 'CapsLock']);

function startFraction(el: HTMLInputElement) { el.dataset.fraction = '1'; }
function endFraction(el: HTMLInputElement) { delete el.dataset.fraction; }
const inFraction = (el: HTMLInputElement) => el.dataset.fraction === '1';

type WrNode = HTMLInputElement & { __wrBeforeInput?: (ev: InputEvent) => void };

/**
 * Props for a controlled whole-rupee <input>: spread onto the element and render `value`
 * yourself. `onValue` receives the sanitised digit string.
 */
export function wholeRupeeInputProps(onValue: (digits: string) => void) {
  const emit = (el: HTMLInputElement, digits: string) => {
    el.dataset.last = digits;
    onValue(digits);
  };

  /**
   * Splice `text` into the field at its selection and emit the whole-rupee result. If the
   * insertion introduces a decimal break at the END of the resulting text (nothing after the
   * inserted piece) and something remains, enter the fraction state.
   */
  const insert = (el: HTMLInputElement, text: string) => {
    const value = el.value;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const before = value.slice(0, start);
    const after = value.slice(end);
    const spliced = before + text + after;
    const digits = wholeRupeesFromText(spliced);
    const brk = decimalBreakIndex(spliced);
    const breakInInsert = brk !== -1 && brk >= before.length && brk < before.length + text.length;
    if (breakInInsert && after === '' && digits !== '') startFraction(el);
    else endFraction(el);
    emit(el, digits);
  };

  const onNativeBeforeInput = (el: HTMLInputElement, ev: InputEvent) => {
    const inputType = ev.inputType ?? '';
    if (inputType.startsWith('delete')) { endFraction(el); return; }
    const data = ev.data;
    if (typeof data !== 'string' || data === '') return;
    if (/[.,]/.test(data)) {
      ev.preventDefault();
      insert(el, data);
      return;
    }
    if (inFraction(el) && /^\d+$/.test(data)) { ev.preventDefault(); return; }
    if (/[eE+\-]/.test(data)) {
      ev.preventDefault();
      const digits = data.replace(/\D/g, '');
      if (digits) insert(el, digits);
    }
  };

  return {
    type: 'text' as const,
    inputMode: 'numeric' as const,
    pattern: '[0-9]*',
    autoComplete: 'off',
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      const el = e.currentTarget;
      if (e.key === '.' || e.key === ',') {
        e.preventDefault();
        insert(el, e.key);
        return;
      }
      if (inFraction(el)) {
        if (/^\d$/.test(e.key)) { e.preventDefault(); return; }
        if (!PASSIVE_KEYS.has(e.key)) endFraction(el); // Backspace, Delete, arrows, Home/End…
      }
      if (REFUSED_KEYS.has(e.key)) e.preventDefault();
    },
    // Android / IME: keydown is "Unidentified", but the NATIVE beforeinput event carries the
    // inserted text + inputType. React's synthetic onBeforeInput does not expose native
    // beforeinput, so the listener is bound on the element itself (once), reading the latest
    // handler off the node so a re-render never leaves a stale closure behind.
    ref: (el: HTMLInputElement | null) => {
      if (!el) return;
      (el as WrNode).__wrBeforeInput = (ev: InputEvent) => onNativeBeforeInput(el, ev);
      if (!el.dataset.wrBound) {
        el.dataset.wrBound = '1';
        el.addEventListener('beforeinput', (ev) => (el as WrNode).__wrBeforeInput?.(ev as InputEvent));
      }
    },
    onBlur: (e: React.FocusEvent<HTMLInputElement>) => endFraction(e.currentTarget),
    onPaste: (e: React.ClipboardEvent<HTMLInputElement>) => {
      e.preventDefault();
      const el = e.currentTarget;
      insert(el, e.clipboardData.getData('text'));
      endFraction(el); // a paste never leaves the field waiting to swallow digits
    },
    // Last line of defence (any input path the handlers above didn't see).
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      const el = e.target;
      const raw = el.value;
      const last = el.dataset.last ?? '';
      const brk = decimalBreakIndex(raw);
      if (brk !== -1) {
        const digits = wholeRupeesFromText(raw);
        // The mark was typed at the end → swallow the fraction that follows.
        if (brk === raw.length - 1 && digits !== '') startFraction(el);
        else endFraction(el);
        emit(el, digits);
        return;
      }
      if (inFraction(el)) {
        // Pure digit APPEND after a decimal mark → those are fractional digits: drop them.
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
