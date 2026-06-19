'use client';
import { useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth/client';

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      onClick={async () => {
        await authClient.signOut();
        router.push('/login');
      }}
      style={{
        marginTop: '1.5rem',
        padding: '8px 16px',
        background: '#f3f4f6',
        border: '1px solid #d1d5db',
        borderRadius: 4,
      }}
    >
      Sign out
    </button>
  );
}
