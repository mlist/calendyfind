import { auth } from '@/lib/auth';
import { headers } from 'next/headers';
import {
  createUserAction,
  setRoleAction,
  banUserAction,
  unbanUserAction,
  resetPasswordAction,
  removeUserAction,
} from './_actions';

const cell: React.CSSProperties = {
  padding: '8px 12px',
  borderBottom: '1px solid #e5e7eb',
  verticalAlign: 'top',
};
const head: React.CSSProperties = {
  padding: '8px 12px',
  textAlign: 'left',
  borderBottom: '2px solid #e5e7eb',
  background: '#f9fafb',
  fontWeight: 600,
  fontSize: 13,
};

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function AdminPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : null;
  const success = typeof sp.success === 'string' ? sp.success : null;

  const h = await headers();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (await auth.api.listUsers({ headers: h, query: { limit: 200 } })) as any;
  const users: Array<{
    id: string;
    email: string;
    name: string;
    role: string | null;
    banned: boolean | null;
    banReason: string | null;
  }> = result?.users ?? [];

  return (
    <main style={{ padding: '2rem', maxWidth: 960, margin: '0 auto' }}>
      <h1 style={{ marginBottom: '0.25rem' }}>Admin — User Management</h1>
      <p style={{ marginBottom: '1.5rem', color: '#6b7280' }}>
        <a href="/dashboard" style={{ color: '#2563eb' }}>← Dashboard</a>
        {' · '}
        <a href="/admin/bookings" style={{ color: '#2563eb' }}>Bookings</a>
        {' · '}
        <a href="/admin/health" style={{ color: '#2563eb' }}>Health</a>
        {' · '}
        <a href="/admin/audit" style={{ color: '#2563eb' }}>Audit log</a>
      </p>

      {error && (
        <div
          style={{
            marginBottom: '1rem',
            padding: '12px 16px',
            background: '#fef2f2',
            border: '1px solid #fca5a5',
            borderRadius: 6,
            color: '#dc2626',
          }}
        >
          {error}
        </div>
      )}
      {success && (
        <div
          style={{
            marginBottom: '1rem',
            padding: '12px 16px',
            background: '#f0fdf4',
            border: '1px solid #86efac',
            borderRadius: 6,
            color: '#16a34a',
          }}
        >
          {success}
        </div>
      )}

      <h2 style={{ marginBottom: '0.75rem' }}>Users ({users.length})</h2>
      <div style={{ overflowX: 'auto', marginBottom: '2.5rem' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={head}>Name / Email</th>
              <th style={head}>Role</th>
              <th style={head}>Status</th>
              <th style={head}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td style={cell}>
                  <strong>{u.name}</strong>
                  <br />
                  <span style={{ color: '#6b7280', fontSize: 12 }}>{u.email}</span>
                </td>

                <td style={cell}>
                  <form action={setRoleAction} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <input type="hidden" name="userId" value={u.id} />
                    <select
                      name="role"
                      defaultValue={u.role ?? 'user'}
                      style={{ padding: '2px 6px', fontSize: 13, borderRadius: 3, border: '1px solid #d1d5db' }}
                    >
                      <option value="user">user</option>
                      <option value="admin">admin</option>
                    </select>
                    <button type="submit" style={{ padding: '2px 8px', fontSize: 12, cursor: 'pointer', borderRadius: 3, border: '1px solid #d1d5db', background: '#f9fafb' }}>
                      Set
                    </button>
                  </form>
                </td>

                <td style={cell}>
                  {u.banned ? (
                    <span style={{ color: '#dc2626', fontSize: 12 }}>
                      banned{u.banReason ? `: ${u.banReason}` : ''}
                    </span>
                  ) : (
                    <span style={{ color: '#16a34a', fontSize: 12 }}>active</span>
                  )}
                </td>

                <td style={{ ...cell, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start' }}>
                  {u.banned ? (
                    <form action={unbanUserAction}>
                      <input type="hidden" name="userId" value={u.id} />
                      <button type="submit" style={{ fontSize: 12, color: '#2563eb', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                        Unban
                      </button>
                    </form>
                  ) : (
                    <form action={banUserAction} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <input type="hidden" name="userId" value={u.id} />
                      <input
                        name="banReason"
                        placeholder="Reason (optional)"
                        style={{ padding: '2px 6px', fontSize: 12, width: 130, borderRadius: 3, border: '1px solid #d1d5db' }}
                      />
                      <button type="submit" style={{ fontSize: 12, color: '#d97706', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                        Ban
                      </button>
                    </form>
                  )}

                  <form action={resetPasswordAction} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <input type="hidden" name="userId" value={u.id} />
                    <input
                      name="newPassword"
                      type="password"
                      placeholder="New password (8+)"
                      style={{ padding: '2px 6px', fontSize: 12, width: 130, borderRadius: 3, border: '1px solid #d1d5db' }}
                    />
                    <button type="submit" style={{ fontSize: 12, color: '#7c3aed', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                      Reset pw
                    </button>
                  </form>

                  <form action={removeUserAction} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <input type="hidden" name="userId" value={u.id} />
                    <input
                      name="confirm"
                      placeholder="Type DELETE"
                      style={{ padding: '2px 6px', fontSize: 12, width: 85, borderRadius: 3, border: '1px solid #d1d5db' }}
                    />
                    <button type="submit" style={{ fontSize: 12, color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                      Delete
                    </button>
                  </form>
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr>
                <td colSpan={4} style={{ padding: '1rem', color: '#6b7280', textAlign: 'center' }}>
                  No users found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2 style={{ marginBottom: '0.75rem' }}>Create User</h2>
      <form
        action={createUserAction}
        style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 400 }}
      >
        {(
          [
            { label: 'Email', name: 'email', type: 'email' },
            { label: 'Name', name: 'name', type: 'text' },
            { label: 'Password (min 8 characters)', name: 'password', type: 'password' },
          ] as const
        ).map(({ label, name, type }) => (
          <label key={name} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 14 }}>
            {label}
            <input
              name={name}
              type={type}
              required
              style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 14 }}
            />
          </label>
        ))}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 14 }}>
          Role
          <select
            name="role"
            style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 14 }}
          >
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
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
          Create User
        </button>
      </form>
    </main>
  );
}
