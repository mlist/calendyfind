import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { resolve } from 'path';
import * as schema from '@/lib/db/schema';
import { appendAudit } from '@/lib/audit';
import { auditLog } from '@/lib/db/schema';
import { desc } from 'drizzle-orm';

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  return db;
}

describe('audit log', () => {
  it('appends an audit entry', () => {
    const db = makeDb();
    appendAudit(db, {
      actor: 'user-123',
      action: 'booking.confirmed',
      targetType: 'booking',
      targetId: 'bk-1',
      ip: '1.2.3.4',
      metadata: { pageId: 'pg-1' },
    });

    const rows = db.select().from(auditLog).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe('user-123');
    expect(rows[0].action).toBe('booking.confirmed');
    expect(rows[0].targetType).toBe('booking');
    expect(rows[0].targetId).toBe('bk-1');
    expect(rows[0].ip).toBe('1.2.3.4');
    expect(JSON.parse(rows[0].metadata!)).toEqual({ pageId: 'pg-1' });
  });

  it('silently ignores metadata-free entries', () => {
    const db = makeDb();
    appendAudit(db, { actor: 'public', action: 'rate_limit.blocked' });
    const rows = db.select().from(auditLog).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toBeNull();
  });

  it('multiple entries are all stored (append-only)', () => {
    const db = makeDb();
    appendAudit(db, { actor: 'admin-1', action: 'user.create', targetType: 'user', targetId: 'u1' });
    appendAudit(db, { actor: 'admin-1', action: 'user.role_change', targetType: 'user', targetId: 'u1' });
    appendAudit(db, { actor: 'admin-1', action: 'user.delete', targetType: 'user', targetId: 'u1' });
    const rows = db.select().from(auditLog).all();
    expect(rows).toHaveLength(3);
  });

  it('never throws on a DB error — audit failures are silenced', () => {
    // Pass a broken DB object to simulate failure
    const brokenDb = {} as ReturnType<typeof makeDb>;
    expect(() => appendAudit(brokenDb, { actor: 'x', action: 'booking.confirmed' })).not.toThrow();
  });

  it('actor, targetType, and targetId are stored correctly for system entries', () => {
    const db = makeDb();
    appendAudit(db, { actor: 'system', action: 'email.sent', targetType: 'booking', targetId: 'bk-99' });
    const rows = db.select().from(auditLog).orderBy(desc(auditLog.ts)).all();
    expect(rows[0].actor).toBe('system');
    expect(rows[0].targetId).toBe('bk-99');
  });
});
