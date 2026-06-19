import { auth } from '@/lib/auth';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { auditLog, user as userTable } from '@/lib/db/schema';
import { and, desc, eq, gte, like } from 'drizzle-orm';
import { DateTime } from 'luxon';

const cell: React.CSSProperties = { padding: '8px 12px', borderBottom: '1px solid #e5e7eb', verticalAlign: 'top', fontSize: 13 };
const head: React.CSSProperties = { ...cell, background: '#f9fafb', fontWeight: 600, borderBottom: '2px solid #e5e7eb' };

interface PageProps {
  searchParams: Promise<{ actor?: string; action?: string; since?: string }>;
}

export default async function AdminAuditPage({ searchParams }: PageProps) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (session?.user.role !== 'admin') redirect('/login');

  const sp = await searchParams;
  const actorFilter = sp.actor?.trim() || '';
  const actionFilter = sp.action?.trim() || '';
  const sinceFilter = sp.since?.trim() || '';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conditions: any[] = [];
  if (actorFilter) conditions.push(like(auditLog.actor, `%${actorFilter}%`));
  if (actionFilter) conditions.push(like(auditLog.action, `%${actionFilter}%`));
  if (sinceFilter) {
    const d = new Date(sinceFilter);
    if (!isNaN(d.getTime())) conditions.push(gte(auditLog.ts, d));
  }

  const rows = db
    .select()
    .from(auditLog)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(auditLog.ts))
    .limit(500)
    .all();

  // Resolve actor IDs to user emails (best-effort, no join to keep query simple)
  const uniqueActors = [...new Set(rows.map(r => r.actor).filter(a => a !== 'public' && a !== 'system'))];
  const users = uniqueActors.length > 0
    ? db.select({ id: userTable.id, email: userTable.email }).from(userTable).all()
    : [];
  const userMap = new Map(users.map(u => [u.id, u.email]));

  return (
    <main style={{ padding: '2rem', maxWidth: 1100, margin: '0 auto' }}>
      <h1 style={{ marginBottom: '0.25rem' }}>Admin — Audit Log</h1>
      <p style={{ color: '#6b7280', marginBottom: '1.5rem' }}>
        <a href="/admin" style={{ color: '#2563eb' }}>← Users</a>
        {' · '}
        <a href="/admin/bookings" style={{ color: '#2563eb' }}>Bookings</a>
        {' · '}
        <a href="/admin/health" style={{ color: '#2563eb' }}>Health</a>
      </p>

      <form method="GET" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: '1.5rem', alignItems: 'flex-end' }}>
        {[
          { label: 'Actor (user ID or "public")', name: 'actor', value: actorFilter },
          { label: 'Action (e.g. booking.confirmed)', name: 'action', value: actionFilter },
          { label: 'Since (YYYY-MM-DD)', name: 'since', value: sinceFilter },
        ].map(f => (
          <label key={f.name} style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 13 }}>
            {f.label}
            <input
              name={f.name}
              defaultValue={f.value}
              style={{ padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 13, width: 200 }}
            />
          </label>
        ))}
        <button type="submit" style={{ padding: '6px 14px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 13, alignSelf: 'flex-end' }}>
          Filter
        </button>
        <a href="/admin/audit" style={{ alignSelf: 'flex-end', fontSize: 13, color: '#6b7280' }}>Reset</a>
      </form>

      <p style={{ color: '#6b7280', fontSize: 13, marginBottom: '0.75rem' }}>
        Showing {rows.length} of up to 500 most recent entries.
      </p>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={head}>Time (UTC)</th>
              <th style={head}>Actor</th>
              <th style={head}>Action</th>
              <th style={head}>Target</th>
              <th style={head}>IP</th>
              <th style={head}>Metadata</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const ts = DateTime.fromJSDate(r.ts!, { zone: 'UTC' }).toFormat('yyyy-MM-dd HH:mm:ss');
              const actorLabel = r.actor === 'public' || r.actor === 'system'
                ? r.actor
                : (userMap.get(r.actor) ?? r.actor.slice(0, 8) + '…');
              const targetLabel = r.targetType && r.targetId
                ? `${r.targetType}:${r.targetId.slice(0, 8)}…`
                : (r.targetType ?? '');

              let metaObj: Record<string, unknown> | null = null;
              try { if (r.metadata) metaObj = JSON.parse(r.metadata); } catch { /* ok */ }

              const actionColor = r.action.includes('failure') || r.action.includes('blocked')
                ? '#dc2626'
                : r.action.includes('success') ? '#16a34a' : '#374151';

              return (
                <tr key={r.id}>
                  <td style={{ ...cell, whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: 12 }}>{ts}</td>
                  <td style={{ ...cell, fontSize: 12 }}>{actorLabel}</td>
                  <td style={{ ...cell, fontWeight: 600, color: actionColor }}>{r.action}</td>
                  <td style={{ ...cell, fontFamily: 'monospace', fontSize: 11 }}>{targetLabel}</td>
                  <td style={{ ...cell, fontSize: 11 }}>{r.ip ?? ''}</td>
                  <td style={{ ...cell, fontFamily: 'monospace', fontSize: 11, maxWidth: 300, wordBreak: 'break-all' }}>
                    {metaObj ? JSON.stringify(metaObj) : ''}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={6} style={{ ...cell, color: '#6b7280', textAlign: 'center' }}>No entries match these filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
