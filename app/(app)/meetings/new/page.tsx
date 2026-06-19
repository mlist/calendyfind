import { auth } from '@/lib/auth';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { user as userTable, writeTarget as writeTargetTable } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { getFreeSlots } from '@/lib/availability';
import { holdInternalAction } from './_actions';

function isoToMs(s: string): number | null {
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.getTime();
}

export default async function NewMeetingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[]>>;
}) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');

  const sp = await searchParams;
  const organizerUserId = session!.user.id;

  // All users other than organizer (potential attendees)
  const allUsers = db.select().from(userTable).all().filter(u => u.id !== organizerUserId);
  // Organizer's write targets
  const targets = db.select().from(writeTargetTable)
    .where(eq(writeTargetTable.userId, organizerUserId))
    .all();

  const error = typeof sp.error === 'string' ? sp.error : undefined;

  // Parse search params for slot computation
  const rawAttendeeIds = Array.isArray(sp.attendeeId) ? sp.attendeeId : sp.attendeeId ? [sp.attendeeId] : [];
  const durationMin    = sp.durationMin ? Number(sp.durationMin) : 30;
  const fromStr        = typeof sp.from === 'string' ? sp.from : '';
  const toStr          = typeof sp.to   === 'string' ? sp.to   : '';

  const showSlots = rawAttendeeIds.length > 0 && fromStr && toStr;

  let slots: { start: Date; end: Date }[] = [];
  let slotError: string | undefined;

  if (showSlots) {
    const fromMs = isoToMs(fromStr);
    const toMs   = isoToMs(toStr);
    if (!fromMs || !toMs || toMs <= fromMs) {
      slotError = 'Invalid date range';
    } else {
      const allUserIds = [organizerUserId, ...rawAttendeeIds];
      const now = new Date();
      try {
        const result = await getFreeSlots({
          userIds:     allUserIds,
          range:       { from: new Date(fromMs), to: new Date(toMs) },
          durationMin: isNaN(durationMin) ? 30 : durationMin,
          bufferMin:   0,
          minNoticeMin: 0,
          now,
        });
        slots = result.slots;
        if (result.errors.length > 0) {
          slotError = `Warning: ${result.errors.length} availability source(s) could not be fetched (treated as busy).`;
        }
      } catch (e) {
        slotError = 'Failed to compute slots: ' + String(e);
      }
    }
  }

  const fmtSlot = (s: Date, e: Date) => {
    const ds = s.toISOString().replace('T', ' ').slice(0, 16);
    const de = e.toISOString().slice(11, 16);
    return `${ds} – ${de} UTC`;
  };

  return (
    <main style={{ padding: '2rem', maxWidth: 700, margin: '0 auto' }}>
      <h1 style={{ marginBottom: '1.5rem' }}>New internal meeting</h1>

      {error && (
        <p style={{ background: '#fee2e2', color: '#b91c1c', padding: '0.75rem', borderRadius: 6, marginBottom: '1rem' }}>
          {decodeURIComponent(error)}
        </p>
      )}

      {/* Step 1: find available slots */}
      <section style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: '1.5rem', marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '1rem', marginBottom: '1rem' }}>Step 1 — Find available slots</h2>
        <form method="GET">
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>Attendees (select one or more)</label>
            {allUsers.length === 0
              ? <p style={{ color: '#6b7280', fontSize: '0.9rem' }}>No other users in the system yet.</p>
              : allUsers.map(u => (
                <label key={u.id} style={{ display: 'block', marginBottom: 4 }}>
                  <input
                    type="checkbox"
                    name="attendeeId"
                    value={u.id}
                    defaultChecked={rawAttendeeIds.includes(u.id)}
                    style={{ marginRight: 8 }}
                  />
                  {u.name ?? u.email} ({u.email})
                </label>
              ))
            }
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
            <div>
              <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>From</label>
              <input type="date" name="from" defaultValue={fromStr.slice(0, 10)}
                style={{ padding: '0.4rem', border: '1px solid #d1d5db', borderRadius: 4, width: '100%' }} />
            </div>
            <div>
              <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>To</label>
              <input type="date" name="to" defaultValue={toStr.slice(0, 10)}
                style={{ padding: '0.4rem', border: '1px solid #d1d5db', borderRadius: 4, width: '100%' }} />
            </div>
            <div>
              <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>Duration (min)</label>
              <input type="number" name="durationMin" defaultValue={durationMin} min={15} step={15}
                style={{ padding: '0.4rem', border: '1px solid #d1d5db', borderRadius: 4, width: '100%' }} />
            </div>
          </div>

          <button type="submit" style={{ background: '#2563eb', color: '#fff', padding: '0.5rem 1.25rem', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
            Find slots
          </button>
        </form>
      </section>

      {/* Step 2: pick a slot and create the hold */}
      {showSlots && (
        <section style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: '1.5rem' }}>
          <h2 style={{ fontSize: '1rem', marginBottom: '1rem' }}>Step 2 — Book a slot</h2>

          {slotError && (
            <p style={{ color: '#b45309', fontSize: '0.9rem', marginBottom: '0.75rem' }}>{slotError}</p>
          )}

          {slots.length === 0 ? (
            <p style={{ color: '#6b7280' }}>No shared slots found in this range. Try a wider date range.</p>
          ) : (
            <>
              <p style={{ fontSize: '0.9rem', color: '#6b7280', marginBottom: '1rem' }}>
                {slots.length} slot(s) available. Enter a title and pick a slot.
              </p>
              {targets.length > 0 && (
                <div style={{ marginBottom: '1rem' }}>
                  <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>Write target (calendar to add the event to)</label>
                  <select name="writeTargetIdGlobal" id="writeTargetIdGlobal"
                    style={{ padding: '0.4rem', border: '1px solid #d1d5db', borderRadius: 4 }}>
                    {targets.map(t => (
                      <option key={t.id} value={t.id} selected={t.isDefault}>
                        {t.label} ({t.provider}){t.isDefault ? ' ★' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div style={{ display: 'grid', gap: '0.5rem' }}>
                {slots.map((slot, i) => (
                  <form key={i} action={holdInternalAction}>
                    <input type="hidden" name="slotStartMs" value={slot.start.getTime()} />
                    <input type="hidden" name="durationMin" value={durationMin} />
                    {rawAttendeeIds.map(id => (
                      <input key={id} type="hidden" name="attendeeId" value={id} />
                    ))}
                    {/* writeTargetId set via client JS from the select above, or left empty for default */}
                    <input type="hidden" name="writeTargetId" id={`wt-${i}`} value="" />
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', background: '#fff', border: '1px solid #d1d5db', borderRadius: 6, padding: '0.75rem' }}>
                      <input
                        type="text"
                        name="title"
                        placeholder="Meeting title"
                        required
                        style={{ flex: 1, padding: '0.4rem', border: '1px solid #d1d5db', borderRadius: 4 }}
                      />
                      <span style={{ whiteSpace: 'nowrap', color: '#374151', minWidth: 260 }}>
                        {fmtSlot(slot.start, slot.end)}
                      </span>
                      <button type="submit"
                        style={{ background: '#16a34a', color: '#fff', padding: '0.4rem 0.75rem', border: 'none', borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                        Book →
                      </button>
                    </div>
                  </form>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      <p style={{ marginTop: '1.5rem' }}>
        <a href="/meetings" style={{ color: '#6b7280' }}>← Meetings</a>
      </p>

      {/* client script to copy write target selection into each hidden input */}
      <script dangerouslySetInnerHTML={{ __html: `
        document.addEventListener('change', function(e) {
          if (e.target.id === 'writeTargetIdGlobal') {
            document.querySelectorAll('[id^="wt-"]').forEach(function(el) {
              el.value = e.target.value;
            });
          }
        });
      `}} />
    </main>
  );
}
