import { redirect } from 'next/navigation';
import { DateTime } from 'luxon';
import { db } from '@/lib/db';
import { user as userTable } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { getBookingById, getPageByToken } from '@/lib/booking/holds';

export default async function SuccessPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string; bookingId: string }>;
  searchParams: Promise<{ tz?: string }>;
}) {
  const { token, bookingId } = await params;
  const sp = await searchParams;

  const page = getPageByToken(db, token);
  if (!page) redirect(`/b/${token}`);

  const bk = getBookingById(db, bookingId);
  if (!bk || bk.bookingPageId !== page!.id || bk.status !== 'confirmed') {
    redirect(`/b/${token}?error=Booking+not+found`);
  }

  const owner = db.select({ name: userTable.name, email: userTable.email, timezone: userTable.timezone })
    .from(userTable).where(eq(userTable.id, page!.userId)).get();
  const ownerTz = owner?.timezone ?? 'UTC';

  const requestedTz = sp.tz ?? '';
  const displayTz = (() => {
    if (!requestedTz) return ownerTz;
    try {
      const dt = DateTime.now().setZone(requestedTz);
      return dt.isValid ? requestedTz : ownerTz;
    } catch { return ownerTz; }
  })();

  const startLocal = DateTime.fromJSDate(bk.startUtc!, { zone: 'UTC' }).setZone(displayTz);
  const endLocal   = DateTime.fromJSDate(bk.endUtc!,   { zone: 'UTC' }).setZone(displayTz);

  const tzLabel = (() => {
    try {
      const offset = DateTime.now().setZone(displayTz).toFormat('ZZ');
      return `${displayTz} (UTC${offset})`;
    } catch { return displayTz; }
  })();

  const appUrl = process.env.BETTER_AUTH_URL ?? 'http://localhost:3000';

  return (
    <main style={{ maxWidth: 500, margin: '3rem auto', padding: '0 1rem', fontFamily: 'system-ui', textAlign: 'center' }}>
      <h1>✓ Booking confirmed!</h1>

      <table style={{ width: '100%', marginBottom: '1.5rem', borderCollapse: 'collapse', textAlign: 'left' }}>
        <tbody>
          <tr><td style={{ padding: '6px', color: '#555' }}>Event</td><td style={{ padding: '6px' }}><strong>{page!.title}</strong></td></tr>
          <tr><td style={{ padding: '6px', color: '#555' }}>Date</td><td style={{ padding: '6px' }}>{startLocal.toFormat('cccc, LLLL d, yyyy')}</td></tr>
          <tr>
            <td style={{ padding: '6px', color: '#555' }}>Time</td>
            <td style={{ padding: '6px' }}>
              {startLocal.toFormat('h:mm a')} – {endLocal.toFormat('h:mm a')}
              <span style={{ color: '#6b7280', fontSize: 12, display: 'block' }}>{tzLabel}</span>
            </td>
          </tr>
          {page!.location && <tr><td style={{ padding: '6px', color: '#555' }}>Location</td><td style={{ padding: '6px' }}>{page!.location}</td></tr>}
        </tbody>
      </table>

      <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center', flexWrap: 'wrap' }}>
        <a href={`${appUrl}/b/ics/${bk.cancelToken}`}
          style={{ padding: '0.6rem 1.2rem', background: '#0070f3', color: '#fff', textDecoration: 'none', borderRadius: 4 }}>
          Download .ics
        </a>
        <a href={`${appUrl}/b/cancel/${bk.cancelToken}`}
          style={{ padding: '0.6rem 1.2rem', background: '#f0f0f0', color: '#333', textDecoration: 'none', borderRadius: 4 }}>
          Cancel booking
        </a>
      </div>
    </main>
  );
}
