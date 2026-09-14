import { requireSession } from '@/lib/auth/session';
import { CommandMenu } from './_components/command-menu';

// Every screen behind the sign-in verifies the cookie's signature, not just its presence.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireSession();
  return <div className="shell">{children}<CommandMenu /></div>;
}
