import { redirect } from 'next/navigation';
import Link from 'next/link';
import { headers } from 'next/headers';
import { eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { bookingPage } from '@/lib/db/schema';
import { parseDurationOptions } from '@/lib/booking/holds';
import { createPageAction } from './_actions';

export default async function BookingPagesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');

  const sp = await searchParams;
  const pages = db.select().from(bookingPage)
    .where(eq(bookingPage.userId, session.user.id))
    .all();

  const appUrl = process.env.BETTER_AUTH_URL ?? 'http://localhost:3000';

  return (
    <main style={{ maxWidth: 800, margin: '2rem auto', padding: '0 1rem', fontFamily: 'system-ui' }}>
      <Link href="/dashboard">← Dashboard</Link>
      <h1>Booking Pages</h1>

      {sp.error && <p style={{ color: 'crimson' }}>{decodeURIComponent(sp.error)}</p>}
      {sp.success && <p style={{ color: 'green' }}>{decodeURIComponent(sp.success)}</p>}

      {pages.length === 0 ? (
        <p>No booking pages yet. Create one below.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '2rem' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #ccc' }}>
              <th style={{ textAlign: 'left', padding: '6px' }}>Title</th>
              <th style={{ textAlign: 'left', padding: '6px' }}>Duration</th>
              <th style={{ textAlign: 'left', padding: '6px' }}>Status</th>
              <th style={{ textAlign: 'left', padding: '6px' }}>Link</th>
            </tr>
          </thead>
          <tbody>
            {pages.map(p => (
              <tr key={p.id} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: '6px' }}>
                  <Link href={`/settings/booking-pages/${p.id}`}>{p.title}</Link>
                </td>
                <td style={{ padding: '6px' }}>{parseDurationOptions(p.durationOptions).join(', ')} min</td>
                <td style={{ padding: '6px' }}>{p.active ? '✓ Active' : '— Inactive'}</td>
                <td style={{ padding: '6px', fontSize: '0.85em', wordBreak: 'break-all' }}>
                  {p.active ? (
                    <a href={`${appUrl}/b/${p.secretToken}`} target="_blank" rel="noopener">
                      {appUrl}/b/{p.secretToken.slice(0, 12)}…
                    </a>
                  ) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Create new page</h2>
      <form action={createPageAction} style={{ display: 'grid', gap: '0.75rem', maxWidth: 400 }}>
        <label>Title<br /><input name="title" required style={{ width: '100%' }} /></label>
        <label>Duration options (min, comma-separated)<br />
          <input name="durationOptions" defaultValue="30" placeholder="e.g. 30, 60, 90" required style={{ width: '100%' }} />
        </label>
        <label>Buffer (min)<br /><input name="bufferMin" type="number" defaultValue={0} min={0} max={120} style={{ width: '100%' }} /></label>
        <label>Min notice (min)<br /><input name="minNoticeMin" type="number" defaultValue={60} min={0} style={{ width: '100%' }} /></label>
        <label>Max advance (days)<br /><input name="maxAdvanceDays" type="number" defaultValue={30} min={1} style={{ width: '100%' }} /></label>
        <label>Location (optional)<br /><input name="location" style={{ width: '100%' }} /></label>
        <button type="submit">Create</button>
      </form>
    </main>
  );
}
