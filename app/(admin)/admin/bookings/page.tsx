import { auth } from '@/lib/auth';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { booking as bookingTable, bookingPage as bookingPageTable, user as userTable } from '@/lib/db/schema';
import { desc, eq } from 'drizzle-orm';
import { DateTime } from 'luxon';

const cell: React.CSSProperties = { padding: '8px 12px', borderBottom: '1px solid #e5e7eb', verticalAlign: 'top', fontSize: 13 };
const head: React.CSSProperties = { ...cell, background: '#f9fafb', fontWeight: 600, borderBottom: '2px solid #e5e7eb' };

export default async function AdminBookingsPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (session?.user.role !== 'admin') redirect('/login');

  const rows = db
    .select({
      id: bookingTable.id,
      status: bookingTable.status,
      startUtc: bookingTable.startUtc,
      endUtc: bookingTable.endUtc,
      attendeeEmail: bookingTable.attendeeEmail,
      attendeeName: bookingTable.attendeeName,
      emailFailed: bookingTable.emailFailed,
      createdAt: bookingTable.createdAt,
      pageTitle: bookingPageTable.title,
      organizerName: userTable.name,
      organizerEmail: userTable.email,
    })
    .from(bookingTable)
    .leftJoin(bookingPageTable, eq(bookingTable.bookingPageId, bookingPageTable.id))
    .leftJoin(userTable, eq(bookingTable.organizerUserId, userTable.id))
    .orderBy(desc(bookingTable.createdAt))
    .limit(200)
    .all();

  return (
    <main style={{ padding: '2rem', maxWidth: 1100, margin: '0 auto' }}>
      <h1 style={{ marginBottom: '0.25rem' }}>Admin — Recent Bookings</h1>
      <p style={{ color: '#6b7280', marginBottom: '1.5rem' }}>
        <a href="/admin" style={{ color: '#2563eb' }}>← Users</a>
        {' · '}
        <a href="/admin/health" style={{ color: '#2563eb' }}>Health</a>
        {' · '}
        <a href="/admin/audit" style={{ color: '#2563eb' }}>Audit log</a>
      </p>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={head}>When (UTC)</th>
              <th style={head}>Status</th>
              <th style={head}>Page / Type</th>
              <th style={head}>Organizer</th>
              <th style={head}>Attendee</th>
              <th style={head}>Email</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const startStr = r.startUtc
                ? DateTime.fromJSDate(r.startUtc, { zone: 'UTC' }).toFormat('yyyy-MM-dd HH:mm')
                : '—';
              const statusColor = r.status === 'confirmed' ? '#16a34a' : r.status === 'cancelled' ? '#dc2626' : '#d97706';
              return (
                <tr key={r.id}>
                  <td style={cell}>{startStr}</td>
                  <td style={{ ...cell, color: statusColor, fontWeight: 600 }}>{r.status}</td>
                  <td style={cell}>{r.pageTitle ?? <em>internal</em>}</td>
                  <td style={cell}>{r.organizerName ?? r.organizerEmail ?? '—'}</td>
                  <td style={cell}>{r.attendeeName}<br /><span style={{ color: '#6b7280', fontSize: 12 }}>{r.attendeeEmail}</span></td>
                  <td style={cell}>{r.emailFailed ? <span style={{ color: '#dc2626' }}>failed</span> : <span style={{ color: '#16a34a' }}>ok</span>}</td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={6} style={{ ...cell, color: '#6b7280', textAlign: 'center' }}>No bookings yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
