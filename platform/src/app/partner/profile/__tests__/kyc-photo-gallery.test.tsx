/// <reference types="vitest/globals" />
/**
 * TDD — KYC photo gallery (multiple photos)
 *
 * R1: "View Photos" button (not a plain link) is present in Business Details
 * R2: clicking "View Photos" opens a modal/gallery
 * R3: the gallery renders both KYC photos (2 images)
 * R4: gallery shows a photo counter indicating multiple photos (e.g. "1 / 2")
 * R5: a Next button exists in the gallery to navigate to the second photo
 * R6: clicking Next advances to the second photo (counter shows "2 / 2")
 * R7: a Previous button exists in the gallery
 * R8: clicking Prev from photo 2 goes back to photo 1 (counter shows "1 / 2")
 */

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

import ProfilePage from '../page';

async function renderAndLoad() {
  render(<ProfilePage />);
  await waitFor(
    () => expect(screen.getByTestId('profile-header')).toBeInTheDocument(),
    { timeout: 2000 },
  );
}

describe('R — KYC photo gallery', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('R1: "View Photos" button is present in Business Details', async () => {
    await renderAndLoad();
    expect(screen.getByTestId('kyc-photo-btn')).toBeInTheDocument();
  });

  it('R2: clicking "View Photos" opens the photo gallery modal', async () => {
    await renderAndLoad();
    fireEvent.click(screen.getByTestId('kyc-photo-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('kyc-photo-gallery')).toBeInTheDocument(),
    );
  });

  it('R3: the gallery contains both KYC photos', async () => {
    await renderAndLoad();
    fireEvent.click(screen.getByTestId('kyc-photo-btn'));
    await waitFor(() => screen.getByTestId('kyc-photo-gallery'));
    // Both photo URLs should be present as <img> src values
    const imgs = screen.getAllByRole('img', { hidden: true });
    expect(imgs.length).toBeGreaterThanOrEqual(2);
  });

  it('R4: gallery shows a counter indicating multiple photos ("1 / 2")', async () => {
    await renderAndLoad();
    fireEvent.click(screen.getByTestId('kyc-photo-btn'));
    await waitFor(() => screen.getByTestId('kyc-photo-gallery'));
    expect(screen.getByTestId('photo-counter')).toHaveTextContent('1 / 2');
  });

  it('R5: a Next button exists in the gallery', async () => {
    await renderAndLoad();
    fireEvent.click(screen.getByTestId('kyc-photo-btn'));
    await waitFor(() => screen.getByTestId('kyc-photo-gallery'));
    expect(screen.getByTestId('photo-next')).toBeInTheDocument();
  });

  it('R6: clicking Next advances counter to "2 / 2"', async () => {
    await renderAndLoad();
    fireEvent.click(screen.getByTestId('kyc-photo-btn'));
    await waitFor(() => screen.getByTestId('kyc-photo-gallery'));
    fireEvent.click(screen.getByTestId('photo-next'));
    expect(screen.getByTestId('photo-counter')).toHaveTextContent('2 / 2');
  });

  it('R7: a Previous button exists in the gallery', async () => {
    await renderAndLoad();
    fireEvent.click(screen.getByTestId('kyc-photo-btn'));
    await waitFor(() => screen.getByTestId('kyc-photo-gallery'));
    expect(screen.getByTestId('photo-prev')).toBeInTheDocument();
  });

  it('R8: clicking Prev from photo 2 goes back to "1 / 2"', async () => {
    await renderAndLoad();
    fireEvent.click(screen.getByTestId('kyc-photo-btn'));
    await waitFor(() => screen.getByTestId('kyc-photo-gallery'));
    fireEvent.click(screen.getByTestId('photo-next'));
    fireEvent.click(screen.getByTestId('photo-prev'));
    expect(screen.getByTestId('photo-counter')).toHaveTextContent('1 / 2');
  });
});
