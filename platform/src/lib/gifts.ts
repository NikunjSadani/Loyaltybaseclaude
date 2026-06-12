/* ─── Shared Gift Catalogue ──────────────────────────────────────────────────
   Single source of truth for both the admin gift manager and the partner
   rewards catalog. Admin changes are persisted to localStorage so the partner
   view always reflects the latest catalogue state.
────────────────────────────────────────────────────────────────────────────── */

export type VoucherDenominationType = 'FIXED' | 'FREE_AMOUNT';

export interface GiftCatalogueItem {
  id: string;
  name: string;
  brand: string;
  /** Physical item categories: 'Electronics' | 'Home & Kitchen' | 'Personal Appliances' | 'Health' | 'Travel'
   *  For vouchers the category is always 'Vouchers' */
  category: string;
  points: number;
  description: string;
  details: string;
  features: string[];
  emoji: string;
  gradientFrom: string;
  gradientTo: string;
  imageDataUrl: string | null;
  available: boolean;
  popular: boolean;
  addedDate: string;
  /** Only set for category === 'Vouchers' */
  voucherType?: VoucherDenominationType;
  /** Face value for FIXED vouchers (in ₹). Ignored for FREE_AMOUNT. */
  fixedAmount?: number;
}

const STORAGE_KEY = 'loyaltybase_gifts_v1';

export const GIFT_CATALOGUE: GiftCatalogueItem[] = [
  {
    id: 'g1', name: 'JBL Bluetooth Speaker', brand: 'JBL', category: 'Electronics', points: 2_500,
    emoji: '🔊', gradientFrom: 'var(--brand-primary)', gradientTo: '#22c55e', imageDataUrl: null,
    description: 'Portable waterproof Bluetooth speaker',
    details: 'The JBL Go 3 delivers rich JBL Pro Sound from a compact and fully waterproof body. Perfect for on-the-go listening — at home, outdoors, or in the rain.',
    features: ['IP67 waterproof & dustproof', 'Up to 5 hours playtime', 'JBL Pro Sound quality', 'Bluetooth 5.1 connectivity', 'Built-in speakerphone'],
    available: true, popular: true, addedDate: '2025-12-01',
  },
  {
    id: 'g2', name: 'Smart Watch', brand: 'Noise', category: 'Electronics', points: 5_000,
    emoji: '⌚', gradientFrom: '#1d4ed8', gradientTo: '#60a5fa', imageDataUrl: null,
    description: 'Feature-packed smartwatch with health tracking',
    details: 'Track your fitness, manage notifications, and monitor your health with this feature-rich smartwatch. Includes heart rate monitor, SpO2, and 7-day battery life.',
    features: ['7-day battery life', 'Heart rate & SpO2 monitor', '100+ watch faces', 'IP68 water resistant', '150+ sports modes'],
    available: true, popular: true, addedDate: '2025-12-01',
  },
  {
    id: 'g3', name: 'Wireless Earbuds', brand: 'boAt', category: 'Electronics', points: 3_200,
    emoji: '🎧', gradientFrom: '#7c3aed', gradientTo: '#a78bfa', imageDataUrl: null,
    description: 'True wireless earbuds with 42H total playback',
    details: 'The boAt Airdopes 141 are feature-packed TWS earbuds with 42 hours total playback. IPX4 rated, instant wake & pair, Bluetooth 5.0.',
    features: ['42 hours total playback', 'IPX4 water resistant', 'Bluetooth v5.0', 'Instant wake & pair', 'Voice assistant support'],
    available: true, popular: false, addedDate: '2025-12-05',
  },
  {
    id: 'g4', name: 'Power Bank 10000mAh', brand: 'Ambrane', category: 'Electronics', points: 1_800,
    emoji: '🔋', gradientFrom: '#0ea5e9', gradientTo: '#38bdf8', imageDataUrl: null,
    description: 'Slim dual-port fast-charging power bank',
    details: 'Never run out of charge with this 10000mAh slim power bank. Features dual USB output and 18W fast charging support for your smartphone and accessories.',
    features: ['10000mAh capacity', '18W fast charging', 'Dual USB output', 'LED charge indicator', 'Ultra-slim design'],
    available: true, popular: false, addedDate: '2025-12-05',
  },
  {
    id: 'g5', name: 'Amazon Voucher ₹500', brand: 'Amazon', category: 'Vouchers', points: 500,
    emoji: '🛍️', gradientFrom: '#FF9900', gradientTo: '#FFB347', imageDataUrl: null,
    description: 'Redeemable on Amazon.in for any product',
    details: 'The Amazon Gift Voucher is valid for all categories on Amazon.in — electronics, fashion, grocery, and more. No minimum order value. Never expires.',
    features: ['Valid for all Amazon.in categories', 'No expiry date', 'Instant delivery to email', 'Combinable with other vouchers'],
    available: true, popular: true, addedDate: '2025-11-20',
    voucherType: 'FIXED', fixedAmount: 500,
  },
  {
    id: 'g5b', name: 'Amazon Voucher (Any Amount)', brand: 'Amazon', category: 'Vouchers', points: 0,
    emoji: '🛍️', gradientFrom: '#FF9900', gradientTo: '#FFB347', imageDataUrl: null,
    description: 'Enter any amount — credits go to your Amazon Pay balance',
    details: 'Choose exactly how much you want to redeem. Amazon Pay balance is added to your Amazon account and usable across all categories.',
    features: ['Enter any amount (min as configured)', 'Instant to Amazon Pay balance', 'No expiry', 'Usable on all Amazon.in categories'],
    available: true, popular: false, addedDate: '2025-11-20',
    voucherType: 'FREE_AMOUNT',
  },
  {
    id: 'g6', name: 'Flipkart Voucher ₹1000', brand: 'Flipkart', category: 'Vouchers', points: 1_000,
    emoji: '🎁', gradientFrom: '#1a73e8', gradientTo: '#4da6ff', imageDataUrl: null,
    description: 'Shop anything on Flipkart with ₹1000 credit',
    details: 'Shop from millions of products on Flipkart. Valid across all categories — electronics, fashion, home, sports, beauty, and more. No minimum order.',
    features: ['All Flipkart categories', 'No minimum order', 'Stackable with Flipkart offers', 'Valid for 1 year'],
    available: true, popular: false, addedDate: '2025-11-20',
    voucherType: 'FIXED', fixedAmount: 1_000,
  },
  {
    id: 'g7', name: 'Swiggy Voucher ₹300', brand: 'Swiggy', category: 'Vouchers', points: 300,
    emoji: '🍱', gradientFrom: '#FC8019', gradientTo: '#FFB347', imageDataUrl: null,
    description: 'Food delivery credits on the Swiggy app',
    details: 'Swiggy Credits are added directly to your Swiggy wallet and deducted automatically at checkout. Valid at 2 lakh+ restaurant partners across India.',
    features: ['2 lakh+ restaurant partners', 'Added to wallet instantly', 'Auto-applied at checkout', 'Valid for 12 months'],
    available: true, popular: false, addedDate: '2025-12-10',
    voucherType: 'FIXED', fixedAmount: 300,
  },
  {
    id: 'g8', name: 'Indian Oil Petrol Card', brand: 'Indian Oil', category: 'Vouchers', points: 0,
    emoji: '⛽', gradientFrom: '#dc2626', gradientTo: '#f87171', imageDataUrl: null,
    description: 'Fuel credits at Indian Oil pumps — enter any amount',
    details: 'Indian Oil petrol card credits redeemable at thousands of Indian Oil petrol pumps across India. Valid for petrol, diesel, and CNG. No minimum transaction.',
    features: ['Valid at 27,000+ pumps', 'Petrol, diesel & CNG', 'No minimum transaction', 'Valid for 6 months'],
    available: true, popular: false, addedDate: '2025-12-10',
    voucherType: 'FREE_AMOUNT',
  },
  {
    id: 'g9', name: 'Mixer Grinder', brand: 'Prestige', category: 'Home & Kitchen', points: 4_000,
    emoji: '🥣', gradientFrom: '#d97706', gradientTo: '#fbbf24', imageDataUrl: null,
    description: '750W mixer grinder with 3 stainless steel jars',
    details: 'The Prestige Iris 750-watt mixer grinder comes with 3 stainless steel jars for grinding, mixing, and juicing. Features a powerful motor with 5-year warranty.',
    features: ['750W powerful motor', '3 stainless steel jars', '5-year motor warranty', 'Whipper and liquidiser functions', 'Easy lock lid system'],
    available: true, popular: false, addedDate: '2025-11-15',
  },
  {
    id: 'g10', name: 'Pressure Cooker 5L', brand: 'Hawkins', category: 'Home & Kitchen', points: 2_200,
    emoji: '🍲', gradientFrom: '#6b7280', gradientTo: '#9ca3af', imageDataUrl: null,
    description: '5-litre hard-anodised pressure cooker',
    details: 'Hawkins hard-anodised pressure cooker with 5-litre capacity. The hard-anodised body is stronger than stainless steel, scratch-resistant, and distributes heat evenly.',
    features: ['5-litre capacity', 'Hard-anodised body', 'Stronger than stainless steel', 'Even heat distribution', '5-year warranty'],
    available: true, popular: false, addedDate: '2025-11-15',
  },
  {
    id: 'g11', name: 'Electric Kettle', brand: 'Philips', category: 'Home & Kitchen', points: 1_600,
    emoji: '☕', gradientFrom: '#92400e', gradientTo: '#d97706', imageDataUrl: null,
    description: '1.5L cordless electric kettle with auto-shutoff',
    details: 'Philips 1.5L electric kettle boils water in under 4 minutes. Features auto-shutoff, boil-dry protection, and a removable limescale filter. BPA-free plastic.',
    features: ['1.5 litre capacity', 'Boils in under 4 minutes', 'Auto-shutoff & boil-dry protection', 'Removable limescale filter', 'BPA-free body'],
    available: true, popular: false, addedDate: '2025-12-01',
  },
  {
    id: 'g12', name: 'Air Fryer 4L', brand: 'Philips', category: 'Home & Kitchen', points: 6_500,
    emoji: '🍟', gradientFrom: '#b45309', gradientTo: '#f59e0b', imageDataUrl: null,
    description: '4-litre digital air fryer — 90% less oil',
    details: 'Cook crispy, delicious food with 90% less fat using Rapid Air technology. The Philips 4L Digital Air Fryer is easy to clean and has 7 preset cooking programs.',
    features: ['4 litre capacity', '90% less fat cooking', 'Rapid Air technology', '7 preset cooking programs', 'Dishwasher-safe basket'],
    available: false, popular: false, addedDate: '2025-11-01',
  },
  {
    id: 'g13', name: 'Flight Voucher ₹2000', brand: 'MakeMyTrip', category: 'Travel', points: 2_500,
    emoji: '✈️', gradientFrom: '#e91e63', gradientTo: '#f48fb1', imageDataUrl: null,
    description: 'Valid for flight bookings on MakeMyTrip',
    details: 'Use this voucher to book domestic and international flights on MakeMyTrip. Applicable on bookings of ₹3000 or more. Valid on app and website.',
    features: ['Domestic & international flights', 'Valid on bookings ₹3000+', 'App and website redemption', 'Valid for 6 months'],
    available: true, popular: false, addedDate: '2025-11-25',
  },
  {
    id: 'g14', name: 'Hotel Voucher ₹1500', brand: 'OYO', category: 'Travel', points: 1_800,
    emoji: '🏨', gradientFrom: '#c2410c', gradientTo: '#fb923c', imageDataUrl: null,
    description: 'OYO hotel booking voucher across India',
    details: 'Book your stay at 10,000+ OYO hotels across 500+ cities in India. Valid for standard and premium room categories. No minimum booking amount.',
    features: ['10,000+ OYO hotels', '500+ cities in India', 'Standard & premium rooms', 'No minimum booking', 'Valid for 12 months'],
    available: true, popular: false, addedDate: '2025-11-25',
  },
  {
    id: 'g17', name: 'Hair Dryer', brand: 'Philips', category: 'Personal Appliances', points: 2_000,
    emoji: '💇', gradientFrom: '#db2777', gradientTo: '#f472b6', imageDataUrl: null,
    description: '1200W hair dryer with cool-shot button',
    details: 'Philips 1200W hair dryer with 2 heat and speed settings, cool-shot function for long-lasting style, and a concentrator nozzle for targeted airflow.',
    features: ['1200W powerful airflow', '2 heat + 2 speed settings', 'Cool-shot for lasting styles', 'Concentrator nozzle included', 'Hanging loop for easy storage'],
    available: true, popular: false, addedDate: '2025-12-15',
  },
  {
    id: 'g18', name: 'Electric Shaver', brand: 'Braun', category: 'Personal Appliances', points: 3_800,
    emoji: '🪒', gradientFrom: '#1d4ed8', gradientTo: '#93c5fd', imageDataUrl: null,
    description: 'Wet & dry electric foil shaver',
    details: 'Braun Series 3 ProSkin electric shaver adapts to facial contours for a comfortable shave. 100% waterproof — use wet or dry, with or without gel.',
    features: ['100% waterproof wet & dry', 'Adapts to facial contours', '50-min cordless use after 1hr charge', 'Precision trimmer for details', 'Easy clean rinse'],
    available: true, popular: false, addedDate: '2025-12-15',
  },
  {
    id: 'g15', name: 'Fitness Band', brand: 'Mi', category: 'Health', points: 2_800,
    emoji: '💪', gradientFrom: '#0891b2', gradientTo: '#22d3ee', imageDataUrl: null,
    description: 'Smart fitness band with health & activity tracking',
    details: 'Mi Smart Band tracks steps, calories, heart rate, sleep, and SpO2. 14-day battery life and 5ATM water resistance make it the perfect all-day companion.',
    features: ['14-day battery life', 'Heart rate & SpO2 monitor', '5ATM water resistant', 'Step & calorie tracking', 'Sleep quality analysis'],
    available: true, popular: false, addedDate: '2025-12-05',
  },
  {
    id: 'g16', name: 'Blood Pressure Monitor', brand: 'Omron', category: 'Health', points: 3_500,
    emoji: '🩺', gradientFrom: '#0f766e', gradientTo: '#2dd4bf', imageDataUrl: null,
    description: 'Clinically validated digital BP monitor',
    details: 'Omron HEM-7120 upper arm blood pressure monitor is clinically validated and WHO recommended. Stores up to 60 readings and detects irregular heartbeat automatically.',
    features: ['Clinically validated & WHO recommended', '60-reading memory', 'Irregular heartbeat detection', 'Easy-to-read large display', '5-year warranty'],
    available: true, popular: false, addedDate: '2025-12-05',
  },
];

/** Load gifts from localStorage, falling back to the default catalogue. */
export function loadGifts(): GiftCatalogueItem[] {
  if (typeof window === 'undefined') return GIFT_CATALOGUE;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as GiftCatalogueItem[];
  } catch { /* ignore parse errors */ }
  return GIFT_CATALOGUE;
}

/** Persist gifts to localStorage so partner view stays in sync. */
export function saveGifts(gifts: GiftCatalogueItem[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(gifts));
  } catch { /* ignore quota errors */ }
}
