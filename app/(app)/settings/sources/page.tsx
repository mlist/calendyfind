import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { availabilitySource } from '@/lib/db/schema';
import { headers } from 'next/headers';
import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { addSourceAction, deleteSourceAction } from './_actions';

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function SourcesPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const errorMsg = typeof sp.error === 'string' ? sp.error : null;
  const successMsg = typeof sp.success === 'string' ? sp.success : null;

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');

  const sources = await db
    .select()
    .from(availabilitySource)
    .where(eq(availabilitySource.userId, session.user.id));

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
        <a href="/settings" style={{ color: '#6b7280' }}>
          Profile
        </a>
        <a href="/settings/sources" style={{ color: '#2563eb', fontWeight: 600 }}>
          ICS Sources
        </a>
        <a href="/settings/targets" style={{ color: '#6b7280' }}>
          Write Targets
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

      <h2 style={{ marginBottom: '0.75rem', fontSize: 16 }}>ICS Availability Sources</h2>
      <p style={{ marginBottom: '1rem', fontSize: 13, color: '#6b7280' }}>
        Read-only ICS calendar feeds used to determine your busy times. The app never writes to these.
      </p>

      {sources.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: '1.5rem' }}>
          <thead>
            <tr style={{ color: '#6b7280' }}>
              <th style={{ textAlign: 'left', padding: '6px 0', borderBottom: '2px solid #e5e7eb', fontWeight: 500 }}>Label</th>
              <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '2px solid #e5e7eb', fontWeight: 500 }}>ICS URL</th>
              <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '2px solid #e5e7eb', fontWeight: 500 }}>Last fetched</th>
              <th style={{ borderBottom: '2px solid #e5e7eb' }} />
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s.id}>
                <td style={{ padding: '8px 0', borderBottom: '1px solid #e5e7eb' }}>{s.label}</td>
                <td style={{ padding: '8px 8px', borderBottom: '1px solid #e5e7eb', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <span title={s.icsUrl} style={{ color: '#2563eb', fontSize: 12 }}>
                    {s.icsUrl.length > 50 ? s.icsUrl.slice(0, 50) + '…' : s.icsUrl}
                  </span>
                </td>
                <td style={{ padding: '8px 8px', borderBottom: '1px solid #e5e7eb', color: '#6b7280', fontSize: 12 }}>
                  {s.fetchError ? (
                    <span style={{ color: '#dc2626' }} title={s.fetchError}>
                      Error
                    </span>
                  ) : s.lastFetchedAt ? (
                    new Date(s.lastFetchedAt).toLocaleString()
                  ) : (
                    'Never'
                  )}
                </td>
                <td style={{ padding: '8px 8px', borderBottom: '1px solid #e5e7eb' }}>
                  <form action={deleteSourceAction}>
                    <input type="hidden" name="id" value={s.id} />
                    <button
                      type="submit"
                      style={{ color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, padding: 0 }}
                    >
                      Delete
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {sources.length === 0 && (
        <p style={{ marginBottom: '1.5rem', color: '#6b7280', fontSize: 13 }}>
          No sources added yet.
        </p>
      )}

      <h3 style={{ marginBottom: '0.75rem', fontSize: 15 }}>Add Source</h3>
      <form action={addSourceAction} style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 480 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 14 }}>
          Label
          <input
            name="label"
            type="text"
            required
            placeholder="e.g. Work calendar"
            style={inp}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 14 }}>
          ICS URL
          <input
            name="icsUrl"
            type="url"
            required
            placeholder="https://…/calendar.ics"
            style={inp}
          />
          <span style={{ fontSize: 12, color: '#6b7280' }}>
            http, https, or webcal URLs are accepted.
          </span>
        </label>
        <button
          type="submit"
          style={{
            padding: '8px 16px',
            background: '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            fontWeight: 600,
            alignSelf: 'flex-start',
          }}
        >
          Add Source
        </button>
      </form>
    </main>
  );
}
