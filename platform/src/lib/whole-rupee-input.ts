/**
 * Whole-rupee amount inputs (owner decision 2026-11-11, ALL tenants): every place a member or
 * sales rep TYPES a redemption ₹ amount (variable vouchers + cash payouts) accepts whole rupees
 * only. The backend enforces the same rule (RedeemDto.amount @IsInt → 400 "Enter a whole-rupee
 * amount"); this is the matching UX so a decimal never even reaches the server.
 *
 * Rules (owner 2026-11-11: decimals are NEVER accepted and an amount is NEVER silently changed —
 * "1,2" must not become ₹1, "750.5" must not become ₹750):
 *   - WHILE TYPING only digits, "," and "." are accepted (a letter / space / "e" "+" "-" key is
 *     refused). Nothing typed is ever dropped, truncated or rewritten: "." and "," stay in the text
 *     exactly where they were typed ("750.5" stays "750.5", "1," stays "1,").
 *   - The text is INTERPRETED on commit — blur / Enter / a tap on submit — and on paste: a plain
 *     number, valid thousands ("1,250", "12,500", "125,000") or Indian grouping ("1,25,000") →
 *     plain digits (a grouped number must start with 1-9: "0,500" / "00,500" are invalid); ANY
 *     other text ("750.5", "750,5", "1,2", "1,", "1,2345") is INVALID — the raw text is KEPT,
 *     onCommit(true) fires, callers show WHOLE_RUPEE_INVALID_MESSAGE and refuse to submit.
 *     wholeRupeeAmount returns null for such text (never a guess).
 *   - Currency text comes in ONLY via paste: a leading marker is stripped ("Rs. 1,250", "Rs.1,250",
 *     "₹ 1,250", "INR 1250" → 1250); a trailing "/-" and a zero fraction (".0" / ".00") are accepted
 *     ("₹1,250.00", "1,250.0", "1,250/-", "Rs 1250/-" → 1250); it is spliced at the selection and
 *     interpreted at once. Any other decimal ("₹1,250.50", "1.5") is INVALID.
 *   - A multi-character insert that is NOT a paste event (Android clipboard-chip paste arriving as
 *     insertText "₹1,250" / "Rs 1250", IME composition, keyboard suggestion / autocorrect) is
 *     applied by the browser itself (never re-spliced at the caret — no duplicated text); onChange
 *     then finds the inserted run and treats it EXACTLY like a paste (currency marker stripped,
 *     interpreted at once: valid → plain digits, invalid → kept + "Check the amount").
 *   - A single-character edit that would ADD a character other than a digit / "," / "." is refused
 *     (the current text is kept, and a shown "Check the amount" stays — a refused key is not an
 *     edit); deleting characters is always allowed.
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

import { useRef, useState } from 'react';
import type React from 'react';

/** Shown by every caller when the committed amount text is not a valid whole-rupee amount. */
export const WHOLE_RUPEE_INVALID_MESSAGE = 'Check the amount — whole rupees only';

const CURRENCY_PREFIX = /^\s*(?:₹|rs\.?|inr)\s*/i;
const PLAIN_DIGITS = /^\d+$/;
/** Thousands grouping: 1,250 · 12,500 · 125,000 · 1,250,000 (first group starts 1-9: never "0,500"). */
const WESTERN_GROUPING = /^[1-9]\d{0,2}(?:,\d{3})+$/;
/** Indian grouping: 1,250 · 1,25,000 · 12,34,567 (first group starts 1-9: never "00,500"). */
const INDIAN_GROUPING = /^[1-9]\d?(?:,\d{2})*,\d{3}$/;

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

/** Characters a keystroke may add while typing. */
const TYPABLE = /^[\d.,]$/;
/** The characters of `text` that a keystroke could NOT have typed (letters, spaces, ₹, …). */
const untypable = (text: string) => text.replace(/[\d.,]/g, '');
/** True when `sub` is a subsequence of `full` (characters only removed — never added). */
function isSubsequence(sub: string, full: string): boolean {
  let i = 0;
  for (const ch of full) if (i < sub.length && sub[i] === ch) i++;
  return i === sub.length;
}

/**
 * The run of characters a single change inserted: `next` = before + inserted + after, where
 * before / after are the longest common prefix / suffix shared with `prev` (non-overlapping).
 */
function insertedRun(prev: string, next: string): { before: string; inserted: string; after: string } {
  let p = 0;
  const max = Math.min(prev.length, next.length);
  while (p < max && prev[p] === next[p]) p++;
  let s = 0;
  while (s < max - p && prev[prev.length - 1 - s] === next[next.length - 1 - s]) s++;
  return { before: next.slice(0, p), inserted: next.slice(p, next.length - s), after: next.slice(next.length - s) };
}

type WrNode =HTMLInputElement & { __wrBeforeInput?: (ev: InputEvent) => void };

/**
 * Props for a controlled whole-rupee <input>: spread onto the element and render `value`
 * yourself. `onValue` receives the field text exactly as typed. Blur / Enter / paste COMMITS it: a
 * valid amount becomes plain digits; an invalid one is KEPT as typed and `opts.onCommit(true)`
 * fires (callers then show WHOLE_RUPEE_INVALID_MESSAGE and refuse to submit while
 * wholeRupeeAmount is null). Pass `opts.value` (the controlled value) so a refused edit restores
 * the CURRENT text — never a stale one from before a programmatic reset.
 */
export function wholeRupeeInputProps(
  onValue: (text: string) => void,
  opts: {
    onCommit?: (invalid: boolean) => void;
    value?: string;
    ref?: (el: HTMLInputElement | null) => void;
  } = {},
) {
  const emit = (el: HTMLInputElement, text: string) => {
    el.dataset.last = text;
    onValue(text);
  };
  /** The text currently held (the controlled value when given, else the last text emitted). */
  const current = (el: HTMLInputElement) => opts.value ?? el.dataset.last ?? '';

  /** PASTED text (currency marker stripped) is spliced at the selection and interpreted at once. */
  const paste = (el: HTMLInputElement, text: string) => {
    const value = el.value;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    interpret(el, value.slice(0, start) + stripCurrencyPrefix(text) + value.slice(end));
  };

  /** Paste semantics for an already-spliced text: valid → plain digits; invalid → kept + flagged. */
  const interpret = (el: HTMLInputElement, spliced: string) => {
    const digits = wholeRupeeDigits(spliced);
    if (digits === null) {
      emit(el, spliced); // keep what was pasted — the caller shows "Check the amount"
      opts.onCommit?.(true);
    } else {
      emit(el, digits);
      opts.onCommit?.(false);
    }
  };

  /** Blur / Enter: a valid amount → plain digits; an invalid one is kept exactly as typed. */
  const commit = (el: HTMLInputElement) => {
    const digits = wholeRupeeDigits(el.value);
    if (digits === null) {
      opts.onCommit?.(true);
      return;
    }
    if (digits !== el.value) emit(el, digits);
    opts.onCommit?.(false);
  };

  const onNativeBeforeInput = (ev: InputEvent, el: HTMLInputElement) => {
    const inputType = ev.inputType ?? '';
    if (inputType.startsWith('delete')) return;
    const data = ev.data;
    if (typeof data !== 'string' || data === '') return;
    if (inputType === 'insertFromPaste') {
      ev.preventDefault();
      paste(el, data);
      return;
    }
    // A single typed character: digits , . only. A MULTI-character insert (IME composition,
    // suggestion / autocorrect, Android clipboard chip) is left to the browser — onChange then
    // treats the inserted run like a paste (never re-spliced here, which would duplicate text).
    if (data.length === 1 && !TYPABLE.test(data)) ev.preventDefault();
  };

  return {
    type: 'text' as const,
    inputMode: 'numeric' as const,
    pattern: '[0-9]*',
    autoComplete: 'off',
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        commit(e.currentTarget);
        return;
      }
      // A printable key that isn't a digit / "," / "." is refused (shortcuts like Ctrl+V pass).
      if (e.key.length === 1 && !TYPABLE.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
      }
    },
    // Android / IME: keydown is "Unidentified", but the NATIVE beforeinput event carries the
    // inserted text + inputType. React's synthetic onBeforeInput does not expose native
    // beforeinput, so the listener is bound on the element itself (once), reading the latest
    // handler off the node so a re-render never leaves a stale closure behind.
    ref: (el: HTMLInputElement | null) => {
      opts.ref?.(el);
      if (!el) return;
      (el as WrNode).__wrBeforeInput = (ev: InputEvent) => onNativeBeforeInput(ev, el);
      if (!el.dataset.wrBound) {
        el.dataset.wrBound = '1';
        el.addEventListener('beforeinput', (ev) => (el as WrNode).__wrBeforeInput?.(ev as InputEvent));
      }
    },
    onBlur: (e: React.FocusEvent<HTMLInputElement>) => commit(e.currentTarget),
    onPaste: (e: React.ClipboardEvent<HTMLInputElement>) => {
      e.preventDefault();
      paste(e.currentTarget, e.clipboardData.getData('text'));
    },
    // Every edit lands here (desktop keys, Android, IME, autocorrect): the text is kept verbatim
    // unless the edit ADDED a character a keystroke can't type — then the current text is kept.
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      const el = e.target;
      const raw = el.value;
      const prev = current(el);
      // A single change that INSERTED more than one character (Android clipboard-chip paste
      // arrives as insertText "₹1,250" with no paste event; a keyboard suggestion) is treated
      // like a paste: currency marker stripped, spliced where it landed, interpreted at once.
      const ins = insertedRun(prev, raw);
      if (ins.inserted.length > 1) {
        interpret(el, ins.before + stripCurrencyPrefix(ins.inserted) + ins.after);
        return;
      }
      const extra = untypable(raw);
      if (extra !== '' && !isSubsequence(extra, untypable(prev))) {
        // REFUSED: restore the current text WITHOUT reporting a change — the value did not
        // change, so a shown "Check the amount" flag must stay (only a real edit clears it).
        el.value = prev;
        return;
      }
      emit(el, raw);
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
 *  - `reset(text?)`: set the text programmatically (clears the message and the node's last text).
 */
export function useWholeRupeeField(initial = '') {
  const [value, setValue] = useState(initial);
  const [flagged, setFlagged] = useState(false);
  const elRef = useRef<HTMLInputElement | null>(null);
  const amount = wholeRupeeAmount(value);
  const invalid = amount === null;
  const inputProps = wholeRupeeInputProps(
    (text) => { setValue(text); setFlagged(false); },
    { onCommit: (bad) => setFlagged(bad), value, ref: (el) => { elRef.current = el; } },
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
    reset: (text = '') => {
      // Forget the node's last-emitted text too, so no path can ever restore a pre-reset value.
      if (elRef.current) delete elRef.current.dataset.last;
      setValue(text);
      setFlagged(false);
    },
  };
}
