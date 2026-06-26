/**
 * Tests for the reusable SearchableSelect combobox used by the KYC "State" field.
 *
 *   - opens its option list on focus
 *   - filters options by the typed query
 *   - selecting an option calls onChange with the option string and closes the list
 *   - shows a prefilled value (the committed `value`) in the input
 *   - clear button resets to ''
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import { SearchableSelect } from '../searchable-select';

const OPTIONS = ['Maharashtra', 'Madhya Pradesh', 'Karnataka', 'Kerala', 'Goa'];

function Harness({ initial = '' }: { initial?: string }) {
  const [value, setValue] = React.useState(initial);
  return (
    <SearchableSelect
      options={OPTIONS}
      value={value}
      onChange={setValue}
      placeholder="Maharashtra"
      testIdPrefix="state-select"
      aria-label="State"
    />
  );
}

describe('SearchableSelect', () => {
  it('shows the prefilled value in the input on mount', () => {
    render(<Harness initial="Karnataka" />);
    expect(screen.getByTestId('state-select-input')).toHaveValue('Karnataka');
  });

  it('opens the option list on focus', () => {
    render(<Harness />);
    expect(screen.queryByTestId('state-select-list')).toBeNull();
    fireEvent.focus(screen.getByTestId('state-select-input'));
    expect(screen.getByTestId('state-select-list')).toBeInTheDocument();
  });

  it('filters the options by the typed query', () => {
    render(<Harness />);
    const input = screen.getByTestId('state-select-input');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'mad' } });
    // "mad" matches Madhya Pradesh only (case-insensitive substring).
    expect(screen.getByTestId('state-select-option-Madhya Pradesh')).toBeInTheDocument();
    expect(screen.queryByTestId('state-select-option-Karnataka')).toBeNull();
    expect(screen.queryByTestId('state-select-option-Maharashtra')).toBeNull();
  });

  it('selecting an option commits its string value and closes the list', () => {
    const onChange = vi.fn();
    render(
      <SearchableSelect
        options={OPTIONS}
        value=""
        onChange={onChange}
        testIdPrefix="state-select"
      />,
    );
    fireEvent.focus(screen.getByTestId('state-select-input'));
    fireEvent.mouseDown(screen.getByTestId('state-select-option-Kerala'));
    expect(onChange).toHaveBeenCalledWith('Kerala');
    expect(screen.queryByTestId('state-select-list')).toBeNull();
  });

  it('filters then selects, leaving the chosen value in the input', () => {
    render(<Harness />);
    const input = screen.getByTestId('state-select-input');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'kar' } });
    fireEvent.mouseDown(screen.getByTestId('state-select-option-Karnataka'));
    expect(screen.getByTestId('state-select-input')).toHaveValue('Karnataka');
  });

  it('clears the value via the clear button', () => {
    render(<Harness initial="Goa" />);
    expect(screen.getByTestId('state-select-input')).toHaveValue('Goa');
    fireEvent.click(screen.getByTestId('state-select-clear'));
    expect(screen.getByTestId('state-select-input')).toHaveValue('');
  });
});
