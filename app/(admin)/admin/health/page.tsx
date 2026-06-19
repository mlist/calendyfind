import { auth } from '@/lib/auth';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { availabilitySource, booking as bookingTable, user as userTable } from '@/lib/db/schema';
import { and, eq, gt, isNotNull, isNull, ne } from 'drizzle-orm';
import { DateTime } from 'luxon';

const cell: React.CSSProperties = { padding: '8px 12px', borderBottom: '1px solid #e5e7eb', verticalAlign: 'top', fontSize: 13 };
const head: React.CSSProperties = { ...cell, background: '#f9fafb', fontWeight: 600, borderBottom: '2px solid #e5e7eb' };

export default async function AdminHealthPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (session?.user.role !== 'admin') redirect('/login');

  const now = new Date();
  const staleThreshold = new Date(now.getTime() - 60 * 60_000); // > 1h ago = stale

  const sources = db
    .select({
      id: availabilitySource.id,
      label: availabilitySource.label,
      icsUrl: availabilitySource.icsUrl,
      lastFetchedAt: availabilitySource.lastFetchedAt,
      fetchError: availabilitySource.fetchError,
      ownerEmail: userTable.email,
      ownerName: userTable.name,
    })
    .from(availabilitySource)
    .leftJoin(userTable, eq(availabilitySource.userId, userTable.id))
    .all();

  const emailFailed = db
    .select({
      id: bookingTable.id,
      attendeeEmail: bookingTable.attendeeEmail,
      attendeeName: bookingTable.attendeeName,
      startUtc: bookingTable.startUtc,
      status: bookingTable.status,
    })
    .from(bookingTable)
    .where(
      and(
        eq(bookingTable.emailFailed, true),
        ne(bookingTable.status, 'cancelled'),
      )
    )
    .all();

  const errored   = sources.filter(s => s.fetchError);
  const stale     = sources.filter(s => !s.fetchError && s.lastFetchedAt && s.lastFetchedAt < staleThreshold);
  const neverFetched = sources.filter(s => !s.lastFetchedAt);
  const healthy   = sources.filter(s => !s.fetchError && s.lastFetchedAt && s.lastFetchedAt >= staleThreshold);

  return (
    <main style={{ padding: '2rem', maxWidth: 960, margin: '0 auto' }}>
      <h1 style={{ marginBottom: '0.25rem' }}>Admin — System Health</h1>
      <p style={{ color: '#6b7280', marginBottom: '1.5rem' }}>
        <a href="/admin" style={{ color: '#2563eb' }}>← Users</a>
        {' · '}
        <a href="/admin/bookings" style={{ color: '#2563eb' }}>Bookings</a>
        {' · '}
        <a href="/admin/audit" style={{ color: '#2563eb' }}>Audit log</a>
      </p>

      <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
        {[
          { label: 'Total sources',  count: sources.length,       color: '#2563eb' },
          { label: 'Healthy',        count: healthy.length,        color: '#16a34a' },
          { label: 'Errored',        count: errored.length,        color: '#dc2626' },
          { label: 'Stale (>1h)',    count: stale.length,          color: '#d97706' },
          { label: 'Never fetched',  count: neverFetched.length,   color: '#6b7280' },
          { label: 'Email failures', count: emailFailed.length,    color: emailFailed.length > 0 ? '#dc2626' : '#16a34a' },
        ].map(s => (
          <div key={s.label} style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: '12px 20px', minWidth: 110, textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 700, color: s.color }}>{s.count}</div>
            <div style={{ fontSize: 12, color: '#6b7280' }}>{s.label}</div>
          </div>
        ))}
      </div>

      <h2 style={{ marginBottom: '0.75rem' }}>Availability Sources</h2>
      <div style={{ overflowX: 'auto', marginBottom: '2rem' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={head}>Label</th>
              <th style={head}>Owner</th>
              <th style={head}>Last fetched</th>
              <th style={head}>Error</th>
            </tr>
          </thead>
          <tbody>
            {sources.map(s => {
              const lastFetched = s.lastFetchedAt
                ? DateTime.fromJSDate(s.lastFetchedAt, { zone: 'UTC' }).toRelative()
                : 'never';
              const rowBg = s.fetchError ? '#fef2f2' : s.lastFetchedAt && s.lastFetchedAt < staleThreshold ? '#fffbeb' : 'transparent';
              return (
                <tr key={s.id} style={{ background: rowBg }}>
                  <td style={cell}>{s.label}</td>
                  <td style={cell}>{s.ownerName ?? s.ownerEmail ?? '—'}</td>
                  <td style={cell}>{lastFetched}</td>
                  <td style={{ ...cell, color: '#dc2626' }}>{s.fetchError ?? ''}</td>
                </tr>
              );
            })}
            {sources.length === 0 && (
              <tr><td colSpan={4} style={{ ...cell, color: '#6b7280', textAlign: 'center' }}>No sources configured.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {emailFailed.length > 0 && (
        <>
          <h2 style={{ marginBottom: '0.75rem', color: '#dc2626' }}>Email Failures ({emailFailed.length})</h2>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={head}>Booking ID</th>
                  <th style={head}>Attendee</th>
                  <th style={head}>Meeting</th>
                  <th style={head}>Status</th>
                </tr>
              </thead>
              <tbody>
                {emailFailed.map(b => (
                  <tr key={b.id}>
                    <td style={{ ...cell, fontFamily: 'monospace', fontSize: 11 }}>{b.id}</td>
                    <td style={cell}>{b.attendeeName}<br /><span style={{ color: '#6b7280', fontSize: 12 }}>{b.attendeeEmail}</span></td>
                    <td style={cell}>{b.startUtc ? DateTime.fromJSDate(b.startUtc, { zone: 'UTC' }).toFormat('yyyy-MM-dd HH:mm') : '—'}</td>
                    <td style={cell}>{b.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}
