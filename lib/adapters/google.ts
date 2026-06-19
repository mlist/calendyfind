/**
 * Google Calendar REST API write adapter.
 *
 * Auth path chosen: Google Calendar REST API with OAuth 2.0 (NOT CalDAV + app password).
 * Reason: Google's CalDAV endpoint explicitly rejects Basic Auth / app passwords and
 * requires OAuth 2.0 Bearer tokens — confirmed in Google's CalDAV v2 documentation.
 * The REST API requires the same OAuth and is simpler (no tsdav dependency needed).
 *
 * Credentials stored encrypted in write_target.encrypted_credentials as JSON:
 *   { "refreshToken": "1//..." }
 * GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are app-level env vars.
 *
 * Note: if the Google Calendar API (OAuth) path is ever replaced with a CalDAV write,
 * CalDAV PUTs do NOT send iMIP invites — the email service in lib/email/ must always
 * be called separately. With sendUpdates='none' on the REST API, same applies.
 */

import { decrypt } from '@/lib/crypto';
import type { CalendarWriteAdapter, NewEvent, WriteTargetRow } from './interface';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

const ALLOWED_HOSTS = new Set(['www.googleapis.com', 'oauth2.googleapis.com']);
const TIMEOUT_MS = 10_000;

export function assertGoogleHost(url: string) {
  const host = new URL(url).hostname;
  if (!ALLOWED_HOSTS.has(host)) {
    throw new Error(`SSRF guard: refusing request to unexpected host ${host}`);
  }
}

export interface GoogleCredentials {
  refreshToken: string;
}

async function getAccessToken(creds: GoogleCredentials): Promise<string> {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set');
  }

  assertGoogleHost(GOOGLE_TOKEN_URL);

  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: creds.refreshToken,
      grant_type:    'refresh_token',
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Google token refresh failed (${resp.status}): ${body}`);
  }

  const data = await resp.json() as { access_token?: string };
  if (!data.access_token) {
    throw new Error('Google token refresh returned no access_token');
  }
  return data.access_token;
}

function parseCredentials(target: WriteTargetRow): GoogleCredentials {
  const raw = decrypt(target.encryptedCredentials);
  const parsed = JSON.parse(raw) as Partial<GoogleCredentials>;
  if (!parsed.refreshToken) {
    throw new Error('Google write target missing refreshToken in credentials');
  }
  return { refreshToken: parsed.refreshToken };
}

export const googleAdapter: CalendarWriteAdapter = {
  async createEvent(target, event) {
    const creds       = parseCredentials(target);
    const accessToken = await getAccessToken(creds);
    const calId       = encodeURIComponent(target.calendarRef);
    const url         = `${GOOGLE_CALENDAR_API}/calendars/${calId}/events?sendUpdates=none`;

    assertGoogleHost(url);

    const body = {
      iCalUID:  event.uid,
      summary:  event.summary,
      location: event.location,
      start: { dateTime: event.startUtc.toISOString(), timeZone: 'UTC' },
      end:   { dateTime: event.endUtc.toISOString(),   timeZone: 'UTC' },
      sequence: event.sequence,
    };

    const resp = await fetch(url, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body:   JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`Google Calendar createEvent failed (${resp.status}): ${errBody}`);
    }

    const data = await resp.json() as { id?: string };
    if (!data.id) {
      throw new Error('Google Calendar createEvent returned no event id');
    }
    return { externalRef: data.id };
  },

  async cancelEvent(target, externalRef, _uid, _sequence) {
    if (!externalRef) return; // nothing to delete

    const creds       = parseCredentials(target);
    const accessToken = await getAccessToken(creds);
    const calId       = encodeURIComponent(target.calendarRef);
    const url         = `${GOOGLE_CALENDAR_API}/calendars/${calId}/events/${encodeURIComponent(externalRef)}?sendUpdates=none`;

    assertGoogleHost(url);

    const resp = await fetch(url, {
      method:  'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
      signal:  AbortSignal.timeout(TIMEOUT_MS),
    });

    // 404 / 410 = already deleted; treat as success
    if (!resp.ok && resp.status !== 404 && resp.status !== 410) {
      const errBody = await resp.text();
      throw new Error(`Google Calendar cancelEvent failed (${resp.status}): ${errBody}`);
    }
  },
};
