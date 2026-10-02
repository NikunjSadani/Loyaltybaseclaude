import { RequireAuth } from '@/components/auth/require-auth';

/**
 * Points Engine sub-tree guard. Authoring is self-serve for GIFSY_ADMIN + CLIENT_ADMIN (design §12 #5);
 * GIFSY_STAFF reach it only while assumed into a granted brand and are gated by the backend permission
 * (points_rules / credits) — the backend is the real control, this is defense-in-depth + a clean redirect.
 */
export default function PointsEngineLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth allowedRoles={['GIFSY_ADMIN', 'CLIENT_ADMIN', 'GIFSY_STAFF']}>{children}</RequireAuth>
  );
}
