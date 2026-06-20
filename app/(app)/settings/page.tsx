import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { user } from '@/lib/db/schema';
import { headers } from 'next/headers';
import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { DAYS, COMMON_TIMEZONES, type WorkingHours } from '@/lib/validation';
import { updateProfileAction } from './_actions';

const DAY_LABELS: Record<string, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function SettingsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const errorMsg = typeof sp.error === 'string' ? sp.error : null;
  const successMsg = typeof sp.success === 'string' ? sp.success : null;

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');

  const [profile] = await db
    .select({ timezone: user.timezone, workingHours: user.workingHours })
    .from(user)
    .where(eq(user.id, session.user.id))
    .limit(1);

  const timezone = profile?.timezone ?? 'UTC';
  let wh: WorkingHours = {};
  try {
    wh = JSON.parse(profile?.workingHours ?? '{}') as WorkingHours;
  } catch {
    // ignore malformed JSON
  }

  const inp: React.CSSProperties = {
    padding: '6px 10px',
    border: '1px solid #d1d5db',
    borderRadius: 4,
    fontSize: 14,
  };

  return (
    <main style={{ padding: '2rem', maxWidth: 680, margin: '0 auto' }}>
      <h1 style={{ marginBottom: '0.25rem' }}>Settings</h1>
      <nav style={{ marginBottom: '1.5rem', display: 'flex', gap: '1rem', fontSize: 14 }}>
        <a href="/settings" style={{ color: '#2563eb', fontWeight: 600 }}>
          Profile
        </a>
        <a href="/settings/sources" style={{ color: '#6b7280' }}>
          ICS Sources
        </a>
        <a href="/settings/targets" style={{ color: '#6b7280' }}>
          Write Targets
        </a>
        <a href="/settings/freebusy" style={{ color: '#6b7280' }}>
          Free/busy feed
        </a>
        <span style={{ flex: 1 }} />
        <a href="/dashboard" style={{ color: '#6b7280' }}>
          ← Dashboard
        </a>
      </nav>

      {errorMsg && (
        <div style={{ marginBottom: '1rem', padding: '12px 16px', background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 6, color: '#dc2626' }}>
          {errorMsg}
        </div>
      )}
      {successMsg && (
        <div style={{ marginBottom: '1rem', padding: '12px 16px', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 6, color: '#16a34a' }}>
          {successMsg}
        </div>
      )}

      <form action={updateProfileAction} style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <section>
          <h2 style={{ marginBottom: '0.75rem', fontSize: 16 }}>Timezone</h2>
          <select name="timezone" defaultValue={timezone} style={{ ...inp, minWidth: 260 }}>
            {COMMON_TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
          <p style={{ marginTop: 6, fontSize: 12, color: '#6b7280' }}>
            Working hours below are interpreted in this timezone.
          </p>
        </section>

        <section>
          <h2 style={{ marginBottom: '0.75rem', fontSize: 16 }}>Working Hours</h2>
          <p style={{ marginBottom: '0.75rem', fontSize: 12, color: '#6b7280' }}>
            Tick each day you are available and set the time range. Add a lunch break to split the
            day into two bookable blocks. Leave unticked = unavailable.
          </p>
          <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 560 }}>
            <thead>
              <tr style={{ fontSize: 12, color: '#6b7280' }}>
                <th style={{ textAlign: 'left', padding: '4px 12px 4px 0', fontWeight: 500 }}>Day</th>
                <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 500 }}>On</th>
                <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 500 }}>From</th>
                <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 500 }}>To</th>
                <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 500 }}>Lunch</th>
                <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 500 }}>Lunch start</th>
                <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 500 }}>Lunch end</th>
              </tr>
            </thead>
            <tbody>
              {DAYS.map((day) => {
                const ranges = wh[day] ?? [];
                // ranges[0] = morning (or full day), ranges[1] = afternoon (if lunch break)
                const hasLunch = ranges.length >= 2;
                const morningStart = ranges[0]?.start ?? '09:00';
                const dayEnd      = hasLunch ? (ranges[1]?.end ?? '17:00') : (ranges[0]?.end ?? '17:00');
                const lunchStart  = hasLunch ? ranges[0].end  : '12:00';
                const lunchEnd    = hasLunch ? ranges[1].start : '13:00';

                return (
                  <tr key={day}>
                    <td style={{ padding: '6px 12px 6px 0', fontSize: 14 }}>{DAY_LABELS[day]}</td>
                    <td style={{ padding: '6px 8px' }}>
                      <input type="checkbox" name={`day_${day}_enabled`} defaultChecked={ranges.length > 0} />
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      <input
                        type="text"
                        name={`day_${day}_start`}
                        defaultValue={morningStart}
                        placeholder="09:00"
                        pattern="\d{2}:\d{2}"
                        style={{ ...inp, width: 70 }}
                      />
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      <input
                        type="text"
                        name={`day_${day}_end`}
                        defaultValue={dayEnd}
                        placeholder="17:00"
                        pattern="\d{2}:\d{2}"
                        style={{ ...inp, width: 70 }}
                      />
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                      <input type="checkbox" name={`day_${day}_lunch_enabled`} defaultChecked={hasLunch} />
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      <input
                        type="text"
                        name={`day_${day}_lunch_start`}
                        defaultValue={lunchStart}
                        placeholder="12:00"
                        pattern="\d{2}:\d{2}"
                        style={{ ...inp, width: 70, color: hasLunch ? undefined : '#9ca3af' }}
                      />
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      <input
                        type="text"
                        name={`day_${day}_lunch_end`}
                        defaultValue={lunchEnd}
                        placeholder="13:00"
                        pattern="\d{2}:\d{2}"
                        style={{ ...inp, width: 70, color: hasLunch ? undefined : '#9ca3af' }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </section>

        <button
          type="submit"
          style={{
            padding: '8px 20px',
            background: '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            fontWeight: 600,
            alignSelf: 'flex-start',
          }}
        >
          Save Profile
        </button>
      </form>
    </main>
  );
}
