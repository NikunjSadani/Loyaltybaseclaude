/**
 * Whole-rupee amount inputs (owner decision 2026-11-11, ALL tenants): every place a member or
 * sales rep TYPES a redemption ₹ amount (variable vouchers + cash payouts) accepts whole rupees
 * only. The backend enforces the same rule (RedeemDto.amount @IsInt → 400 "Enter a whole-rupee
 * amount"); this is the matching UX so a decimal never even reaches the server.
 *
 * Behaviour (the field never displays a decimal):
 *   - typing "." is refused AND the fractional digits typed right after it are dropped, so
 *     typing "750.5" leaves "750" (not "7505"); any other key (Backspace, arrows, Tab…) or
 *     leaving the field ends that state;
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
const DECIMAL_KEY = '.';

/**
 * Props for a controlled whole-rupee <input>: spread onto the element and render `value`
 * yourself. `onValue` receives the sanitised digit string.
 */
export function wholeRupeeInputProps(onValue: (digits: string) => void) {
  return {
    type: 'text' as const,
    inputMode: 'numeric' as const,
    pattern: '[0-9]*',
    autoComplete: 'off',
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      const el = e.currentTarget;
      if (e.key === DECIMAL_KEY) {
        e.preventDefault();
        el.dataset.fraction = '1'; // swallow the fractional digits that follow
        return;
      }
      if (el.dataset.fraction === '1') {
        if (/^\d$/.test(e.key)) { e.preventDefault(); return; }
        delete el.dataset.fraction;
      }
      if (REFUSED_KEYS.has(e.key)) e.preventDefault();
    },
    onBlur: (e: React.FocusEvent<HTMLInputElement>) => {
      delete e.currentTarget.dataset.fraction;
    },
    onPaste: (e: React.ClipboardEvent<HTMLInputElement>) => {
      e.preventDefault();
      const el = e.currentTarget;
      delete el.dataset.fraction;
      const pasted = wholeRupeesFromText(e.clipboardData.getData('text'));
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      onValue(wholeRupeesFromText(el.value.slice(0, start) + pasted + el.value.slice(end)));
    },
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => onValue(wholeRupeesFromText(e.target.value)),
  };
}
