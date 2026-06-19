import { auth } from '@/lib/auth';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { booking as bookingTable, bookingAttendee as bookingAttendeeTable, user as userTable } from '@/lib/db/schema';
import { and, eq, isNull, or } from 'drizzle-orm';
import { confirmInternalAction, cancelInternalAction } from './_actions';

export default async function MeetingDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string>>;
}) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');

  const { id: bookingId } = await params;
  const sp = await searchParams;
  const error = sp.error ? decodeURIComponent(sp.error) : undefined;

  const userId = session!.user.id;

  // Fetch the booking (must be an internal meeting)
  const bookingRow = db.select().from(bookingTable)
    .where(and(eq(bookingTable.id, bookingId), isNull(bookingTable.bookingPageId)))
    .get();

  if (!bookingRow) {
    return (
      <main style={{ padding: '2rem', maxWidth: 600, margin: '0 auto' }}>
        <h1>Meeting not found</h1>
        <p><a href="/meetings" style={{ color: '#2563eb' }}>← Meetings</a></p>
      </main>
    );
  }

  const isOrganizer = bookingRow.organizerUserId === userId;

  // Check if user is an attendee
  const isAttendee = !isOrganizer && !!db.select({ id: bookingAttendeeTable.id })
    .from(bookingAttendeeTable)
    .where(and(eq(bookingAttendeeTable.bookingId, bookingId), eq(bookingAttendeeTable.userId, userId)))
    .get();

  // If neither organizer nor attendee: deny access
  if (!isOrganizer && !isAttendee) {
    return (
      <main style={{ padding: '2rem', maxWidth: 600, margin: '0 auto' }}>
        <h1>Access denied</h1>
        <p>You are not a participant in this meeting.</p>
        <p><a href="/meetings" style={{ color: '#2563eb' }}>← Meetings</a></p>
      </main>
    );
  }

  // Fetch attendees with user info
  const attendeeRows = db.select({
    userId:       bookingAttendeeTable.userId,
    inviteStatus: bookingAttendeeTable.inviteStatus,
    emailFailed:  bookingAttendeeTable.emailFailed,
    name:         userTable.name,
    email:        userTable.email,
  })
    .from(bookingAttendeeTable)
    .innerJoin(userTable, eq(bookingAttendeeTable.userId, userTable.id))
    .where(eq(bookingAttendeeTable.bookingId, bookingId))
    .all();

  const organizer = db.select({ name: userTable.name, email: userTable.email })
    .from(userTable)
    .where(eq(userTable.id, bookingRow.organizerUserId))
    .get();

  const now = new Date();
  const expired = bookingRow.status === 'pending_hold' && bookingRow.expiresAt && bookingRow.expiresAt <= now;

  const statusColor = bookingRow.status === 'confirmed' ? '#15803d'
    : bookingRow.status === 'cancelled' ? '#b91c1c'
    : expired ? '#b45309' : '#2563eb';
  const statusLabel = bookingRow.status === 'confirmed' ? 'Confirmed'
    : bookingRow.status === 'cancelled' ? 'Cancelled'
    : expired ? 'Hold expired' : 'Pending confirmation';

  return (
    <main style={{ padding: '2rem', maxWidth: 650, margin: '0 auto' }}>
      <p style={{ marginBottom: '0.5rem' }}>
        <a href="/meetings" style={{ color: '#6b7280' }}>← Meetings</a>
      </p>

      <h1 style={{ marginBottom: '0.25rem' }}>{bookingRow.title ?? '(untitled meeting)'}</h1>
      <p style={{ color: statusColor, fontWeight: 600, marginBottom: '1.5rem' }}>{statusLabel}</p>

      {error && (
        <p style={{ background: '#fee2e2', color: '#b91c1c', padding: '0.75rem', borderRadius: 6, marginBottom: '1rem' }}>
          {error}
        </p>
      )}

      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '1.5rem' }}>
        <tbody>
          {[
            ['When (UTC)', bookingRow.startUtc
              ? `${bookingRow.startUtc.toUTCString()} – ${bookingRow.endUtc?.toISOString().slice(11, 16)}`
              : '—'],
            ['Organizer', organizer ? `${organizer.name ?? ''} <${organizer.email}>` : bookingRow.organizerUserId],
          ].map(([label, value]) => (
            <tr key={label} style={{ borderBottom: '1px solid #f3f4f6' }}>
              <th style={{ textAlign: 'left', padding: '0.5rem 1rem 0.5rem 0', width: 140, color: '#6b7280', fontWeight: 500 }}>
                {label}
              </th>
              <td style={{ padding: '0.5rem 0' }}>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ fontSize: '1rem', marginBottom: '0.75rem' }}>Attendees</h2>
      {attendeeRows.length === 0 ? (
        <p style={{ color: '#6b7280', marginBottom: '1.5rem' }}>No attendees recorded.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '1.5rem' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
              <th style={{ textAlign: 'left', padding: '0.4rem 0.75rem' }}>Name</th>
              <th style={{ textAlign: 'left', padding: '0.4rem 0.75rem' }}>Email</th>
              <th style={{ textAlign: 'left', padding: '0.4rem 0.75rem' }}>Invite status</th>
            </tr>
          </thead>
          <tbody>
            {attendeeRows.map(a => (
              <tr key={a.userId} style={{ borderBottom: '1px solid #f3f4f6' }}>
                <td style={{ padding: '0.4rem 0.75rem' }}>{a.name ?? '—'}</td>
                <td style={{ padding: '0.4rem 0.75rem' }}>{a.email}</td>
                <td style={{ padding: '0.4rem 0.75rem' }}>
                  {a.inviteStatus}
                  {a.emailFailed && ' ⚠️ email failed'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Organizer-only actions */}
      {isOrganizer && !expired && bookingRow.status === 'pending_hold' && (
        <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
          <form action={confirmInternalAction}>
            <input type="hidden" name="bookingId" value={bookingId} />
            <button type="submit"
              style={{ background: '#16a34a', color: '#fff', padding: '0.5rem 1.25rem', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
              Confirm &amp; send invites
            </button>
          </form>
          <form action={cancelInternalAction}>
            <input type="hidden" name="bookingId" value={bookingId} />
            <button type="submit"
              style={{ background: '#dc2626', color: '#fff', padding: '0.5rem 1.25rem', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
              Cancel
            </button>
          </form>
        </div>
      )}

      {isOrganizer && bookingRow.status === 'confirmed' && (
        <form action={cancelInternalAction} style={{ marginTop: '1rem' }}>
          <input type="hidden" name="bookingId" value={bookingId} />
          <button type="submit"
            style={{ background: '#dc2626', color: '#fff', padding: '0.5rem 1.25rem', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
            Cancel meeting
          </button>
        </form>
      )}

      {isAttendee && (
        <p style={{ marginTop: '1rem', color: '#6b7280', fontSize: '0.9rem' }}>
          You are an attendee. Contact the organizer to cancel or reschedule.
        </p>
      )}
    </main>
  );
}
