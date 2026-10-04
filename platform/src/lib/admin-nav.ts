/* ─── Admin navigation model + capability-gated selector ──────────────────────
   Employee Rewards Phase 0 — the admin shell renders ONE of two nav trees chosen by
   the tenant's resolved `earnerModel` (from loyaltyType): the existing TRADE tree for
   OUTLET tenants (Deoleo), the new EMPLOYEE tree for EMPLOYEE_REWARDS tenants (Britannia).
   Within the chosen tree, the existing role/feature/visibility gates still apply.

   Extracted from app/admin/layout.tsx into a PURE module so the gating is unit-testable
   (lib/__tests__/admin-nav.test.ts). The layout imports `selectAdminNav` and renders the
   result — the presentation is unchanged. For a TRADE tenant the output is byte-identical
   to the pre-refactor inline filter (same TRADE_NAV_ITEMS, same gates). ───────────────── */

import {
  LayoutDashboard, FileCheck, Users, Tag, Eye, CreditCard, BarChart2, FileBarChart2,
  Settings, Wallet, Megaphone, TicketCheck, Target, Gift, ShoppingBag,
  TrendingUp, Coins, Landmark, Smartphone, BookOpen, MessageSquare, Truck, Store, Send,
  Calculator, Trophy, type LucideIcon,
} from 'lucide-react';
import type { Capabilities } from '@/lib/tenant-features';

export interface AdminNavChild {
  href: string;
  label: string;
  gifsyOnly?: boolean;
}

export interface AdminNavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** clients.features flag that must be truthy for this item to show (null = always). */
  featureFlag?: string | null;
  gifsyOnly?: boolean;          // hidden from CLIENT_ADMIN (shown to canManageSchemes)
  gifsyAdminOnly?: boolean;     // GIFSY_ADMIN only
  giftDisbursal?: boolean;      // GIFSY_ADMIN + CLIENT_ADMIN
  deliveryReport?: boolean;     // GIFSY_ADMIN + CLIENT_ADMIN
  tenantReportOnly?: boolean;   // hidden from canManageSchemes (tenant admins only)
  children?: AdminNavChild[];
}

export interface AdminNavContext {
  capabilities: Capabilities;
  role: string;
  canManageSchemes: boolean;
  visibilityEnabled: boolean;
  /** normalized clients.features (for featureFlag gating). */
  features: Record<string, boolean>;
}

/* ─── TRADE tree (OUTLET earner) — moved verbatim from layout's ALL_NAV_ITEMS. ─── */
export const TRADE_NAV_ITEMS: AdminNavItem[] = [
  { href: '/admin/dashboard', label: 'Overview', icon: LayoutDashboard, featureFlag: null },
  {
    href: '/admin/dashboards', label: 'Dashboards', icon: BarChart2, featureFlag: null,
    children: [
      { href: '/admin/dashboards/kyc',            label: 'KYC Dashboard'       },
      { href: '/admin/dashboards/program-health', label: 'Program Health'      },
      { href: '/admin/dashboards/operations',     label: 'Operations'          },
      { href: '/admin/dashboards/finance',        label: 'Finance & Liability' },
    ],
  },
  {
    href: '/admin/kyc', label: 'KYC Management', icon: FileCheck, featureFlag: 'kycApprovalFlow',
    children: [
      { href: '/admin/kyc',            label: 'KYC Submissions'  },
      { href: '/admin/kyc/approvals',  label: 'KYC Approvals' },
    ],
  },
  {
    href: '/admin/users', label: 'User Management', icon: Users, featureFlag: null,
    children: [
      { href: '/admin/users/outlets', label: 'Outlet Management'   },
      { href: '/admin/users/parents', label: 'Owner Groups'        },
      { href: '/admin/hierarchy',     label: 'Employee Hierarchy'  },
      { href: '/admin/users',         label: 'User Accounts'       },
    ],
  },
  { href: '/admin/schemes',  label: 'Scheme Management', icon: Tag, featureFlag: null, gifsyOnly: true },
  { href: '/admin/outlet-wallet', label: 'Outlet Wallet', icon: Wallet, featureFlag: null, gifsyOnly: true },
  { href: '/admin/scheme-reports', label: 'Scheme Reports', icon: FileBarChart2, featureFlag: null, tenantReportOnly: true },
  { href: '/admin/visibility', label: 'Visibility (POSM)', icon: Eye, featureFlag: null, gifsyOnly: true },
  { href: '/admin/visibility-reports', label: 'Visibility Reports', icon: FileBarChart2, featureFlag: null, tenantReportOnly: true },
  {
    href: '/admin/invoices', label: 'Visibility Invoices', icon: FileCheck, featureFlag: 'visibilityInvoiceModule',
    children: [
      { href: '/admin/invoices',        label: 'Invoice List'    },
      { href: '/admin/invoices/upload', label: 'Upload Payouts'  },
    ],
  },
  {
    href: '/admin/payouts', label: 'Payout Management', icon: CreditCard, featureFlag: 'walletModule', gifsyOnly: true,
    children: [
      { href: '/admin/payouts',      label: 'Payout Batches'  },
      { href: '/admin/payouts/fund', label: 'Fund Management' },
    ],
  },
  { href: '/admin/gifts',    label: 'Gift Catalogue',  icon: Gift, featureFlag: 'walletModule' },
  { href: '/admin/gift-catalogue', label: 'Gift Master Catalogue', icon: ShoppingBag, featureFlag: null, gifsyAdminOnly: true },
  { href: process.env.NEXT_PUBLIC_EXCEL_TARGETS_ONLY === 'true' ? '/admin/targets/upload' : '/admin/targets', label: 'Targets', icon: Target, featureFlag: null },
  { href: '/admin/sales',    label: 'Sales Data',       icon: TrendingUp, featureFlag: null },
  {
    href: '/admin/credits-payouts', label: 'Credits & Payouts', icon: Coins, featureFlag: null,
    children: [
      { href: '/admin/credits-payouts/upload',   label: 'Upload Credits'    },
      { href: '/admin/credits-payouts/status',   label: 'Payout Status'     },
      { href: '/admin/credits-payouts/payments', label: 'Payments Report'   },
      { href: '/admin/credits-payouts/payout',   label: 'Payout Download', gifsyOnly: true },
      { href: '/admin/credits-payouts/fields',   label: 'Field Configuration' },
    ],
  },
  {
    href: '/admin/points-engine/rules', label: 'Points Engine', icon: Calculator, featureFlag: null, gifsyAdminOnly: true,
    children: [
      { href: '/admin/points-engine/rules',    label: 'Rules'    },
      { href: '/admin/points-engine/compute',  label: 'Compute'  },
      { href: '/admin/points-engine/settings', label: 'Settings' },
    ],
  },
  {
    href: '/admin/tds', label: 'TDS & Invoicing', icon: Landmark, featureFlag: null,
    children: [
      { href: '/admin/tds-config',         label: 'TDS Treatment'       },
      { href: '/admin/tds-payouts',        label: 'Payout Report'       },
      { href: '/admin/tds-recovery',       label: 'Recovery / Attribution' },
      { href: '/admin/tds-rcm',            label: 'RCM (Unregistered)', gifsyOnly: true },
      { href: '/admin/gst-reimbursements', label: 'GST Reimbursements', gifsyOnly: true },
      { href: '/admin/tds',                label: 'TDS Ledger (194R/194C)' },
    ],
  },
  { href: '/admin/tickets',  label: 'Tickets',          icon: TicketCheck,   featureFlag: null },
  { href: '/admin/banners',  label: 'Banners',          icon: Megaphone,     featureFlag: null },
  { href: '/admin/reports',  label: 'Reports',          icon: FileBarChart2, featureFlag: null },
  { href: '/admin/app-adoption', label: 'App Adoption', icon: Smartphone,    featureFlag: null },
  { href: '/admin/guides', label: 'Help & Guides', icon: BookOpen, featureFlag: null, gifsyOnly: true },
  { href: '/admin/whatsapp-broadcasts', label: 'WhatsApp Broadcasts', icon: MessageSquare, featureFlag: null, gifsyAdminOnly: true },
  { href: '/admin/gift-orders', label: 'Gift Dispatch', icon: Truck, featureFlag: null, gifsyAdminOnly: true },
  { href: '/admin/vendors', label: 'Vendors', icon: Store, featureFlag: null, gifsyAdminOnly: true },
  { href: '/admin/gift-disbursal', label: 'Gift Disbursal', icon: FileBarChart2, featureFlag: null, giftDisbursal: true },
  { href: '/admin/notification-delivery', label: 'Delivery Status', icon: Send, featureFlag: null, deliveryReport: true },
  { href: '/admin/settings', label: 'Settings',         icon: Settings,      featureFlag: null },
];

/* ─── EMPLOYEE tree (EMPLOYEE earner) — the curated cockpit (ADMIN-DESIGN §4). ───
   Phase 0 skeleton. People/Points/Contests/Fulfilment/Finance/Insights/Content are new
   stub routes; Rewards reuses the gift catalogue, Vendors + Settings reuse existing routes.
   No KYC/TDS/payouts/GST/invoicing/outlets — those don't exist in this world. ─────────── */
export const EMPLOYEE_NAV_ITEMS: AdminNavItem[] = [
  { href: '/admin/overview',   label: 'Overview',        icon: LayoutDashboard, featureFlag: null },
  { href: '/admin/people',     label: 'People',          icon: Users,         featureFlag: null },
  { href: '/admin/points',     label: 'Points',          icon: Coins,         featureFlag: null },
  { href: '/admin/contests',   label: 'Contests',        icon: Trophy,        featureFlag: null },
  { href: '/admin/gifts',      label: 'Rewards',         icon: Gift,          featureFlag: null },
  { href: '/admin/fulfilment', label: 'Fulfilment',      icon: Truck,         featureFlag: null },
  { href: '/admin/vendors',    label: 'Vendors',         icon: Store,         featureFlag: null, gifsyAdminOnly: true },
  { href: '/admin/liability',  label: 'Finance',         icon: Landmark,      featureFlag: null },
  { href: '/admin/comms',      label: 'Communications',  icon: MessageSquare, featureFlag: null },
  { href: '/admin/insights',   label: 'Insights',        icon: BarChart2,     featureFlag: null },
  { href: '/admin/content',    label: 'Content',         icon: BookOpen,      featureFlag: null },
  { href: '/admin/settings',   label: 'Settings',        icon: Settings,      featureFlag: null },
];

/** Does a top-level item pass the role/feature/visibility gates? (world already chosen.) */
function passesGates(item: AdminNavItem, ctx: AdminNavContext): boolean {
  if (item.gifsyOnly && !ctx.canManageSchemes) return false;
  if (item.gifsyAdminOnly && ctx.role !== 'GIFSY_ADMIN') return false;
  if (item.giftDisbursal && ctx.role !== 'GIFSY_ADMIN' && ctx.role !== 'CLIENT_ADMIN') return false;
  if (item.deliveryReport && ctx.role !== 'GIFSY_ADMIN' && ctx.role !== 'CLIENT_ADMIN') return false;
  if (item.tenantReportOnly && ctx.canManageSchemes) return false;
  // Master Visibility switch (trade-only hrefs; inert for the employee tree).
  if (item.href === '/admin/visibility') return ctx.visibilityEnabled;
  if (item.href === '/admin/visibility-reports') return ctx.visibilityEnabled;
  if (item.href === '/admin/invoices' && !ctx.visibilityEnabled) return false;
  if (!item.featureFlag) return true;
  return !!ctx.features[item.featureFlag];
}

/**
 * The capability-gated admin nav for the current tenant: pick the world's tree by
 * `earnerModel`, then apply the role/feature/visibility gates. Pure — no React, no I/O.
 */
export function selectAdminNav(ctx: AdminNavContext): AdminNavItem[] {
  const base = ctx.capabilities.earnerModel === 'EMPLOYEE' ? EMPLOYEE_NAV_ITEMS : TRADE_NAV_ITEMS;
  return base.filter((item) => passesGates(item, ctx));
}

