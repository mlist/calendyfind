import { auth } from '@/lib/auth';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

export default async function RootPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  redirect(session ? '/dashboard' : '/login');
}
