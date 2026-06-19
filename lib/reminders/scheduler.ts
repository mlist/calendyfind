/**
 * In-process reminder scheduler.
 * Call startReminderScheduler() once at app startup (from instrumentation.ts).
 * Uses setInterval — no extra dependencies needed.
 *
 * The interval is intentionally short (60 s) so reminders fire within one minute
 * of their scheduled time. Idempotency lives in processReminders (transaction claim),
 * so overlapping runs are safe.
 */

import { db } from '@/lib/db';
import { processReminders } from './index';

const INTERVAL_MS = 60_000;

let started = false;

export function startReminderScheduler(): void {
  if (started) return;
  started = true;

  const run = async () => {
    try {
      await processReminders(db, new Date());
    } catch (err) {
      console.error('[reminders] scheduler error:', err);
    }
  };

  // Run once immediately on startup to catch any reminders that fired during downtime
  void run();

  const timer = setInterval(run, INTERVAL_MS);
  // Don't keep the Node.js process alive solely for this timer
  timer.unref?.();
}
