import { redirect } from 'next/navigation';
import { DateTime } from 'luxon';
import { db } from '@/lib/db';
import { user as userTable } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { getBookingById, getPageByToken } from '@/lib/booking/holds';
import { confirmAction } from './_actions';

export default async function ConfirmPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string; holdId: string }>;
  searchParams: Promise<{ error?: string; tz?: string }>;
}) {
  const { token, holdId } = await params;
  const sp = await searchParams;

  const page = getPageByToken(db, token);
  if (!page || !page.active) redirect(`/b/${token}`);

  const hold = getBookingById(db, holdId);
  if (!hold || hold.bookingPageId !== page.id || hold.status !== 'pending_hold') {
    redirect(`/b/${token}?error=Reservation+not+found+or+already+used`);
  }

  const now = new Date();
  if (hold.expiresAt && hold.expiresAt <= now) {
    redirect(`/b/${token}?error=Your+reservation+expired.+Please+choose+a+new+slot.`);
  }

  const owner = db.select({ name: userTable.name, email: userTable.email, timezone: userTable.timezone })
    .from(userTable).where(eq(userTable.id, page.userId)).get();
  const ownerTz = owner?.timezone ?? 'UTC';

  // Use visitor's tz if provided and valid
  const requestedTz = sp.tz ?? '';
  const displayTz = (() => {
    if (!requestedTz) return ownerTz;
    try {
      const dt = DateTime.now().setZone(requestedTz);
      return dt.isValid ? requestedTz : ownerTz;
    } catch { return ownerTz; }
  })();

  const startLocal = DateTime.fromJSDate(hold.startUtc!, { zone: 'UTC' }).setZone(displayTz);
  const endLocal   = DateTime.fromJSDate(hold.endUtc!,   { zone: 'UTC' }).setZone(displayTz);

  const expiresIn = hold.expiresAt
    ? Math.max(0, Math.round((hold.expiresAt.getTime() - now.getTime()) / 60_000))
    : null;

  const tzLabel = (() => {
    try {
      const offset = DateTime.now().setZone(displayTz).toFormat('ZZ');
      return `${displayTz} (UTC${offset})`;
    } catch { return displayTz; }
  })();

  const confirmWithParams = confirmAction.bind(null, token, holdId, requestedTz);

  return (
    <main style={{ maxWidth: 500, margin: '3rem auto', padding: '0 1rem', fontFamily: 'system-ui' }}>
      <h1>Confirm your booking</h1>

      {sp.error && <p style={{ color: 'crimson' }}>{decodeURIComponent(sp.error)}</p>}

      <table style={{ width: '100%', marginBottom: '1.5rem', borderCollapse: 'collapse' }}>
        <tbody>
          <tr><td style={{ padding: '6px', color: '#555' }}>Event</td><td style={{ padding: '6px' }}><strong>{page.title}</strong></td></tr>
          <tr><td style={{ padding: '6px', color: '#555' }}>Date</td><td style={{ padding: '6px' }}>{startLocal.toFormat('cccc, LLLL d, yyyy')}</td></tr>
          <tr><td style={{ padding: '6px', color: '#555' }}>Time</td><td style={{ padding: '6px' }}>{startLocal.toFormat('h:mm a')} – {endLocal.toFormat('h:mm a')} <span style={{ color: '#6b7280', fontSize: 12 }}>({tzLabel})</span></td></tr>
          {page.location && <tr><td style={{ padding: '6px', color: '#555' }}>Location</td><td style={{ padding: '6px' }}>{page.location}</td></tr>}
          <tr><td style={{ padding: '6px', color: '#555' }}>Your name</td><td style={{ padding: '6px' }}>{hold.attendeeName}</td></tr>
          <tr><td style={{ padding: '6px', color: '#555' }}>Your email</td><td style={{ padding: '6px' }}>{hold.attendeeEmail}</td></tr>
        </tbody>
      </table>

      {expiresIn !== null && (
        <p style={{ color: '#888', fontSize: '0.9em' }}>
          This reservation expires in ~{expiresIn} minute{expiresIn !== 1 ? 's' : ''}.
        </p>
      )}

      <form action={confirmWithParams}>
        <button type="submit" style={{ padding: '0.7rem 2rem', fontSize: '1rem', background: '#0070f3', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
          Confirm booking
        </button>
      </form>
      <p style={{ marginTop: '1rem' }}>
        <a href={`/b/${token}`}>← Choose a different time</a>
      </p>
    </main>
  );
}
