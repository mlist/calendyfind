import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { processReminders } from '@/lib/reminders';

/**
 * POST /api/reminders/trigger
 *
 * Manual trigger for the reminder processor. Protected by REMINDER_SECRET
 * env var — callers must send `Authorization: Bearer <REMINDER_SECRET>`.
 * Useful for cron jobs, health checks, or manual ops.
 */
export async function POST(req: Request) {
  const secret = process.env.REMINDER_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'REMINDER_SECRET not configured' }, { status: 503 });
  }

  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ') || auth.slice(7) !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = new Date();
  await processReminders(db, now);
  return NextResponse.json({ ok: true, triggeredAt: now.toISOString() });
}
