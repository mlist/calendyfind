import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { headers } from 'next/headers';
import { and, eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { bookingPage, booking, writeTarget } from '@/lib/db/schema';
import { parseDurationOptions } from '@/lib/booking/holds';
import { updatePageAction, toggleActiveAction, rotateTokenAction, deletePageAction, ownerCancelBookingAction } from '../_actions';

export default async function BookingPageDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');

  const { id } = await params;
  const sp = await searchParams;

  const page = db.select().from(bookingPage)
    .where(and(eq(bookingPage.id, id), eq(bookingPage.userId, session.user.id)))
    .get();
  if (!page) notFound();

  const myTargets = db.select().from(writeTarget)
    .where(eq(writeTarget.userId, session.user.id))
    .all();

  const upcoming = db.select().from(booking)
    .where(and(eq(booking.bookingPageId, id), eq(booking.status, 'confirmed')))
    .all()
    .sort((a, b) => (a.startUtc?.getTime() ?? 0) - (b.startUtc?.getTime() ?? 0))
    .slice(0, 20);

  const appUrl = process.env.BETTER_AUTH_URL ?? 'http://localhost:3000';
  const publicUrl = `${appUrl}/b/${page.secretToken}`;

  return (
    <main style={{ maxWidth: 700, margin: '2rem auto', padding: '0 1rem', fontFamily: 'system-ui' }}>
      <Link href="/settings/booking-pages">← All pages</Link>
      <h1>{page.title}</h1>

      {sp.error && <p style={{ color: 'crimson' }}>{decodeURIComponent(sp.error)}</p>}
      {sp.success && <p style={{ color: 'green' }}>{decodeURIComponent(sp.success)}</p>}

      <p>
        <strong>Public link:</strong>{' '}
        {page.active ? (
          <a href={publicUrl} target="_blank" rel="noopener">{publicUrl}</a>
        ) : '(inactive — activate to share)'}
      </p>

      {/* Quick controls */}
      <form action={toggleActiveAction} style={{ display: 'inline' }}>
        <input type="hidden" name="id" value={page.id} />
        <input type="hidden" name="active" value={page.active ? '0' : '1'} />
        <button type="submit">{page.active ? 'Deactivate' : 'Activate'}</button>
      </form>
      {' '}
      {/* Rotate link — confirm-before-rotate: show the danger form inside a <details> */}
      <details style={{ display: 'inline-block', verticalAlign: 'middle' }}>
        <summary style={{ cursor: 'pointer', color: '#dc2626', fontSize: 14 }}>Rotate link…</summary>
        <div style={{ marginTop: '0.5rem', padding: '0.75rem', background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 4, maxWidth: 380 }}>
          <p style={{ margin: '0 0 0.5rem', fontWeight: 600, color: '#dc2626' }}>⚠ The current link will stop working immediately.</p>
          <p style={{ margin: '0 0 0.75rem', fontSize: 13, color: '#6b7280' }}>
            Anyone with the old link will get "not available". You will need to re-share the new link.
            {page.tokenRotatedAt && (
              <> Last rotated: {page.tokenRotatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC.</>
            )}
          </p>
          <form action={rotateTokenAction}>
            <input type="hidden" name="id" value={page.id} />
            <button type="submit" style={{ padding: '6px 14px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>
              Yes, rotate the link
            </button>
          </form>
        </div>
      </details>

      <hr />
      <h2>Edit</h2>
      <form action={updatePageAction} style={{ display: 'grid', gap: '0.75rem', maxWidth: 400 }}>
        <input type="hidden" name="id" value={page.id} />
        <label>Title<br /><input name="title" defaultValue={page.title} required style={{ width: '100%' }} /></label>
        <label>Duration options (min, comma-separated)<br />
          <input
            name="durationOptions"
            defaultValue={parseDurationOptions(page.durationOptions).join(', ')}
            placeholder="e.g. 30, 60, 90"
            required
            style={{ width: '100%' }}
          />
        </label>
        <label>Buffer (min)<br /><input name="bufferMin" type="number" defaultValue={page.bufferMin} min={0} max={120} style={{ width: '100%' }} /></label>
        <label>Min notice (min)<br /><input name="minNoticeMin" type="number" defaultValue={page.minNoticeMin} min={0} style={{ width: '100%' }} /></label>
        <label>Max advance (days)<br /><input name="maxAdvanceDays" type="number" defaultValue={page.maxAdvanceDays} min={1} style={{ width: '100%' }} /></label>
        <label>Location<br /><input name="location" defaultValue={page.location ?? ''} style={{ width: '100%' }} /></label>
        <label>
          Extra guests (comma-separated emails)
          <br />
          <input
            name="extraGuests"
            defaultValue={page.extraGuests ?? ''}
            placeholder="colleague@example.com, boss@example.com"
            style={{ width: '100%' }}
          />
          <span style={{ fontSize: 12, color: '#6b7280' }}>
            Added as attendees on every booking on this page.
          </span>
        </label>
        <label>Write target (Phase 4)
          <br />
          <select name="writeTargetId" style={{ width: '100%' }}>
            <option value="">— none —</option>
            {myTargets.map(t => (
              <option key={t.id} value={t.id} selected={t.id === page.writeTargetId}>{t.label}</option>
            ))}
          </select>
        </label>
        <button type="submit">Save</button>
      </form>

      <hr />
      <h2>Upcoming confirmed bookings</h2>
      {upcoming.length === 0 ? <p>None yet.</p> : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #ccc' }}>
              <th style={{ textAlign: 'left', padding: '4px' }}>When (UTC)</th>
              <th style={{ textAlign: 'left', padding: '4px' }}>Guest</th>
              <th style={{ textAlign: 'left', padding: '4px' }}>Topic</th>
              <th style={{ padding: '4px' }} />
            </tr>
          </thead>
          <tbody>
            {upcoming.map(b => (
              <tr key={b.id} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: '4px' }}>{b.startUtc?.toISOString().slice(0, 16).replace('T', ' ')}</td>
                <td style={{ padding: '4px' }}>{b.attendeeName} &lt;{b.attendeeEmail}&gt;</td>
                <td style={{ padding: '4px', color: b.title ? undefined : '#9ca3af', fontSize: 13 }}>{b.title ?? '—'}</td>
                <td style={{ padding: '4px' }}>
                  <form action={ownerCancelBookingAction}>
                    <input type="hidden" name="bookingId" value={b.id} />
                    <input type="hidden" name="pageId" value={id} />
                    <button type="submit" style={{ color: 'crimson', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, padding: 0 }}>
                      Cancel
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <hr />
      <h2>Danger zone</h2>
      <form action={deletePageAction}>
        <input type="hidden" name="id" value={page.id} />
        <input name="confirm" placeholder='Type DELETE to confirm' style={{ marginRight: '0.5rem' }} />
        <button type="submit" style={{ color: 'crimson' }}>Delete page</button>
      </form>
    </main>
  );
}
