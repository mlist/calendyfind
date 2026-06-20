import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { user } from './auth';

export const availabilitySource = sqliteTable('availability_source', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  icsUrl: text('ics_url').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  lastFetchedAt: integer('last_fetched_at', { mode: 'timestamp' }),
  cachedBusy: text('cached_busy'),
  fetchError: text('fetch_error'),
});

export const writeTarget = sqliteTable('write_target', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  provider: text('provider').notNull().$type<'caldav' | 'msgraph' | 'google'>(),
  encryptedCredentials: text('encrypted_credentials').notNull(),
  calendarRef: text('calendar_ref').notNull(),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const bookingPage = sqliteTable('booking_page', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  secretToken: text('secret_token').notNull().unique(),
  title: text('title').notNull(),
  // JSON array of allowed durations in minutes, e.g. "[30,60,90]". Sorted ascending.
  durationOptions: text('duration_options').notNull().default('[30]'),
  bufferMin: integer('buffer_min').notNull().default(0),
  minNoticeMin: integer('min_notice_min').notNull().default(60),
  maxAdvanceDays: integer('max_advance_days').notNull().default(30),
  location: text('location'),
  writeTargetId: text('write_target_id').references(() => writeTarget.id, { onDelete: 'set null' }),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  tokenRotatedAt: integer('token_rotated_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type BookingStatus = 'pending_hold' | 'confirmed' | 'cancelled';

export const booking = sqliteTable('booking', {
  id: text('id').primaryKey(),
  // NULL for internal (multi-attendee) meetings; set for external (booking-page) meetings.
  bookingPageId: text('booking_page_id')
    .references(() => bookingPage.id, { onDelete: 'cascade' }),
  organizerUserId: text('organizer_user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  attendeeName: text('attendee_name').notNull(),
  attendeeEmail: text('attendee_email').notNull(),
  // Meeting title — used for internal meetings (external derive it from bookingPage.title).
  title: text('title'),
  startUtc: integer('start_utc', { mode: 'timestamp' }).notNull(),
  endUtc: integer('end_utc', { mode: 'timestamp' }).notNull(),
  status: text('status').notNull().$type<BookingStatus>(),
  icsUid: text('ics_uid').notNull().unique(),
  sequence: integer('sequence').notNull().default(0),
  externalEventRef: text('external_event_ref'),
  expiresAt: integer('expires_at', { mode: 'timestamp' }),
  cancelToken: text('cancel_token').notNull().unique(),
  emailFailed: integer('email_failed', { mode: 'boolean' }).notNull().default(false),
  // Write target for internal meetings (external derive it from bookingPage.writeTargetId).
  writeTargetId: text('write_target_id')
    .references(() => writeTarget.id, { onDelete: 'set null' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
}, (t) => [
  index('booking_organizer_start_idx').on(t.organizerUserId, t.startUtc),
  index('booking_status_idx').on(t.status),
  index('booking_page_idx').on(t.bookingPageId),
]);

export type BookingAttendeeStatus = 'needs_action' | 'accepted' | 'declined';

export const bookingAttendee = sqliteTable('booking_attendee', {
  id: text('id').primaryKey(),
  bookingId: text('booking_id')
    .notNull()
    .references(() => booking.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  inviteStatus: text('invite_status')
    .notNull()
    .default('needs_action')
    .$type<BookingAttendeeStatus>(),
  emailFailed: integer('email_failed', { mode: 'boolean' }).notNull().default(false),
}, (t) => [
  uniqueIndex('booking_attendee_unique_idx').on(t.bookingId, t.userId),
]);

// Phase 6: audit_log and reminder defined after booking to avoid forward-reference issues.

export const freebusyFeed = sqliteTable('freebusy_feed', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  secretToken: text('secret_token').notNull().unique(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  lastRotatedAt: integer('last_rotated_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
}, (t) => [
  uniqueIndex('freebusy_feed_user_unique').on(t.userId),
]);

export type AuditAction =
  | 'user.create' | 'user.disable' | 'user.enable' | 'user.role_change' | 'user.password_reset' | 'user.delete'
  | 'write_target.create' | 'write_target.update' | 'write_target.delete'
  | 'booking_page.create' | 'booking_page.token_rotate' | 'booking_page.token_revoke' | 'booking_page.delete'
  | 'booking.confirmed' | 'booking.cancelled'
  | 'calendar.write_success' | 'calendar.write_failure'
  | 'email.sent' | 'email.failed'
  | 'auth.login_success' | 'auth.login_failure'
  | 'rate_limit.blocked'
  | 'freebusy_feed.create' | 'freebusy_feed.rotate' | 'freebusy_feed.revoke';

export const auditLog = sqliteTable('audit_log', {
  id: text('id').primaryKey(),
  ts: integer('ts', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  // 'public' for unauthenticated actions, 'system' for scheduler, or a user.id
  actor: text('actor').notNull(),
  action: text('action').notNull().$type<AuditAction>(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  ip: text('ip'),
  // JSON metadata — NEVER include secrets, decrypted credentials, or unnecessary PII
  metadata: text('metadata'),
}, (t) => [
  index('audit_log_ts_idx').on(t.ts),
  index('audit_log_actor_idx').on(t.actor),
  index('audit_log_action_idx').on(t.action),
]);

export const reminder = sqliteTable('reminder', {
  id: text('id').primaryKey(),
  bookingId: text('booking_id')
    .notNull()
    .references(() => booking.id, { onDelete: 'cascade' }),
  // Minutes before meeting start that this reminder fires
  offsetMin: integer('offset_min').notNull(),
  scheduledFor: integer('scheduled_for', { mode: 'timestamp' }).notNull(),
  sentAt: integer('sent_at', { mode: 'timestamp' }),
  failedAt: integer('failed_at', { mode: 'timestamp' }),
  retryCount: integer('retry_count').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
}, (t) => [
  uniqueIndex('reminder_booking_offset_unique').on(t.bookingId, t.offsetMin),
  index('reminder_scheduled_idx').on(t.scheduledFor),
]);
