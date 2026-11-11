/**
 * Whole-rupee amount inputs (owner decision 2026-11-11, ALL tenants): every place a member or
 * sales rep TYPES a redemption ₹ amount (variable vouchers + cash payouts) accepts whole rupees
 * only. The backend enforces the same rule (RedeemDto.amount @IsInt → 400 "Enter a whole-rupee
 * amount"); this is the matching UX so a decimal never even reaches the server.
 *
 * Rules (owner 2026-11-11: "decimal values should not be accepted" — a value is NEVER silently
 * shrunk, e.g. "1,2" must not become ₹1):
 *   - "." is ALWAYS a decimal mark and is blocked as typed: it and the digits typed after it are
 *     dropped (FRACTION STATE — desktop keydown, Android beforeinput / "Unidentified" keydown, and
 *     a final change-event guard). The fraction state ends on any delete, a cursor move, paste or
 *     blur, and never starts on an empty field.
 *   - "," WHILE TYPING is kept as-is (never truncates), and the caret stays where it was typed:
 *     "1," stays "1,", then "1,250" stays "1,250". It is INTERPRETED on blur / commit (Enter) and
 *     on paste: valid thousands ("1,250", "12,500", "125,000") or Indian grouping ("1,25,000")
 *     → plain digits; ANY other comma pattern ("750,5", "1,2", "1,", "1,2345") is INVALID — the raw
 *     text is KEPT, onCommit(true) fires, and callers show WHOLE_RUPEE_INVALID_MESSAGE ("Check the
 *     amount") and disable submit. wholeRupeeAmount returns null for such text (never a guess).
 *   - Pasted text: a leading currency marker is stripped ("Rs. 1,250", "Rs.1,250", "₹ 1,250",
 *     "INR 1250" → 1250), a trailing "/-" and a zero fraction (".0" / ".00") are accepted
 *     ("₹1,250.00", "1,250.0", "1,250/-", "Rs 1250/-" → 1250); it is spliced at the selection and
 *     interpreted at once. Any other decimal ("₹1,250.50", "1.5") is INVALID ("Check the amount").
 *   - FLAGGED: text that was committed / pasted as INVALID stays exactly as the user sees it while
 *     they edit it — no keystroke (",", ".", a digit) is ever rewritten or truncated — until the
 *     text becomes valid again (then normal typing rules resume).
 *   - The Android onChange fallback REJECTS a "." keystroke (the previous value is kept) — it never
 *     truncates at the "."; a "." appended at the end also starts the fraction state.
 *   - A multi-character insert (Android suggestion / IME) containing "." is treated like a paste.
 *   - "e" "E" "+" "-" are refused.
 *
 * "CHECK THE AMOUNT" UX — one rule for every caller (partner voucher + cash sheets, sales
 * catalogue, admin custom amount), via useWholeRupeeField (or the same semantics by hand):
 *   - the message shows ONLY after a commit (blur / Enter / paste, or a tap on the submit button)
 *     that found the text INVALID, and hides again on the next edit — never mid-typing;
 *   - the submit button is NOT disabled for an invalid amount text (a disabled button can't say
 *     why): a tap runs the commit, shows the message and does NOT submit. It stays disabled only for
 *     the reasons its own label states (below minimum, insufficient balance, …);
 *   - only that invalid-amount message is role="alert"; live minimum / balance hints are
 *     aria-live="polite" (not alerts — they change on every keystroke).
 */

import { useState } from 'react';
import type React from 'react';

/** Shown by every caller when the committed amount text is not a valid whole-rupee amount. */
export const WHOLE_RUPEE_INVALID_MESSAGE = 'Check the amount';

const CURRENCY_PREFIX = /^\s*(?:₹|rs\.?|inr)\s*/i;
const PLAIN_DIGITS = /^\d+$/;
/** Thousands grouping: 1,250 · 12,500 · 125,000 · 1,250,000. */
const WESTERN_GROUPING = /^\d{1,3}(?:,\d{3})+$/;
/** Indian grouping: 1,250 · 1,25,000 · 12,34,567. */
const INDIAN_GROUPING = /^\d{1,2}(?:,\d{2})*,\d{3}$/;

/** Strip a leading currency marker ("₹", "Rs", "Rs.", "INR" — any case) and surrounding space. */
export function stripCurrencyPrefix(text: string): string {
  return (text ?? '').replace(CURRENCY_PREFIX, '').trim();
}

/** Strip the currency marker, a trailing "/-" and a ZERO fraction (".0" / ".00") after a digit. */
function normaliseAmountText(text: string): string {
  return stripCurrencyPrefix(text)
    .replace(/\s*\/-\s*$/, '')
    .replace(/(\d)\.0{1,2}$/, '$1')
    .trim();
}

/**
 * The plain digits of a whole-rupee amount text: '' when empty, the digits when the text is a
 * plain number or a valid thousands / Indian grouping, and null when it is anything else (a
 * decimal, a stray comma, letters). Never guesses.
 */
export function wholeRupeeDigits(text: string): string | null {
  const t = normaliseAmountText(text);
  if (t === '') return '';
  if (PLAIN_DIGITS.test(t)) return t;
  if (WESTERN_GROUPING.test(t) || INDIAN_GROUPING.test(t)) return t.replace(/,/g, '');
  return null;
}

/** True when the text is NOT a valid whole-rupee amount (empty is not invalid — just empty). */
export function isWholeRupeeInvalid(text: string): boolean {
  return wholeRupeeDigits(text) === null;
}

/**
 * The whole-rupee NUMBER of a field value: 0 when empty, null when the text is not a valid
 * whole-rupee amount ("750,5", "1,", "1.5") — callers must treat null as "can't submit". Use
 * wherever a caller reads the amount (a still-focused field may hold "1,250" → 1250).
 */
export function wholeRupeeAmount(text: string): number | null {
  const d = wholeRupeeDigits(text);
  if (d === null) return null;
  return d === '' ? 0 : parseInt(d, 10);
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
/** The field holds text that was committed / pasted INVALID — edits are never rewritten. */
function flag(el: HTMLInputElement) { el.dataset.invalid = '1'; endFraction(el); }
const isFlagged = (el: HTMLInputElement) => el.dataset.invalid === '1';

type WrNode = HTMLInputElement & { __wrBeforeInput?: (ev: InputEvent) => void };

/**
 * Props for a controlled whole-rupee <input>: spread onto the element and render `value`
 * yourself. `onValue` receives the field text — digits, plus (while typing) any "," typed. Blur /
 * Enter / paste COMMITS it: a valid amount becomes plain digits; an invalid one is KEPT as typed
 * and `opts.onCommit(true)` fires (callers then show WHOLE_RUPEE_INVALID_MESSAGE — derive it as
 * `committed && isWholeRupeeInvalid(value)` — and disable submit while wholeRupeeAmount is null).
 */
export function wholeRupeeInputProps(
  onValue: (text: string) => void,
  opts: { onCommit?: (invalid: boolean) => void } = {},
) {
  const emit = (el: HTMLInputElement, display: string) => {
    el.dataset.last = display;
    // A flagged (invalid) text un-flags as soon as it is a valid amount again.
    if (isFlagged(el) && wholeRupeeDigits(display) !== null) delete el.dataset.invalid;
    onValue(display);
  };

  /**
   * Splice `text` into the field at its selection. TYPED text keeps "," as-is (caret kept right
   * after the insert); a "." truncates there and — when at the END of the result with something
   * left — enters the fraction state. PASTED text (currency marker stripped) is interpreted at once.
   */
  const insert = (el: HTMLInputElement, text: string, mode: 'type' | 'paste') => {
    const value = el.value;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const before = value.slice(0, start);
    const after = value.slice(end);
    if (mode === 'paste') {
      endFraction(el); // a paste never leaves the field waiting to swallow digits
      const spliced = before + stripCurrencyPrefix(text) + after;
      const digits = wholeRupeeDigits(spliced);
      if (digits === null) {
        flag(el);
        emit(el, spliced); // keep what was pasted — the caller shows "Check the amount"
        opts.onCommit?.(true);
      } else {
        delete el.dataset.invalid;
        emit(el, digits);
        opts.onCommit?.(false);
      }
      return;
    }
    const spliced = before + text + after;
    const display = typingDisplay(spliced);
    const dot = spliced.indexOf('.');
    const dotInInsert = dot !== -1 && dot >= before.length && dot < before.length + text.length;
    if (dotInInsert && after === '' && display !== '') startFraction(el);
    else endFraction(el);
    // Write the DOM value + caret BEFORE the state update: React then finds the node already
    // holding the new value and leaves it (and the caret) alone — a "," typed mid-value keeps the
    // caret right after it instead of jumping to the end.
    const caret = Math.min(typingDisplay(before + text).length, display.length);
    if (el.value !== display) el.value = display;
    try { el.setSelectionRange(caret, caret); } catch { /* detached / not focusable — ignore */ }
    emit(el, display);
  };

  /** Blur / Enter: a valid amount → plain digits; an invalid one is kept and flagged. */
  const commit = (el: HTMLInputElement) => {
    endFraction(el);
    const digits = wholeRupeeDigits(el.value);
    if (digits === null) {
      flag(el);
      opts.onCommit?.(true);
      return;
    }
    delete el.dataset.invalid;
    if (digits !== el.value) emit(el, digits);
    opts.onCommit?.(false);
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
    // A multi-character insert carrying a "." (keyboard suggestion / IME) is a paste: kept and
    // interpreted — never truncated at the ".".
    if (data.length > 1 && data.includes('.')) {
      ev.preventDefault();
      insert(el, data, 'paste');
      return;
    }
    if (isFlagged(el)) {
      // Editing a flagged text: let the browser insert as typed (onChange keeps it verbatim);
      // only e / E / + / - stay refused.
      if (/[eE+-]/.test(data)) ev.preventDefault();
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
      if (isFlagged(el)) {
        // Editing a flagged (invalid) text: nothing is rewritten — the browser inserts as typed.
        if (e.key === 'Enter') commit(el);
        if (REFUSED_KEYS.has(e.key)) e.preventDefault();
        return;
      }
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
      if (isFlagged(el)) {
        // A flagged text is edited VERBATIM (minus e / E / +) — never truncated or rewritten.
        emit(el, raw.replace(/[eE+]/g, ''));
        return;
      }
      const dot = raw.indexOf('.');
      if (dot !== -1) {
        // A "." keystroke is REJECTED: the previous value is kept (React restores the field) —
        // never truncated at the ".". Appended at the end → swallow the fraction that follows.
        if (dot === raw.length - 1 && raw.slice(0, -1) === last && last !== '') startFraction(el);
        else endFraction(el);
        emit(el, last);
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

/**
 * The shared "Check the amount" state for a whole-rupee field (see the header for the UX rule).
 *  - `value` / `amount` (null = invalid text, 0 = empty) / `invalid`;
 *  - `showInvalid`: render WHOLE_RUPEE_INVALID_MESSAGE (role="alert") — true only after a commit
 *    that found the text invalid, false again on the next edit;
 *  - `inputProps`: spread onto the <input> (with `value`);
 *  - `checkBeforeSubmit()`: call first in the submit handler — false (and the message shown) when
 *    the text is invalid, so the submit button never needs to be disabled for that reason;
 *  - `reset(text?)`: set the text programmatically (clears the message).
 */
export function useWholeRupeeField(initial = '') {
  const [value, setValue] = useState(initial);
  const [flagged, setFlagged] = useState(false);
  const amount = wholeRupeeAmount(value);
  const invalid = amount === null;
  const inputProps = wholeRupeeInputProps(
    (text) => { setValue(text); setFlagged(false); },
    { onCommit: (bad) => setFlagged(bad) },
  );
  return {
    value,
    amount,
    invalid,
    showInvalid: flagged && invalid,
    inputProps,
    checkBeforeSubmit: () => {
      if (invalid) { setFlagged(true); return false; }
      return true;
    },
    reset: (text = '') => { setValue(text); setFlagged(false); },
  };
}
