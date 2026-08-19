/// <reference types="vitest/globals" />
/**
 * RBAC Option-X P6 — AccessDenied renders the clear, standard message.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AccessDenied } from '@/components/rbac/access-denied';

describe('<AccessDenied/>', () => {
  it('renders the standard heading + body copy', () => {
    render(<AccessDenied />);
    expect(screen.getByText("You don't have permission to access this")).toBeTruthy();
    expect(
      screen.getByText("Your role doesn't include access to this page. Ask your admin to grant it."),
    ).toBeTruthy();
  });

  it('accepts a custom body message', () => {
    render(<AccessDenied message="Custom denial copy." />);
    expect(screen.getByText('Custom denial copy.')).toBeTruthy();
  });

  it('is an alert region for assistive tech', () => {
    render(<AccessDenied />);
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});
