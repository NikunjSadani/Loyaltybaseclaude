/**
 * Runtime BEHAVIOUR flags — tenant `clients.features` keys that change how an existing flow behaves
 * (they are NOT console modules, so they are deliberately excluded from `FeatureKey`; see
 * client-config.ts). The Gifsy console edits them in a separate "Behaviour flags" section through the
 * SAME `PATCH /api/gifsy/clients/:slug { features }` path (GIFSY_ADMIN, tenancy:write); the backend
 * merges one key at a time, so every other stored flag survives. Default OFF for every tenant —
 * nothing changes for a tenant (incl. Deoleo) until its flag is switched on here.
 *
 * Shared by the client detail page and the new-client wizard so the copy never drifts.
 */
import type { FeatureFlags } from './client-config';

export type BehaviourFlagKey = keyof Pick<FeatureFlags, 'outletMasterGeo' | 'soDeclarationKyc' | 'allowPayoutWithoutPan'>;

export const BEHAVIOUR_FLAG_META: Record<BehaviourFlagKey, { label: string; description: string }> = {
  outletMasterGeo: {
    label: 'Outlet master Lat/Long + 200 m geo-fence',
    description:
      'Adds optional Latitude/Longitude columns to the outlet-master upload and template, and uses those coordinates for a 200 m geo-fence on KYC and visibility capture. Turn ON before the outlet upload that carries coordinates.',
  },
  soDeclarationKyc: {
    label: 'SO-declaration KYC',
    description:
      "Offers the SO-declaration KYC variant: the full enrollment is still captured, but PAN/GST/GST certificate/address proof become optional and the SO and ASM sign a declaration instead (for owners who won't share documents).",
  },
  allowPayoutWithoutPan: {
    label: 'Allow payouts without PAN',
    description:
      "Partners with no PAN on file can still be paid; TDS is applied at the no-PAN rate and shown as 'NO PAN ON FILE'.",
  },
};

export const BEHAVIOUR_FLAG_KEYS = Object.keys(BEHAVIOUR_FLAG_META) as BehaviourFlagKey[];
