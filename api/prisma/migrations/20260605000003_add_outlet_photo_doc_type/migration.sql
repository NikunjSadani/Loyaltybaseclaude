-- Add OUTLET_PHOTO to KycDocumentType enum
-- Used for photos of the outlet taken by the XSR during the KYC site visit.
-- These are displayed on the outlet information page in the sales app.
ALTER TYPE "KycDocumentType" ADD VALUE IF NOT EXISTS 'OUTLET_PHOTO';
