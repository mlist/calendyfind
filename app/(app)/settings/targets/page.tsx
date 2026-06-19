import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { writeTarget } from '@/lib/db/schema';
import { headers } from 'next/headers';
import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import {
  addCalDavTargetAction,
  initiateGoogleOAuthAction,
  setDefaultTargetAction,
  deleteTargetAction,
} from './_actions';

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function TargetsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const errorMsg   = typeof sp.error   === 'string' ? sp.error   : null;
  const successMsg = typeof sp.success === 'string' ? sp.success : null;

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');

  const targets = db
    .select({
      id: writeTarget.id,
      label: writeTarget.label,
      provider: writeTarget.provider,
      calendarRef: writeTarget.calendarRef,
      isDefault: writeTarget.isDefault,
    })
    .from(writeTarget)
    .where(eq(writeTarget.userId, session.user.id))
    .all();

  const inp: React.CSSProperties = {
    padding: '6px 10px',
    border: '1px solid #d1d5db',
    borderRadius: 4,
    fontSize: 14,
  };

  const googleConfigured = !!process.env.GOOGLE_CLIENT_ID;

  return (
    <main style={{ padding: '2rem', maxWidth: 680, margin: '0 auto' }}>
      <h1 style={{ marginBottom: '0.25rem' }}>Settings</h1>
      <nav style={{ marginBottom: '1.5rem', display: 'flex', gap: '1rem', fontSize: 14 }}>
        <a href="/settings" style={{ color: '#6b7280' }}>Profile</a>
        <a href="/settings/sources" style={{ color: '#6b7280' }}>ICS Sources</a>
        <a href="/settings/targets" style={{ color: '#2563eb', fontWeight: 600 }}>Write Targets</a>
        <span style={{ flex: 1 }} />
        <a href="/dashboard" style={{ color: '#6b7280' }}>← Dashboard</a>
      </nav>

      {errorMsg && (
        <div style={{ marginBottom: '1rem', padding: '12px 16px', background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 6, color: '#dc2626' }}>
          {decodeURIComponent(errorMsg)}
        </div>
      )}
      {successMsg && (
        <div style={{ marginBottom: '1rem', padding: '12px 16px', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 6, color: '#16a34a' }}>
          {decodeURIComponent(successMsg)}
        </div>
      )}

      <h2 style={{ marginBottom: '0.75rem', fontSize: 16 }}>Write Targets</h2>
      <p style={{ marginBottom: '1rem', fontSize: 13, color: '#6b7280' }}>
        The calendar where confirmed bookings are written. Credentials are stored encrypted and never shown again.
      </p>

      {targets.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: '1.5rem' }}>
          <thead>
            <tr style={{ color: '#6b7280' }}>
              <th style={{ textAlign: 'left', padding: '6px 0', borderBottom: '2px solid #e5e7eb', fontWeight: 500 }}>Label</th>
              <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '2px solid #e5e7eb', fontWeight: 500 }}>Provider</th>
              <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '2px solid #e5e7eb', fontWeight: 500 }}>Default</th>
              <th style={{ borderBottom: '2px solid #e5e7eb' }} />
            </tr>
          </thead>
          <tbody>
            {targets.map(t => (
              <tr key={t.id}>
                <td style={{ padding: '8px 0', borderBottom: '1px solid #e5e7eb' }}>
                  <strong>{t.label}</strong>
                  <br />
                  <span style={{ fontSize: 11, color: '#9ca3af' }} title={t.calendarRef}>
                    {t.provider} · {t.calendarRef.length > 40 ? t.calendarRef.slice(0, 40) + '…' : t.calendarRef}
                  </span>
                </td>
                <td style={{ padding: '8px 8px', borderBottom: '1px solid #e5e7eb' }}>{t.provider}</td>
                <td style={{ padding: '8px 8px', borderBottom: '1px solid #e5e7eb' }}>
                  {t.isDefault ? (
                    <span style={{ fontSize: 12, color: '#2563eb', fontWeight: 600 }}>default</span>
                  ) : (
                    <form action={setDefaultTargetAction}>
                      <input type="hidden" name="id" value={t.id} />
                      <button type="submit" style={{ fontSize: 12, color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                        Make default
                      </button>
                    </form>
                  )}
                </td>
                <td style={{ padding: '8px 8px', borderBottom: '1px solid #e5e7eb' }}>
                  <form action={deleteTargetAction}>
                    <input type="hidden" name="id" value={t.id} />
                    <button type="submit" style={{ color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, padding: 0 }}>
                      Delete
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {targets.length === 0 && (
        <p style={{ marginBottom: '1.5rem', color: '#6b7280', fontSize: 13 }}>No write targets added yet.</p>
      )}

      {/* ── Google Calendar (OAuth 2.0) ───────────────────────────────────────── */}
      <h3 style={{ marginBottom: '0.5rem', fontSize: 15 }}>Connect Google Calendar</h3>
      <p style={{ marginBottom: '0.75rem', fontSize: 12, color: '#6b7280' }}>
        Uses OAuth 2.0 — the only supported method. Google's CalDAV endpoint does not accept app passwords.
        {!googleConfigured && (
          <strong style={{ color: '#dc2626' }}> GOOGLE_CLIENT_ID is not set — configure it in .env first.</strong>
        )}
      </p>
      {googleConfigured && (
        <form action={initiateGoogleOAuthAction} style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 480, marginBottom: '2rem' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 14 }}>
            Label
            <input name="label" type="text" defaultValue="Google Calendar" style={inp} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 14 }}>
            Calendar ID
            <input name="calendarRef" type="text" defaultValue="primary" style={inp} />
            <span style={{ fontSize: 12, color: '#6b7280' }}>
              Use <code>primary</code> for your main calendar, or paste a specific calendar ID.
            </span>
          </label>
          <button type="submit" style={{ padding: '8px 16px', background: '#4285f4', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 600, alignSelf: 'flex-start' }}>
            Connect Google Calendar →
          </button>
        </form>
      )}

      {/* ── Generic CalDAV (Nextcloud / iCloud / Fastmail) ───────────────────── */}
      <h3 style={{ marginBottom: '0.5rem', fontSize: 15 }}>Add CalDAV Write Target</h3>
      <p style={{ marginBottom: '0.75rem', fontSize: 12, color: '#6b7280' }}>
        For Nextcloud, iCloud, Fastmail, and other servers that accept Basic Authentication.
        Do not use this for Google — use the Connect button above for Google accounts.
      </p>
      <form action={addCalDavTargetAction} style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 480 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 14 }}>
          Label
          <input name="label" type="text" required placeholder="e.g. Nextcloud Calendar" style={inp} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 14 }}>
          Username
          <input name="username" type="text" required autoComplete="username" style={inp} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 14 }}>
          Password
          <input name="password" type="password" required autoComplete="new-password" style={inp} />
          <span style={{ fontSize: 12, color: '#6b7280' }}>Stored encrypted. Never shown again.</span>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 14 }}>
          Calendar URL
          <input
            name="calendarUrl"
            type="url"
            required
            placeholder="https://nextcloud.example.com/remote.php/dav/calendars/user/personal/"
            style={inp}
          />
        </label>
        <button type="submit" style={{ padding: '8px 16px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 600, alignSelf: 'flex-start' }}>
          Add CalDAV Target
        </button>
      </form>
    </main>
  );
}
