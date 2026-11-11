/// <reference types="vitest/globals" />
/**
 * WR — whole-rupee redemption amount inputs (owner decision 2026-11-11, all tenants).
 * Typing or pasting "750.5" must never leave a decimal (or "7505") in the field.
 */
import React, { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { wholeRupeeAmount, wholeRupeeInputProps, wholeRupeesFromText } from '../whole-rupee-input';

function Harness() {
  const [v, setV] = useState('');
  return <input aria-label="amt" value={v} {...wholeRupeeInputProps(setV)} />;
}

describe('WR — wholeRupeesFromText', () => {
  it.each([
    ['750.5', '750'],
    ['1,250.75', '1250'],
    ['₹ 900', '900'],
    ['7e2', '72'],
    ['.5', ''],
    ['', ''],
    ['750,5', '750'],
    ['750,', '750'],
    ['1,25,000', '125000'],
    ['1,250', '1250'],
    ['12,50', '12'],
  ])('%s → %s', (input, out) => {
    expect(wholeRupeesFromText(input)).toBe(out);
  });
});

describe('WR — wholeRupeeInputProps', () => {
  it('WR1: typing "750.5" yields "750" (the "." and the digits after it are dropped)', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.type(el, '750.5');
    expect(el.value).toBe('750');
  });

  it('WR2: after a refused ".", Backspace ends the fraction state and typing resumes', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.type(el, '75.9{Backspace}1');
    expect(el.value).toBe('71');
  });

  it('WR3: pasting "750.5" yields "750"; pasting "1,250.75" yields "1250"', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.click(el);
    await userEvent.paste('750.5');
    expect(el.value).toBe('750');
    await userEvent.clear(el);
    await userEvent.paste('1,250.75');
    expect(el.value).toBe('1250');
  });

  it('WR4: "e", "+", "-" are refused', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.type(el, '1e+-2');
    expect(el.value).toBe('12');
  });

  it('L1 regression: typing "1,250" key-by-key keeps the comma while typing and commits 1250 on blur', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.type(el, '1,');
    expect(el.value).toBe('1,'); // a trailing comma never truncates while typing
    await userEvent.type(el, '250');
    expect(el.value).toBe('1,250');
    expect(wholeRupeeAmount(el.value)).toBe(1250); // a reader before blur already gets 1250
    fireEvent.blur(el);
    expect(el.value).toBe('1250');
  });

  it('L1: typing "750,5" then blur → 750 (a non-grouping "," is a decimal mark, never "7505")', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.type(el, '750,5');
    expect(el.value).toBe('750,5');
    expect(wholeRupeeAmount(el.value)).toBe(750);
    fireEvent.blur(el);
    expect(el.value).toBe('750');
  });

  it('L1: Enter commits like blur ("1,25,000" typed → 125000)', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.type(el, '1,25,000{Enter}');
    expect(el.value).toBe('125000');
  });

  it('L1: pasting "1,25,000" → 125000 at once', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.click(el);
    await userEvent.paste('1,25,000');
    expect(el.value).toBe('125000');
  });

  it('L1 (Android): change "750," then "7505" keeps the comma ("750,5"); blur commits 750', () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    fireEvent.change(el, { target: { value: '750' } });
    fireEvent.keyDown(el, { key: 'Unidentified' });
    fireEvent.change(el, { target: { value: '750,' } });
    expect(el.value).toBe('750,');
    fireEvent.change(el, { target: { value: '750,5' } });
    expect(el.value).toBe('750,5');
    fireEvent.blur(el);
    expect(el.value).toBe('750');
  });

  it('L1 (Android beforeinput): data "," is inserted as-is (no fraction state); data "." starts it; delete ends it', () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    fireEvent.change(el, { target: { value: '750' } });
    el.setSelectionRange(3, 3);
    const bi = (data: string | null, inputType: string) =>
      fireEvent(el, new InputEvent('beforeinput', { data, inputType, bubbles: true, cancelable: true }));
    bi(',', 'insertText');
    expect(el.value).toBe('750,');
    expect(el.dataset.fraction).toBeUndefined();
    fireEvent.change(el, { target: { value: '750' } });
    el.setSelectionRange(3, 3);
    bi('.', 'insertText');
    expect(el.value).toBe('750');
    expect(el.dataset.fraction).toBe('1');
    // a digit insert while in the fraction state is refused (cancelled)
    expect(bi('5', 'insertText')).toBe(false);
    bi(null, 'deleteContentBackward');
    expect(el.dataset.fraction).toBeUndefined();
  });

  it('RC-L2: a "." or "," on an EMPTY field is dropped and does not start the fraction state (".5" → "5")', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.type(el, '.5');
    expect(el.value).toBe('5');
    await userEvent.clear(el);
    await userEvent.type(el, ',7');
    expect(el.value).toBe('7');
  });

  it('RC-L3: inserting "1.5" over a selected "500" splices at the selection → "1"', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    fireEvent.change(el, { target: { value: '500' } });
    el.focus();
    el.setSelectionRange(0, 3);
    await userEvent.paste('1.5');
    expect(el.value).toBe('1'); // paste path
    // same splice via an Android-style beforeinput insert
    fireEvent.change(el, { target: { value: '500' } });
    el.setSelectionRange(0, 3);
    fireEvent(el, new InputEvent('beforeinput', { data: '1.5', inputType: 'insertText', bubbles: true, cancelable: true }));
    expect(el.value).toBe('1'); // beforeinput path
  });

  it('WR6 (Android, keydown "Unidentified"): change events "750." then "7505" → stays 750; a deletion ends the fraction', () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    for (const v of ['7', '75', '750']) fireEvent.change(el, { target: { value: v } });
    fireEvent.keyDown(el, { key: 'Unidentified' });
    fireEvent.change(el, { target: { value: '750.' } });
    expect(el.value).toBe('750');
    fireEvent.keyDown(el, { key: 'Unidentified' });
    fireEvent.change(el, { target: { value: '7505' } });
    expect(el.value).toBe('750'); // never 7505
    fireEvent.change(el, { target: { value: '75055' } });
    expect(el.value).toBe('750');
    fireEvent.change(el, { target: { value: '75' } }); // backspace (a deletion) ends the fraction state
    fireEvent.change(el, { target: { value: '751' } });
    expect(el.value).toBe('751');
  });

  it('WR7 (Android): a "," that IS a thousands separator ("1,250") is kept while typing and stripped on blur', () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    fireEvent.change(el, { target: { value: '1,250' } });
    expect(el.value).toBe('1,250');
    fireEvent.blur(el);
    expect(el.value).toBe('1250');
  });

  it.each([
    ['1,250', 1250],
    ['750,5', 750],
    ['1,25,000', 125000],
    ['1,', 1],
    ['', 0],
  ])('wholeRupeeAmount(%s) → %s', (input, out) => {
    expect(wholeRupeeAmount(input)).toBe(out);
  });

  it('WR5: numeric keypad hints are set', () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt');
    expect(el).toHaveAttribute('inputmode', 'numeric');
    expect(el).toHaveAttribute('pattern', '[0-9]*');
  });
});
