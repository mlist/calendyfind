import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { resolve } from 'path';
import * as schema from '@/lib/db/schema';
import { bookingPage as bookingPageTable, user as userTable } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { getPageByToken } from '@/lib/booking/holds';
import { randomBytes } from 'crypto';

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  return db;
}

describe('secret-link rotation', () => {
  it('old token is dead immediately after rotation', () => {
    const db = makeDb();

    db.insert(userTable).values({
      id: 'u1',
      email: 'owner@example.com',
      name: 'Owner',
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).run();

    const oldToken = randomBytes(32).toString('base64url');
    const pageId = 'page-1';

    db.insert(bookingPageTable).values({
      id: pageId,
      userId: 'u1',
      secretToken: oldToken,
      title: 'My Page',
      durationMin: 30,
      bufferMin: 0,
      minNoticeMin: 60,
      maxAdvanceDays: 30,
      active: true,
    }).run();

    // Old token resolves before rotation
    const before = getPageByToken(db, oldToken);
    expect(before).not.toBeNull();
    expect(before!.id).toBe(pageId);

    // Simulate rotation — generate new token, update tokenRotatedAt
    const newToken = randomBytes(32).toString('base64url');
    const now = new Date();
    db.update(bookingPageTable)
      .set({ secretToken: newToken, tokenRotatedAt: now })
      .where(eq(bookingPageTable.id, pageId))
      .run();

    // Old token is now dead
    const afterOld = getPageByToken(db, oldToken);
    expect(afterOld).toBeUndefined();

    // New token works
    const afterNew = getPageByToken(db, newToken);
    expect(afterNew).toBeDefined();
    expect(afterNew!.id).toBe(pageId);
    expect(afterNew!.tokenRotatedAt).toBeTruthy();
    // SQLite stores timestamps as integer seconds so allow ±1s tolerance
    expect(Math.abs(afterNew!.tokenRotatedAt!.getTime() - now.getTime())).toBeLessThan(2000);
  });
});
