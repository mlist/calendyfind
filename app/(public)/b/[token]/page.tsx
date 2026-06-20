import { notFound } from 'next/navigation';
import { DateTime } from 'luxon';
import { db } from '@/lib/db';
import { user as userTable } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { getFreeSlots } from '@/lib/availability';
import { getPageByToken, parseDurationOptions } from '@/lib/booking/holds';
import { holdAction } from './_actions';

export default async function PublicBookingPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string; tz?: string; duration?: string }>;
}) {
  const { token } = await params;
  const sp = await searchParams;

  const page = getPageByToken(db, token);
  // Resolve token → page. Show identical "not available" for both missing and inactive.
  if (!page || !page.active) {
    return (
      <main style={{ maxWidth: 500, margin: '4rem auto', padding: '0 1rem', fontFamily: 'system-ui', textAlign: 'center' }}>
        <h1>This booking page is not available.</h1>
        <p>The link may have expired, been revoked, or never existed.</p>
      </main>
    );
  }

  const owner = db.select({ name: userTable.name, timezone: userTable.timezone })
    .from(userTable).where(eq(userTable.id, page.userId)).get();
  const ownerTz = owner?.timezone ?? 'UTC';

  // Use visitor's requested tz if valid; fall back to owner's tz.
  const requestedTz = sp.tz ?? '';
  const displayTz = (() => {
    if (!requestedTz) return ownerTz;
    try {
      const dt = DateTime.now().setZone(requestedTz);
      return dt.isValid ? requestedTz : ownerTz;
    } catch {
      return ownerTz;
    }
  })();

  const durationOptions = parseDurationOptions(page.durationOptions);
  // Use ?duration= from URL, falling back to the first (smallest) option.
  const selectedDuration = (() => {
    const raw = Number(sp.duration);
    return durationOptions.includes(raw) ? raw : durationOptions[0];
  })();

  const now       = new Date();
  const rangeFrom = new Date(now.getTime() + page.minNoticeMin * 60_000);
  const rangeTo   = new Date(now.getTime() + page.maxAdvanceDays * 86_400_000);

  const { slots } = await getFreeSlots({
    userIds: [page.userId],
    range: { from: rangeFrom, to: rangeTo },
    durationMin: selectedDuration,
    bufferMin: page.bufferMin,
    minNoticeMin: page.minNoticeMin,
    now,
  });

  // Group slots by local date (in visitor's display timezone)
  const grouped = new Map<string, typeof slots>();
  for (const slot of slots) {
    const label = DateTime.fromJSDate(slot.start, { zone: 'UTC' }).setZone(displayTz).toFormat('cccc, LLLL d, yyyy');
    const list = grouped.get(label) ?? [];
    list.push(slot);
    grouped.set(label, list);
  }

  const holdWithToken = holdAction.bind(null, token);

  // Friendly timezone label e.g. "Europe/Berlin (UTC+2)"
  const tzLabel = (() => {
    try {
      const offset = DateTime.now().setZone(displayTz).toFormat('ZZ');
      return `${displayTz} (UTC${offset})`;
    } catch {
      return displayTz;
    }
  })();

  return (
    <main style={{ maxWidth: 600, margin: '2rem auto', padding: '0 1rem', fontFamily: 'system-ui' }}>
      <h1>{page.title}</h1>
      {page.location && <p>📍 {page.location}</p>}

      {/* Duration picker — only shown when the page offers multiple options */}
      {durationOptions.length > 1 ? (
        <div style={{ marginBottom: '1rem' }}>
          <span style={{ marginRight: '0.5rem', fontWeight: 500 }}>Duration:</span>
          {durationOptions.map(d => {
            const active = d === selectedDuration;
            const href = `?${new URLSearchParams({ ...(sp.tz ? { tz: sp.tz } : {}), duration: String(d) }).toString()}`;
            return (
              <a
                key={d}
                href={href}
                style={{
                  display: 'inline-block',
                  marginRight: '0.5rem',
                  padding: '4px 14px',
                  borderRadius: 20,
                  border: '1px solid #2563eb',
                  background: active ? '#2563eb' : 'transparent',
                  color: active ? '#fff' : '#2563eb',
                  textDecoration: 'none',
                  fontSize: 14,
                  fontWeight: active ? 600 : 400,
                }}
              >
                {d} min
              </a>
            );
          })}
        </div>
      ) : (
        <p>Duration: {selectedDuration} min</p>
      )}

      {sp.error && <p style={{ color: 'crimson', background: '#fff0f0', padding: '0.5rem', borderRadius: 4 }}>
        {decodeURIComponent(sp.error)}
      </p>}

      {/* Timezone switcher — JS detects local tz on first load and redirects */}
      <p style={{ fontSize: 13, color: '#6b7280' }}>
        Times shown in <strong>{tzLabel}</strong>.
        {requestedTz && (
          <> <a href={`/b/${token}`} style={{ color: '#2563eb', marginLeft: 4 }}>Switch to host timezone</a></>
        )}
      </p>

      {/* Client-side tz detection: redirect once to ?tz= if not already set */}
      {!requestedTz && (
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var tz=Intl.DateTimeFormat().resolvedOptions().timeZone;if(tz&&tz!=='${ownerTz}'){var u=new URL(window.location.href);u.searchParams.set('tz',tz);window.history.replaceState(null,'',u.toString())}}catch(e){}})();`,
          }}
        />
      )}

      {slots.length === 0 ? (
        <p>No available slots in the next {page.maxAdvanceDays} days. Please check back later.</p>
      ) : (
        <form action={holdWithToken}>
          <input type="hidden" name="duration" value={selectedDuration} />
          {/* Pass current display tz through so confirm/success pages can use it */}
          <input type="hidden" name="tz" id="tz-form-input" value={displayTz} />
          <script dangerouslySetInnerHTML={{ __html: `document.addEventListener('DOMContentLoaded',function(){var p=new URLSearchParams(window.location.search).get('tz');if(p){var el=document.getElementById('tz-form-input');if(el)el.value=p;}});` }} />
          <h2>Choose a time</h2>
          {Array.from(grouped.entries()).map(([date, daySlots]) => (
            <fieldset key={date} style={{ marginBottom: '1rem', border: '1px solid #ddd', borderRadius: 4, padding: '0.75rem' }}>
              <legend><strong>{date}</strong></legend>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                {daySlots.map(slot => {
                  const label = DateTime.fromJSDate(slot.start, { zone: 'UTC' }).setZone(displayTz).toFormat('h:mm a');
                  return (
                    <label key={slot.start.toISOString()} style={{ cursor: 'pointer' }}>
                      <input type="radio" name="slot" value={slot.start.toISOString()} required style={{ marginRight: '4px' }} />
                      {label}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}

          <h2>Your details</h2>
          <div style={{ display: 'grid', gap: '0.75rem', maxWidth: 380 }}>
            <label>Name<br />
              <input name="attendeeName" required style={{ width: '100%' }} />
            </label>
            <label>Email<br />
              <input name="attendeeEmail" type="email" required style={{ width: '100%' }} />
            </label>
            <label>
              Topic <span style={{ color: '#9ca3af', fontWeight: 400 }}>(optional)</span><br />
              <input
                name="guestTitle"
                maxLength={100}
                placeholder="Brief description of what the meeting is about"
                style={{ width: '100%' }}
              />
            </label>
            <button type="submit" style={{ padding: '0.6rem 1.5rem', fontSize: '1rem' }}>Reserve slot →</button>
          </div>
        </form>
      )}
    </main>
  );
}
