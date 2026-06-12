// TDD: OutletTypeConfigSection
// Tests written BEFORE implementation.
// Run: npx vitest run src/components/admin/__tests__/outlet-type-config-section.test.tsx

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { OutletTypeConfigSection } from '../outlet-type-config-section';
import type { OutletTypeClientConfig } from '@/lib/platform/outlet-types';

// ── A. Rendering ──────────────────────────────────────────────────────────────

describe('A – initial render', () => {
  it('A1: renders a card for each of the 4 outlet types', () => {
    render(<OutletTypeConfigSection clientId="deoleo" />);
    expect(screen.getByText('SSS')).toBeInTheDocument();
    expect(screen.getByText('Wholesaler')).toBeInTheDocument();
    expect(screen.getByText('Sub-Stockist')).toBeInTheDocument();
    expect(screen.getByText('SSS TOT')).toBeInTheDocument();
  });

  it('A2: shows the stable code next to each outlet type name', () => {
    render(<OutletTypeConfigSection clientId="deoleo" />);
    expect(screen.getByText('SSS')).toBeInTheDocument();
    expect(screen.getByText('WHOLESALER')).toBeInTheDocument();
    expect(screen.getByText('SUB_STOCKIST')).toBeInTheDocument();
    expect(screen.getByText('SSS_TOT')).toBeInTheDocument();
  });

  it('A3: all 4 isEnabled toggles are ON by default', () => {
    render(<OutletTypeConfigSection clientId="deoleo" />);
    const switches = screen.getAllByRole('switch', { name: /enable for this client/i });
    expect(switches).toHaveLength(4);
    switches.forEach((sw) => expect(sw).toHaveAttribute('aria-checked', 'true'));
  });

  it('A4: respects pre-loaded configs — disabled outlet type shown as OFF', () => {
    const configs: OutletTypeClientConfig[] = [{
      clientId: 'deoleo', outletTypeCode: 'WHOLESALER',
      isEnabled: false, displayName: null,
      loyaltyEnabled: true, schemesEnabled: true,
      visibilityEnabled: true, payoutsEnabled: true,
      leaderboardEnabled: true, targetsEnabled: true, kycRequired: true,
    }];
    render(<OutletTypeConfigSection clientId="deoleo" initialConfigs={configs} />);
    const switches = screen.getAllByRole('switch', { name: /enable for this client/i });
    // Wholesaler is the 2nd card — its switch should be OFF
    expect(switches[1]).toHaveAttribute('aria-checked', 'false');
    // Others still ON
    expect(switches[0]).toHaveAttribute('aria-checked', 'true');
  });
});

// ── B. isEnabled toggle ───────────────────────────────────────────────────────

describe('B – isEnabled toggle in card header', () => {
  it('B1: toggling isEnabled OFF for Retailer marks that switch as false', () => {
    render(<OutletTypeConfigSection clientId="deoleo" />);
    const switches = screen.getAllByRole('switch', { name: /enable for this client/i });
    fireEvent.click(switches[0]);  // Retailer
    expect(switches[0]).toHaveAttribute('aria-checked', 'false');
  });

  it('B2: toggling Retailer OFF does not affect Wholesaler', () => {
    render(<OutletTypeConfigSection clientId="deoleo" />);
    const switches = screen.getAllByRole('switch', { name: /enable for this client/i });
    fireEvent.click(switches[0]);
    expect(switches[1]).toHaveAttribute('aria-checked', 'true');
  });

  it('B3: toggling OFF then ON again restores the switch', () => {
    render(<OutletTypeConfigSection clientId="deoleo" />);
    const [sw] = screen.getAllByRole('switch', { name: /enable for this client/i });
    fireEvent.click(sw);
    fireEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'true');
  });
});

// ── C. Expand / collapse ──────────────────────────────────────────────────────

describe('C – expanding a card reveals feature flags', () => {
  it('C1: feature flag toggles are not visible before expanding', () => {
    render(<OutletTypeConfigSection clientId="deoleo" />);
    // "Loyalty" toggle should not be in the document until a card is expanded
    expect(screen.queryByRole('switch', { name: /loyalty/i })).not.toBeInTheDocument();
  });

  it('C2: clicking the Retailer card header expands it and shows feature flags', () => {
    render(<OutletTypeConfigSection clientId="deoleo" />);
    // Click the expand button on the first card
    const expandButtons = screen.getAllByRole('button', { name: /configure/i });
    fireEvent.click(expandButtons[0]);
    expect(screen.getByRole('switch', { name: /loyalty/i })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /schemes/i })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /visibility/i })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /payouts/i })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /leaderboard/i })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /targets/i })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /kyc required/i })).toBeInTheDocument();
  });

  it('C3: feature flags all default to ON when expanded', () => {
    render(<OutletTypeConfigSection clientId="deoleo" />);
    const expandButtons = screen.getAllByRole('button', { name: /configure/i });
    fireEvent.click(expandButtons[0]);
    const featureSwitches = screen.getAllByRole('switch', { name: /loyalty|schemes|visibility|payouts|leaderboard|targets|kyc required/i });
    expect(featureSwitches.length).toBe(7);
    featureSwitches.forEach((sw) => expect(sw).toHaveAttribute('aria-checked', 'true'));
  });

  it('C4: clicking again collapses and hides feature flags', () => {
    render(<OutletTypeConfigSection clientId="deoleo" />);
    const [btn] = screen.getAllByRole('button', { name: /configure/i });
    fireEvent.click(btn);  // expand
    fireEvent.click(btn);  // collapse
    expect(screen.queryByRole('switch', { name: /loyalty/i })).not.toBeInTheDocument();
  });
});

// ── D. Feature flag toggles ───────────────────────────────────────────────────

describe('D – feature flag toggles', () => {
  function expandRetailer() {
    const expandButtons = screen.getAllByRole('button', { name: /configure/i });
    fireEvent.click(expandButtons[0]);
  }

  it('D1: toggling Schemes OFF sets it to false', () => {
    render(<OutletTypeConfigSection clientId="deoleo" />);
    expandRetailer();
    const schemesSwitch = screen.getByRole('switch', { name: /schemes/i });
    fireEvent.click(schemesSwitch);
    expect(schemesSwitch).toHaveAttribute('aria-checked', 'false');
  });

  it('D2: toggling Schemes OFF does not affect Loyalty', () => {
    render(<OutletTypeConfigSection clientId="deoleo" />);
    expandRetailer();
    fireEvent.click(screen.getByRole('switch', { name: /schemes/i }));
    expect(screen.getByRole('switch', { name: /loyalty/i })).toHaveAttribute('aria-checked', 'true');
  });

  it('D3: toggling KYC Required OFF reflects in the switch', () => {
    render(<OutletTypeConfigSection clientId="deoleo" />);
    expandRetailer();
    const kycSwitch = screen.getByRole('switch', { name: /kyc required/i });
    fireEvent.click(kycSwitch);
    expect(kycSwitch).toHaveAttribute('aria-checked', 'false');
  });
});

// ── E. Custom display name ────────────────────────────────────────────────────

describe('E – custom display name override', () => {
  function expandRetailer() {
    const expandButtons = screen.getAllByRole('button', { name: /configure/i });
    fireEvent.click(expandButtons[0]);
  }

  it('E1: shows a display name input when expanded', () => {
    render(<OutletTypeConfigSection clientId="deoleo" />);
    expandRetailer();
    expect(screen.getByLabelText(/custom name/i)).toBeInTheDocument();
  });

  it('E2: display name input is empty by default (no override)', () => {
    render(<OutletTypeConfigSection clientId="deoleo" />);
    expandRetailer();
    const input = screen.getByLabelText(/custom name/i) as HTMLInputElement;
    expect(input.value).toBe('');
  });

  it('E3: pre-loaded display name is shown in the input', () => {
    const configs: OutletTypeClientConfig[] = [{
      clientId: 'deoleo', outletTypeCode: 'SSS',
      isEnabled: true, displayName: 'Dealer',
      loyaltyEnabled: true, schemesEnabled: true,
      visibilityEnabled: true, payoutsEnabled: true,
      leaderboardEnabled: true, targetsEnabled: true, kycRequired: true,
    }];
    render(<OutletTypeConfigSection clientId="deoleo" initialConfigs={configs} />);
    expandRetailer();
    const input = screen.getByLabelText(/custom name/i) as HTMLInputElement;
    expect(input.value).toBe('Dealer');
  });

  it('E4: typing a custom name updates the input', () => {
    render(<OutletTypeConfigSection clientId="deoleo" />);
    expandRetailer();
    const input = screen.getByLabelText(/custom name/i);
    fireEvent.change(input, { target: { value: 'Dealer' } });
    expect((input as HTMLInputElement).value).toBe('Dealer');
  });
});
