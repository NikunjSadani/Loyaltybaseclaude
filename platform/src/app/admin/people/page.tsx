'use client';

/**
 * Employee Rewards — People (Phase A).
 *
 * The employee cockpit's "People" nav surfaces the roster: the EXISTING employee-hierarchy page,
 * reused AS-IS (design §5.1: reuse, don't rewrite). That page already provides BOTH roster surfaces
 * the design asks for:
 *   • the bulk "Employee Hierarchy" Excel upload (dry-run diff → apply) — /api/admin/hierarchy-config
 *   • per-employee edit by `employeeCode` (search → EditUserModal) — /api/admin/sales-users/*
 *
 * It is rendered via this thin route wrapper (not by pointing the employee nav straight at the
 * trade route /admin/hierarchy) so the employee cockpit keeps its own People URL + route-permission.
 * Nothing in the trade world's /admin/hierarchy page/route is touched.
 *
 * NOTE (tracked for the owner): because the page is reused verbatim it still carries trade-era chrome
 * — a "← back to /admin/dashboard" link and trade sales-role labels (XSR…NSM, "sales team", "has
 * outlets"). An employee-flavoured reskin is deferred pending an owner decision (reskin vs accept for
 * the pilot); it would require editing the shared trade page. The admin-ACCOUNT console (/admin/users)
 * was intentionally NOT included here — it manages admin logins, not reward-earning employees, and
 * belongs under a later Access/Settings surface.
 */

import HierarchyPage from '@/app/admin/hierarchy/page';

export default function PeoplePage() {
  return <HierarchyPage />;
}
