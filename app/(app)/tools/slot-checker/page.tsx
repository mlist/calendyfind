import { redirect } from 'next/navigation';
import Link from 'next/link';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { user as userTable } from '@/lib/db/schema';
import { eq, ne } from 'drizzle-orm';
import { parseSlotLines } from '@/lib/freebusy/parse-slots';
import { classifyForUsers } from '@/lib/freebusy/classify';

const STATUS_LABEL: Record<string, string> = {
  free:    'Free',
  busy:    'Busy',
  partial: 'Partial',
};
const STATUS_COLOR: Record<string, string> = {
  free:    '#16a34a',
  busy:    '#dc2626',
  partial: '#d97706',
};

export default async function SlotCheckerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[]>>;
}) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');

  const sp = await searchParams;

  const rawSlots = typeof sp.slots === 'string' ? sp.slots : '';
  const rawTz    = typeof sp.tz    === 'string' ? sp.tz    : '';
  const rawAttendees = Array.isArray(sp.attendee)
    ? sp.attendee
    : sp.attendee ? [sp.attendee] : [];

  // Other users available as attendees
  const otherUsers = db.select({ id: userTable.id, name: userTable.name, email: userTable.email })
    .from(userTable)
    .where(ne(userTable.id, session.user.id))
    .all();

  const ownerTzRow = db.select({ timezone: userTable.timezone }).from(userTable)
    .where(eq(userTable.id, session.user.id)).get();
  const displayTz = rawTz || ownerTzRow?.timezone || 'UTC';

  // Parse + classify only when the form has been submitted with slots
  type ResultRow = {
    raw: string;
    interpretedAs: string;
    status: 'free' | 'busy' | 'partial' | null;
    overlapMs: number;
    error?: string;
  };
  let rows: ResultRow[] = [];
  let classifyError: string | undefined;

  if (rawSlots.trim()) {
    const parsed = parseSlotLines(rawSlots, displayTz);
    const valid  = parsed.filter((p): p is Extract<typeof p, { ok: true }> => p.ok);

    if (valid.length > 0) {
      const allUserIds = [session.user.id, ...rawAttendees];
      const now = new Date();
      // Range: cover all candidate slots
      const starts = valid.map(p => p.start.getTime());
      const ends   = valid.map(p => p.end.getTime());
      const range  = {
        from: new Date(Math.min(...starts) - 60_000),
        to:   new Date(Math.max(...ends)   + 60_000),
      };

      try {
        const { results } = await classifyForUsers(db, allUserIds, valid, range, now);
        const resultMap = new Map(results.map(r => [r.candidate.start.toISOString(), r]));

        rows = parsed.map(p => {
          if (!p.ok) {
            return { raw: p.raw, interpretedAs: '—', status: null, overlapMs: 0, error: p.error };
          }
          const r = resultMap.get(p.start.toISOString());
          return {
            raw:           p.raw,
            interpretedAs: p.interpretedAs,
            status:        r?.status ?? 'free',
            overlapMs:     r?.overlapMs ?? 0,
          };
        });
      } catch (e) {
        classifyError = e instanceof Error ? e.message : String(e);
      }
    } else {
      // All lines failed to parse — still show the error rows
      rows = parsed.map(p => ({
        raw:           p.raw,
        interpretedAs: '—',
        status:        null,
        overlapMs:     0,
        error:         p.ok ? undefined : p.error,
      }));
    }
  }

  const freeSlots = rows.filter(r => r.status === 'free');

  return (
    <main style={{ maxWidth: 800, margin: '2rem auto', padding: '0 1rem', fontFamily: 'system-ui' }}>
      <Link href="/dashboard">← Dashboard</Link>
      <h1>Slot checker</h1>
      <p style={{ color: '#6b7280', fontSize: 14 }}>
        Paste candidate time slots (one per line) to check whether they are free.
        Format: <code>YYYY-MM-DD HH:MM-HH:MM</code>
      </p>

      {/* GET form — results appear in-page via searchParams */}
      <form method="get" style={{ marginBottom: '1.5rem' }}>
        <div style={{ display: 'grid', gap: '0.75rem', maxWidth: 560 }}>
          <label>
            Time slots<br />
            <textarea
              name="slots"
              rows={8}
              defaultValue={rawSlots}
              placeholder={'2026-07-14 10:00-10:30\n2026-07-14 14:00-15:00\n2026-07-15 09:00-09:30'}
              style={{ width: '100%', fontFamily: 'monospace', fontSize: 13 }}
            />
          </label>

          <label>
            Timezone<br />
            <input
              name="tz"
              defaultValue={displayTz}
              placeholder="e.g. Europe/Berlin"
              style={{ width: '100%' }}
            />
            <span style={{ fontSize: 12, color: '#6b7280' }}>
              Slots are interpreted in this timezone. Defaults to your account timezone.
            </span>
          </label>

          {otherUsers.length > 0 && (
            <fieldset style={{ border: '1px solid #ddd', borderRadius: 4, padding: '0.5rem 0.75rem' }}>
              <legend style={{ fontSize: 13, fontWeight: 600 }}>Also check attendees (optional)</legend>
              {otherUsers.map(u => (
                <label key={u.id} style={{ display: 'block', fontSize: 14, margin: '2px 0' }}>
                  <input
                    type="checkbox"
                    name="attendee"
                    value={u.id}
                    defaultChecked={rawAttendees.includes(u.id)}
                    style={{ marginRight: 6 }}
                  />
                  {u.name} &lt;{u.email}&gt;
                </label>
              ))}
            </fieldset>
          )}

          <button type="submit" style={{ padding: '0.5rem 1.5rem', fontSize: '1rem', width: 'fit-content' }}>
            Check slots
          </button>
        </div>
      </form>

      {classifyError && (
        <p style={{ color: 'crimson', background: '#fff0f0', padding: '0.5rem', borderRadius: 4 }}>
          Error: {classifyError}
        </p>
      )}

      {rows.length > 0 && (
        <>
          <h2>Results</h2>
          <p style={{ fontSize: 12, color: '#6b7280', marginTop: '-0.5rem' }}>
            Interpreted in timezone: <strong>{displayTz}</strong>
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #ccc' }}>
                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>Line</th>
                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>Interpreted as (UTC)</th>
                  <th style={{ textAlign: 'center', padding: '6px 8px' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid #eee' }}>
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{r.raw}</td>
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontSize: 12 }}>
                      {r.error ? (
                        <span style={{ color: 'crimson' }}>Parse error: {r.error}</span>
                      ) : (
                        r.interpretedAs
                      )}
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                      {r.status ? (
                        <span style={{ fontWeight: 600, color: STATUS_COLOR[r.status] }}>
                          {STATUS_LABEL[r.status]}
                        </span>
                      ) : (
                        <span style={{ color: '#9ca3af' }}>—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {freeSlots.length > 0 && (
            <div style={{ marginTop: '1.5rem' }}>
              <h3>Free slots (copy-paste ready)</h3>
              <textarea
                readOnly
                rows={freeSlots.length + 1}
                value={freeSlots.map(r => r.raw).join('\n')}
                style={{ width: '100%', fontFamily: 'monospace', fontSize: 13, background: '#f0fff0' }}
              />
            </div>
          )}
        </>
      )}
    </main>
  );
}
