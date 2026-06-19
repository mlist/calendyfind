import { auth } from '@/lib/auth';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { getOrganizedMeetings, getAttendingMeetings, getAllUsers } from '@/lib/booking/internal';

export default async function MeetingsPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');

  const userId = session.user.id;

  const organized  = getOrganizedMeetings(db, userId);
  const attending  = getAttendingMeetings(db, userId);
  const allUsers   = getAllUsers(db);
  const userMap    = Object.fromEntries(allUsers.map(u => [u.id, u.name ?? u.email]));

  const now = new Date();
  const fmtDate = (d: Date | null) => d ? d.toUTCString() : '—';
  const statusBadge = (status: string) => {
    if (status === 'confirmed')    return '✓ confirmed';
    if (status === 'pending_hold') return '⏳ pending';
    return '✗ cancelled';
  };

  return (
    <main style={{ padding: '2rem', maxWidth: 800, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h1>Meetings</h1>
        <a href="/meetings/new" style={{ background: '#2563eb', color: '#fff', padding: '0.5rem 1rem', borderRadius: 6, textDecoration: 'none' }}>
          + New meeting
        </a>
      </div>

      <h2 style={{ fontSize: '1.1rem', marginBottom: '0.75rem' }}>Organized by you</h2>
      {organized.length === 0 ? (
        <p style={{ color: '#6b7280', marginBottom: '2rem' }}>No meetings yet.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '2rem' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
              <th style={{ textAlign: 'left', padding: '0.5rem 0.75rem' }}>Title</th>
              <th style={{ textAlign: 'left', padding: '0.5rem 0.75rem' }}>When (UTC)</th>
              <th style={{ textAlign: 'left', padding: '0.5rem 0.75rem' }}>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {organized.map(b => (
              <tr key={b.id} style={{ borderBottom: '1px solid #f3f4f6', opacity: b.status === 'cancelled' ? 0.5 : 1 }}>
                <td style={{ padding: '0.5rem 0.75rem' }}>{b.title ?? '(untitled)'}</td>
                <td style={{ padding: '0.5rem 0.75rem' }}>{fmtDate(b.startUtc)} {b.startUtc && b.endUtc && b.startUtc < now && b.endUtc > now ? '(now)' : ''}</td>
                <td style={{ padding: '0.5rem 0.75rem' }}>{statusBadge(b.status)}</td>
                <td style={{ padding: '0.5rem 0.75rem' }}>
                  <a href={`/meetings/${b.id}`} style={{ color: '#2563eb' }}>View →</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 style={{ fontSize: '1.1rem', marginBottom: '0.75rem' }}>Attending</h2>
      {attending.length === 0 ? (
        <p style={{ color: '#6b7280', marginBottom: '2rem' }}>No meetings where you are an attendee.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '2rem' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
              <th style={{ textAlign: 'left', padding: '0.5rem 0.75rem' }}>Title</th>
              <th style={{ textAlign: 'left', padding: '0.5rem 0.75rem' }}>Organizer</th>
              <th style={{ textAlign: 'left', padding: '0.5rem 0.75rem' }}>When (UTC)</th>
              <th style={{ textAlign: 'left', padding: '0.5rem 0.75rem' }}>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {attending.map(b => (
              <tr key={b.id} style={{ borderBottom: '1px solid #f3f4f6', opacity: b.status === 'cancelled' ? 0.5 : 1 }}>
                <td style={{ padding: '0.5rem 0.75rem' }}>{b.title ?? '(untitled)'}</td>
                <td style={{ padding: '0.5rem 0.75rem' }}>{userMap[b.organizerUserId] ?? b.organizerUserId}</td>
                <td style={{ padding: '0.5rem 0.75rem' }}>{fmtDate(b.startUtc)}</td>
                <td style={{ padding: '0.5rem 0.75rem' }}>{statusBadge(b.status)}</td>
                <td style={{ padding: '0.5rem 0.75rem' }}>
                  <a href={`/meetings/${b.id}`} style={{ color: '#2563eb' }}>View →</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p><a href="/dashboard" style={{ color: '#6b7280' }}>← Dashboard</a></p>
    </main>
  );
}
