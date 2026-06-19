'use server';

import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { writeTarget } from '@/lib/db/schema';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { eq, and } from 'drizzle-orm';
import { encrypt } from '@/lib/crypto';
import { createOAuthState } from '@/lib/crypto';
import { isValidUrl } from '@/lib/validation';

async function requireSession() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');
  return session;
}

// ─── Generic CalDAV write target (Nextcloud, iCloud, Fastmail, etc.) ──────────
// NOTE: Google Calendar does NOT support Basic Auth / app passwords for CalDAV.
// Use "Connect Google Calendar" (OAuth) below for Google accounts.

export async function addCalDavTargetAction(formData: FormData) {
  const session = await requireSession();

  const label       = (formData.get('label') as string)?.trim();
  const username    = (formData.get('username') as string)?.trim();
  const password    = formData.get('password') as string;
  const calendarUrl = (formData.get('calendarUrl') as string)?.trim();

  if (!label) redirect('/settings/targets?error=Label+is+required');
  if (!username) redirect('/settings/targets?error=Username+is+required');
  if (!password) redirect('/settings/targets?error=Password+is+required');
  if (!calendarUrl || !isValidUrl(calendarUrl)) {
    redirect('/settings/targets?error=Invalid+calendar+URL+(must+be+http+or+https)');
  }

  const encryptedCredentials = encrypt(JSON.stringify({ username, password }));

  const existing = db.select({ id: writeTarget.id })
    .from(writeTarget)
    .where(eq(writeTarget.userId, session!.user.id))
    .all();

  db.insert(writeTarget).values({
    id: crypto.randomUUID(),
    userId: session!.user.id,
    label,
    provider: 'caldav',
    encryptedCredentials,
    calendarRef: calendarUrl,
    isDefault: existing.length === 0,
  }).run();

  revalidatePath('/settings/targets');
  redirect('/settings/targets?success=Write+target+added');
}

// ─── Google Calendar OAuth initiation ────────────────────────────────────────
// Builds the Google authorization URL and redirects the browser there.
// The callback is handled by app/api/google-oauth/route.ts.

export async function initiateGoogleOAuthAction(formData: FormData) {
  const session = await requireSession();

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) redirect('/settings/targets?error=GOOGLE_CLIENT_ID+not+configured');

  const base = process.env.BETTER_AUTH_URL ?? 'http://localhost:3000';
  const label       = (formData.get('label') as string)?.trim() || 'Google Calendar';
  const calendarRef = (formData.get('calendarRef') as string)?.trim() || 'primary';

  // Embed label + calendarRef in the signed state so the callback can read them
  // without needing query params on the redirect_uri.
  // redirect_uri must be registered in Google Cloud Console as-is (no query params).
  const state = createOAuthState(session!.user.id, { label, calendarRef });
  const redirectUri = `${base}/api/google-oauth`;

  const params = new URLSearchParams({
    client_id:     clientId!,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         'https://www.googleapis.com/auth/calendar',
    access_type:   'offline',
    prompt:        'consent',   // ensures refresh_token is always returned
    state,
  });

  redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
}

export async function setDefaultTargetAction(formData: FormData) {
  const session = await requireSession();
  const id = formData.get('id') as string;

  const target = db.select({ id: writeTarget.id })
    .from(writeTarget)
    .where(and(eq(writeTarget.id, id), eq(writeTarget.userId, session!.user.id)))
    .get();

  if (!target) redirect('/settings/targets?error=Target+not+found');

  db.update(writeTarget).set({ isDefault: false }).where(eq(writeTarget.userId, session!.user.id)).run();
  db.update(writeTarget).set({ isDefault: true }).where(and(eq(writeTarget.id, id), eq(writeTarget.userId, session!.user.id))).run();

  revalidatePath('/settings/targets');
  redirect('/settings/targets?success=Default+updated');
}

export async function deleteTargetAction(formData: FormData) {
  const session = await requireSession();
  const id = formData.get('id') as string;

  db.delete(writeTarget)
    .where(and(eq(writeTarget.id, id), eq(writeTarget.userId, session!.user.id)))
    .run();

  revalidatePath('/settings/targets');
  redirect('/settings/targets?success=Write+target+deleted');
}
