/// <reference types="vitest/globals" />
/**
 * TDD: OutletPhotoGallery
 *
 * Shows outlet photos (OUTLET_PHOTO / SHOP_ESTABLISHMENT documents) taken
 * during a KYC site visit.  Displayed on the outlet information page.
 *
 * Specs (updated for lazy-load design — thumbnails are NOT pre-loaded):
 *  - renders a heading "Outlet Photos"
 *  - shows photo count in the heading  e.g. "Outlet Photos (3)"
 *  - shows an empty-state message when photos array is empty
 *  - does NOT render any <img> on mount (lazy — images only load when gallery opens)
 *  - clicking the "View Photos" button opens the lightbox overlay
 *  - lightbox renders the full-size image src of the first photo
 *  - lightbox closes when the × button is pressed
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { OutletPhotoGallery } from '../outlet-photo-gallery';

const PHOTOS = [
  { id: 'p1', fileUrl: 'https://storage/shop_front.jpg',   documentType: 'OUTLET_PHOTO',    createdAt: '2026-04-01T10:00:00Z' },
  { id: 'p2', fileUrl: 'https://storage/shop_inside.jpg',  documentType: 'OUTLET_PHOTO',    createdAt: '2026-04-01T10:05:00Z' },
  { id: 'p3', fileUrl: 'https://storage/establishment.jpg',documentType: 'SHOP_ESTABLISHMENT', createdAt: '2026-04-01T10:10:00Z' },
];

describe('OutletPhotoGallery', () => {
  it('renders the "Outlet Photos" heading', () => {
    render(<OutletPhotoGallery photos={PHOTOS} />);
    expect(screen.getByText(/outlet photos/i)).toBeInTheDocument();
  });

  it('shows the photo count in the heading', () => {
    render(<OutletPhotoGallery photos={PHOTOS} />);
    expect(screen.getByText(/outlet photos \(3\)/i)).toBeInTheDocument();
  });

  it('does NOT render any <img> on mount (lazy — no pre-loaded thumbnails)', () => {
    render(<OutletPhotoGallery photos={PHOTOS} />);
    // Bandwidth saving: images must NOT be fetched until the user explicitly opens the gallery
    expect(screen.queryAllByRole('img')).toHaveLength(0);
  });

  it('shows the correct src of the first photo after opening the lightbox', () => {
    render(<OutletPhotoGallery photos={PHOTOS} />);
    fireEvent.click(screen.getByTestId('outlet-photo-view-btn'));
    // Lightbox shows the first photo
    const imgs = screen.getAllByRole('img');
    expect(imgs[0]).toHaveAttribute('src', 'https://storage/shop_front.jpg');
  });

  it('shows empty-state message when photos array is empty', () => {
    render(<OutletPhotoGallery photos={[]} />);
    expect(screen.getByText(/no outlet photos/i)).toBeInTheDocument();
  });

  it('does not render thumbnails when photos array is empty', () => {
    render(<OutletPhotoGallery photos={[]} />);
    expect(screen.queryAllByRole('img')).toHaveLength(0);
  });

  it('opens lightbox with the full-size image when "View Photos" is clicked', () => {
    render(<OutletPhotoGallery photos={PHOTOS} />);
    fireEvent.click(screen.getByTestId('outlet-photo-view-btn'));
    // Lightbox should appear and show first photo src
    expect(screen.getByTestId('outlet-photo-lightbox')).toBeInTheDocument();
    const lightboxImg = screen.getByRole('img');
    expect(lightboxImg).toHaveAttribute('src', 'https://storage/shop_front.jpg');
  });

  it('closes the lightbox when the × button is clicked', () => {
    render(<OutletPhotoGallery photos={PHOTOS} />);
    // Open lightbox first
    fireEvent.click(screen.getByTestId('outlet-photo-view-btn'));
    expect(screen.getByTestId('outlet-photo-lightbox')).toBeInTheDocument();
    // Close it
    const closeBtn = screen.getByRole('button', { name: /close/i });
    fireEvent.click(closeBtn);
    // Lightbox element should be gone
    expect(screen.queryByTestId('outlet-photo-lightbox')).not.toBeInTheDocument();
  });
});
