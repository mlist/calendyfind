/**
 * iMIP email service using nodemailer.
 *
 * SMTP config from env — no provider is hardcoded.
 * Required env vars: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 * Optional: SMTP_SECURE (default false — use STARTTLS on port 587)
 *
 * ORGANIZER / From alignment: SMTP_FROM should use the same domain as ORGANIZER
 * for best DKIM/SPF alignment and RSVP rendering in mail clients. Document this
 * to the self-hoster in .env.example.
 *
 * Note: CalDAV PUT does NOT send iMIP invites. This service must always be called
 * after any calendar write. If Google Calendar API's sendUpdates parameter is set
 * to 'all', Google sends its own invites — but we use sendUpdates='none' and
 * handle invites here so we control the iMIP content precisely.
 */

import nodemailer from 'nodemailer';
import type { ImipBaseOpts, MultiImipOpts } from '@/lib/ics';
import { generateRequestIcs, generateCancelIcs, generateMultiRequestIcs, generateMultiCancelIcs } from '@/lib/ics';

function createTransport() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT ?? '587');
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error('SMTP_HOST, SMTP_USER, and SMTP_PASS must be set to send email');
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user, pass },
  });
}

// SMTP_FROM is the envelope From. Should align with ORGANIZER email for iMIP RSVP.
function getFrom(): string {
  return process.env.SMTP_FROM ?? process.env.SMTP_USER ?? 'noreply@calendyfind.local';
}

export interface SendInviteOpts extends ImipBaseOpts {
  pageTitle: string;
  /** Additional recipients (notification email, extra guests). */
  extraRecipients?: { name: string; email: string }[];
}

/**
 * Send a METHOD:REQUEST iMIP invite to the attendee and any extra recipients.
 *
 * Structure: multipart/mixed
 *   └─ multipart/alternative
 *        ├─ text/plain (human-readable)
 *        └─ text/calendar; method=REQUEST   ← mail clients render RSVP UI here
 *   └─ application/ics attachment           ← fallback for clients that need it
 *
 * The ICS (containing all ATTENDEE lines) is sent once to the primary attendee,
 * then best-effort to each extra recipient so they can accept/add the event.
 */
export async function sendInviteEmail(opts: SendInviteOpts): Promise<void> {
  const transport = createTransport();
  const icsContent = generateRequestIcs(opts);
  const startStr = opts.startUtc.toUTCString();

  const buildMail = (toName: string, toEmail: string) => ({
    from:    getFrom(),
    to:      `"${toName}" <${toEmail}>`,
    subject: `Meeting invitation: ${opts.summary}`,
    text:    [
      `You have been invited to a meeting.`,
      ``,
      `Event:    ${opts.summary}`,
      `When:     ${startStr}`,
      opts.location ? `Where:    ${opts.location}` : '',
      ``,
      `Please accept or decline this invitation in your calendar application.`,
    ].filter(l => l !== undefined).join('\n'),
    alternatives: [{
      contentType: 'text/calendar; method=REQUEST; charset=UTF-8',
      content:     icsContent,
    }],
    attachments: [{
      filename:    'invite.ics',
      content:     Buffer.from(icsContent),
      contentType: 'application/ics',
    }],
  });

  await transport.sendMail(buildMail(opts.attendeeName, opts.attendeeEmail));

  for (const r of opts.extraRecipients ?? []) {
    try {
      await transport.sendMail(buildMail(r.name, r.email));
    } catch { /* best-effort */ }
  }
}

// ─── Internal (multi-attendee) email helpers ──────────────────────────────────

export interface InternalAttendeeEmailTarget {
  name: string;
  email: string;
  userId: string;
}

/**
 * Send METHOD:REQUEST iMIP invites for an internal meeting.
 * Generates the ICS once (with all ATTENDEE lines), then sends to each attendee.
 * Returns per-attendee send results so callers can track failures individually.
 */
export async function sendInternalInviteEmails(
  opts: MultiImipOpts,
  attendees: InternalAttendeeEmailTarget[],
): Promise<{ userId: string; error?: Error }[]> {
  const transport = createTransport();
  const icsContent = generateMultiRequestIcs(opts);
  const startStr = opts.startUtc.toUTCString();

  const results: { userId: string; error?: Error }[] = [];

  for (const attendee of attendees) {
    try {
      await transport.sendMail({
        from:    getFrom(),
        to:      `"${attendee.name}" <${attendee.email}>`,
        subject: `Meeting invitation: ${opts.summary}`,
        text:    [
          `You have been invited to a meeting.`,
          ``,
          `Event:    ${opts.summary}`,
          `When:     ${startStr}`,
          opts.location ? `Where:    ${opts.location}` : '',
          ``,
          `Please accept or decline this invitation in your calendar application.`,
        ].filter(l => l !== undefined).join('\n'),
        alternatives: [{
          contentType: 'text/calendar; method=REQUEST; charset=UTF-8',
          content:     icsContent,
        }],
        attachments: [{
          filename:    'invite.ics',
          content:     Buffer.from(icsContent),
          contentType: 'application/ics',
        }],
      });
      results.push({ userId: attendee.userId });
    } catch (err) {
      results.push({ userId: attendee.userId, error: err instanceof Error ? err : new Error(String(err)) });
    }
  }

  return results;
}

/**
 * Send METHOD:CANCEL iMIP notices for an internal meeting.
 */
export async function sendInternalCancelEmails(
  opts: MultiImipOpts,
  attendees: InternalAttendeeEmailTarget[],
): Promise<void> {
  const transport = createTransport();
  const icsContent = generateMultiCancelIcs(opts);

  for (const attendee of attendees) {
    try {
      await transport.sendMail({
        from:    getFrom(),
        to:      `"${attendee.name}" <${attendee.email}>`,
        subject: `Cancelled: ${opts.summary}`,
        text:    [
          `Your meeting has been cancelled.`,
          ``,
          `Event: ${opts.summary}`,
          `When:  ${opts.startUtc.toUTCString()}`,
        ].join('\n'),
        alternatives: [{
          contentType: 'text/calendar; method=CANCEL; charset=UTF-8',
          content:     icsContent,
        }],
        attachments: [{
          filename:    'cancel.ics',
          content:     Buffer.from(icsContent),
          contentType: 'application/ics',
        }],
      });
    } catch {
      // Best-effort; caller does not need individual failure tracking for cancels
    }
  }
}

export interface ReminderEmailOpts {
  recipientName: string;
  recipientEmail: string;
  summary: string;
  startUtc: Date;
  offsetMin: number;
  cancelUrl?: string;
  location?: string;
}

export async function sendReminderEmail(opts: ReminderEmailOpts): Promise<void> {
  const transport = createTransport();
  const hoursLabel = opts.offsetMin >= 60
    ? `${Math.round(opts.offsetMin / 60)} hour${opts.offsetMin >= 120 ? 's' : ''}`
    : `${opts.offsetMin} minute${opts.offsetMin !== 1 ? 's' : ''}`;

  await transport.sendMail({
    from:    getFrom(),
    to:      `"${opts.recipientName}" <${opts.recipientEmail}>`,
    subject: `Reminder: ${opts.summary} in ${hoursLabel}`,
    text:    [
      `This is a reminder about your upcoming meeting.`,
      ``,
      `Event:    ${opts.summary}`,
      `When:     ${opts.startUtc.toUTCString()}`,
      opts.location ? `Where:    ${opts.location}` : '',
      ``,
      opts.cancelUrl ? `To cancel: ${opts.cancelUrl}` : '',
    ].filter(l => l !== undefined && l !== '').join('\n'),
  });
}

export interface SendCancelOpts extends ImipBaseOpts {
  /** Additional recipients (notification email, extra guests) to send the CANCEL to. */
  extraRecipients?: { name: string; email: string }[];
}

/**
 * Send a METHOD:CANCEL iMIP notice to the attendee and any extra recipients.
 * Uses same UID + bumped SEQUENCE so mail clients retract the event.
 */
export async function sendCancelEmail(opts: SendCancelOpts): Promise<void> {
  const transport = createTransport();
  const icsContent = generateCancelIcs(opts);

  const buildMail = (toName: string, toEmail: string) => ({
    from:    getFrom(),
    to:      `"${toName}" <${toEmail}>`,
    subject: `Cancelled: ${opts.summary}`,
    text:    [
      `Your meeting has been cancelled.`,
      ``,
      `Event: ${opts.summary}`,
      `When:  ${opts.startUtc.toUTCString()}`,
    ].join('\n'),
    alternatives: [{
      contentType: 'text/calendar; method=CANCEL; charset=UTF-8',
      content:     icsContent,
    }],
    attachments: [{
      filename:    'cancel.ics',
      content:     Buffer.from(icsContent),
      contentType: 'application/ics',
    }],
  });

  await transport.sendMail(buildMail(opts.attendeeName, opts.attendeeEmail));

  for (const r of opts.extraRecipients ?? []) {
    try {
      await transport.sendMail(buildMail(r.name, r.email));
    } catch { /* best-effort */ }
  }
}
