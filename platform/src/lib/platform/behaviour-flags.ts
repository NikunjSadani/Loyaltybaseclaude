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

export type BehaviourFlagKey = keyof Pick<FeatureFlags, 'outletMasterGeo' | 'soDeclarationKyc' | 'allowPayoutWithoutPan' | 'gifsyRejectFastTrack'>;

export interface BehaviourFlagMeta {
  label: string;
  description: string;
  /**
   * When set, switching the flag ON (console) first asks for explicit confirmation with this copy.
   * Switching it OFF never asks. Used for flags that change who gets paid / what tax the company bears, or
   * who checks a KYC before GIFSY (gifsyRejectFastTrack).
   */
  confirmOn?: { title: string; points: string[]; confirmLabel: string };
}

export const BEHAVIOUR_FLAG_META: Record<BehaviourFlagKey, BehaviourFlagMeta> = {
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
      "Partners with no PAN on file can still be paid. They are paid the full amount; the TDS at the no-PAN rate is a company-borne liability shown in the TDS reports as 'NO PAN ON FILE'.",
    confirmOn: {
      title: 'Allow payouts without PAN?',
      points: [
        'Partners with no PAN on file will be paid the FULL amount — nothing is withheld from them.',
        "Pending no-PAN payments in batches that haven't been paid yet (draft, submitted or failed) will be included the next time those batches are processed.",
        "The TDS at the no-PAN rate is a company-borne liability — it is shown in the TDS reports as 'NO PAN ON FILE' and has to be deposited by the company.",
      ],
      confirmLabel: 'Yes, allow payouts without PAN',
    },
  },
  gifsyRejectFastTrack: {
    label: 'Send GIFSY-rejected KYC resubmissions straight to GIFSY',
    description:
      'When GIFSY rejects a KYC the managers already approved, the corrected resubmission skips manager approval. SO Declaration KYCs still go through managers.',
    // F2: it changes who checks a KYC before GIFSY — confirm before switching ON (OFF never asks).
    confirmOn: {
      title: 'Send GIFSY-rejected KYC resubmissions straight to GIFSY?',
      points: [
        'Applies to KYCs GIFSY rejected before this was switched on too.',
        "Only outlets' own assigned rep (or their managers) get the shortcut.",
        'Managers are not notified for these KYCs.',
        'Switching it off does not pull back KYCs already sent to GIFSY.',
        'SO Declaration KYCs always go through managers.',
      ],
      confirmLabel: 'Yes, send resubmissions straight to GIFSY',
    },
  },
};

export const BEHAVIOUR_FLAG_KEYS = Object.keys(BEHAVIOUR_FLAG_META) as BehaviourFlagKey[];
