/**
 * Whole-rupee amount inputs (owner decision 2026-11-11, ALL tenants): every place a member or
 * sales rep TYPES a redemption ₹ amount (variable vouchers + cash payouts) accepts whole rupees
 * only. The backend enforces the same rule (RedeemDto.amount @IsInt → 400 "Enter a whole-rupee
 * amount"); this is the matching UX so a decimal never even reaches the server.
 *
 * Rules (the field never displays a decimal, and "750.5" / "750,5" can never become "7505"):
 *   - "." is ALWAYS a decimal mark and is blocked as typed: it and the digits typed after it are
 *     dropped (FRACTION STATE — desktop keydown, Android beforeinput / "Unidentified" keydown, and
 *     a final change-event guard). The fraction state ends on any delete, a cursor move, paste or
 *     blur, and never starts on an empty field.
 *   - "," WHILE TYPING is kept as-is (never truncates): "1," stays "1,", then "1,250" stays
 *     "1,250" — we can't know yet whether a digit group will follow. It is INTERPRETED on blur /
 *     commit (Enter) and on paste: a "," that forms valid thousands / Indian grouping is a
 *     separator ("1,250" → 1250, "1,25,000" → 125000); any other "," is a decimal mark → the
 *     digits after it are dropped ("750,5" → 750). A caller that reads the value while the field
 *     may still be focused (submit, live previews) MUST read it through wholeRupeeAmount /
 *     wholeRupeesFromText, which apply the same interpretation.
 *   - Pasted text is spliced at the selection and interpreted at once: "1.5" over a selected
 *     "500" → "1"; paste "750,5" → "750"; paste "1,25,000" → "125000".
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

/**
 * The committed whole-rupee NUMBER of a field value (0 when empty). Use wherever a caller reads
 * the amount — a still-focused field may hold "1,250" (→ 1250) or "750,5" (→ 750).
 */
export function wholeRupeeAmount(text: string): number {
  return parseInt(wholeRupeesFromText(text), 10) || 0;
}

/**
 * The typing-time display: digits and "," only, truncated at the first "." (leading "," on an
 * otherwise empty value dropped). Never interprets a ",".
 */
function typingDisplay(text: string): string {
  const t = text ?? '';
  const dot = t.indexOf('.');
  return (dot === -1 ? t : t.slice(0, dot)).replace(/[^\d,]/g, '').replace(/^,+/, '');
}

const REFUSED_KEYS = new Set(['e', 'E', '+', '-']);
const PASSIVE_KEYS = new Set(['Tab', 'Shift', 'Control', 'Alt', 'Meta', 'Enter', 'Unidentified', 'Process', 'CapsLock']);

function startFraction(el: HTMLInputElement) { el.dataset.fraction = '1'; }
function endFraction(el: HTMLInputElement) { delete el.dataset.fraction; }
const inFraction = (el: HTMLInputElement) => el.dataset.fraction === '1';

type WrNode = HTMLInputElement & { __wrBeforeInput?: (ev: InputEvent) => void };

/**
 * Props for a controlled whole-rupee <input>: spread onto the element and render `value`
 * yourself. `onValue` receives the field text — digits, plus (only while the user is still
 * typing) any "," they typed. Blur / Enter commits it to plain digits. Read amounts through
 * wholeRupeeAmount.
 */
export function wholeRupeeInputProps(onValue: (digits: string) => void) {
  const emit = (el: HTMLInputElement, display: string) => {
    el.dataset.last = display;
    onValue(display);
  };

  /**
   * Splice `text` into the field at its selection. TYPED text keeps "," as-is; a "." truncates
   * there and — when at the END of the result with something left — enters the fraction state.
   * PASTED text is interpreted immediately (wholeRupeesFromText).
   */
  const insert = (el: HTMLInputElement, text: string, mode: 'type' | 'paste') => {
    const value = el.value;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const before = value.slice(0, start);
    const after = value.slice(end);
    const spliced = before + text + after;
    if (mode === 'paste') {
      endFraction(el); // a paste never leaves the field waiting to swallow digits
      emit(el, wholeRupeesFromText(spliced));
      return;
    }
    const display = typingDisplay(spliced);
    const dot = spliced.indexOf('.');
    const dotInInsert = dot !== -1 && dot >= before.length && dot < before.length + text.length;
    if (dotInInsert && after === '' && display !== '') startFraction(el);
    else endFraction(el);
    emit(el, display);
  };

  /** Blur / Enter: interpret every "," (separator vs decimal mark) → plain digits. */
  const commit = (el: HTMLInputElement) => {
    endFraction(el);
    const committed = wholeRupeesFromText(el.value);
    if (committed !== el.value) emit(el, committed);
  };

  const onNativeBeforeInput = (el: HTMLInputElement, ev: InputEvent) => {
    const inputType = ev.inputType ?? '';
    if (inputType.startsWith('delete')) { endFraction(el); return; }
    const data = ev.data;
    if (typeof data !== 'string' || data === '') return;
    if (inputType === 'insertFromPaste') {
      ev.preventDefault();
      insert(el, data, 'paste');
      return;
    }
    if (/[.,eE+-]/.test(data)) {
      ev.preventDefault();
      if (inFraction(el)) return;
      const cleaned = data.replace(/[eE+-]/g, '');
      if (cleaned) insert(el, cleaned, 'type');
      return;
    }
    if (inFraction(el) && /^\d+$/.test(data)) { ev.preventDefault(); return; }
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
        if (inFraction(el)) return; // already swallowing a fraction
        insert(el, e.key, 'type');
        return;
      }
      if (inFraction(el)) {
        if (/^\d$/.test(e.key)) { e.preventDefault(); return; }
        if (!PASSIVE_KEYS.has(e.key)) endFraction(el); // Backspace, Delete, arrows, Home/End…
      }
      if (e.key === 'Enter') commit(el);
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
    onBlur: (e: React.FocusEvent<HTMLInputElement>) => commit(e.currentTarget),
    onPaste: (e: React.ClipboardEvent<HTMLInputElement>) => {
      e.preventDefault();
      insert(e.currentTarget, e.clipboardData.getData('text'), 'paste');
    },
    // Last line of defence (any input path the handlers above didn't see).
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      const el = e.target;
      const raw = el.value;
      const last = el.dataset.last ?? '';
      const dot = raw.indexOf('.');
      if (dot !== -1) {
        const display = typingDisplay(raw);
        // The "." was typed at the end → swallow the fraction that follows.
        if (dot === raw.length - 1 && display !== '') startFraction(el);
        else endFraction(el);
        emit(el, display);
        return;
      }
      if (inFraction(el)) {
        // Pure digit / "," APPEND after a "." → fractional: drop it.
        if (raw.length > last.length && raw.startsWith(last) && /^[\d,]+$/.test(raw.slice(last.length))) {
          emit(el, last);
          return;
        }
        endFraction(el);
      }
      emit(el, typingDisplay(raw));
    },
  };
}
