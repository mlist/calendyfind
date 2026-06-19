import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { auditLog } from '@/lib/db/schema';
import type { AuditAction } from '@/lib/db/schema';

export type { AuditAction };

export interface AuditEntry {
  actor: string;          // user.id | 'public' | 'system'
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  ip?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: Record<string, any>;
}

// Append-only — no update/delete path exists.
// NEVER pass secrets, decrypted credentials, or attendee PII beyond what's the subject of the action.
export function appendAudit(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: BetterSQLite3Database<any>,
  entry: AuditEntry,
): void {
  try {
    db.insert(auditLog).values({
      id: crypto.randomUUID(),
      actor: entry.actor,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      ip: entry.ip ?? null,
      metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
    }).run();
  } catch {
    // Audit failures must never break the primary action.
  }
}
