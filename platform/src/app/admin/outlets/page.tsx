// This route is an orphan — nothing in the app navigates here.
// The live outlet page lives at /admin/users/outlets.
// Redirect any direct visit there to avoid confusion.
import { redirect } from 'next/navigation';

export default function OutletsOrphanRedirect() {
  redirect('/admin/users/outlets');
}
