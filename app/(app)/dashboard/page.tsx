import { auth } from '@/lib/auth';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { SignOutButton } from './_sign-out';

export default async function DashboardPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');

  const { user } = session;

  return (
    <main style={{ padding: '2rem', maxWidth: 600, margin: '0 auto' }}>
      <h1 style={{ marginBottom: '1.5rem' }}>Dashboard</h1>
      <table
        style={{
          borderCollapse: 'collapse',
          width: '100%',
          marginBottom: '1rem',
        }}
      >
        <tbody>
          {[
            ['Email', user.email],
            ['Name', user.name],
            ['Role', user.role ?? 'user'],
          ].map(([label, value]) => (
            <tr key={label}>
              <th
                style={{
                  textAlign: 'left',
                  padding: '6px 12px 6px 0',
                  fontWeight: 600,
                  width: 100,
                }}
              >
                {label}
              </th>
              <td style={{ padding: '6px 0' }}>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ marginBottom: '0.5rem' }}>
        <a href="/settings" style={{ color: '#2563eb' }}>
          Settings →
        </a>
      </p>
      <p style={{ marginBottom: '0.5rem' }}>
        <a href="/settings/booking-pages" style={{ color: '#2563eb' }}>
          Booking pages →
        </a>
      </p>
      <p style={{ marginBottom: '0.5rem' }}>
        <a href="/meetings" style={{ color: '#2563eb' }}>
          Meetings →
        </a>
      </p>
      {user.role === 'admin' && (
        <p style={{ marginBottom: '0.5rem' }}>
          <a href="/admin" style={{ color: '#2563eb' }}>
            Admin area →
          </a>
        </p>
      )}
      <SignOutButton />
    </main>
  );
}
