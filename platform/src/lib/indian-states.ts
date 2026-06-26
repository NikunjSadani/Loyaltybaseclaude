/**
 * Canonical list of Indian States and Union Territories.
 *
 * Pure data module — no DOM, no browser APIs. Used to drive the address
 * "State" searchable dropdown on the KYC forms so the submitted value is always
 * one of these exact strings.
 *
 * Composition (as of the 2019/2020 reorganisations):
 *   - 28 States
 *   - 8 Union Territories (Delhi/NCT, Jammu and Kashmir, Ladakh, Puducherry,
 *     Andaman and Nicobar Islands, Dadra and Nagar Haveli and Daman and Diu,
 *     Lakshadweep, Chandigarh)
 *
 * Sorted alphabetically (case-insensitive ASCII) so the dropdown is browsable.
 */

/** The 28 states of India. */
export const INDIAN_STATE_NAMES: readonly string[] = [
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chhattisgarh',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
];

/** The 8 union territories of India. */
export const INDIAN_UNION_TERRITORY_NAMES: readonly string[] = [
  'Andaman and Nicobar Islands',
  'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi',
  'Jammu and Kashmir',
  'Ladakh',
  'Lakshadweep',
  'Puducherry',
];

/**
 * All 28 states + 8 union territories, alphabetically sorted.
 * This is the canonical option list for the State dropdown.
 */
export const INDIAN_STATES: string[] = [
  ...INDIAN_STATE_NAMES,
  ...INDIAN_UNION_TERRITORY_NAMES,
].sort((a, b) => a.localeCompare(b));
