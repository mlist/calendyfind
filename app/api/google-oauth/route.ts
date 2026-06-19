/**
 * Google OAuth 2.0 callback handler.
 *
 * Flow:
 *   1. User clicks "Connect Google Calendar" in settings → initiateGoogleOAuthAction
 *      builds the auth URL with a signed state token and redirects (server action).
 *   2. Google redirects back here with ?code=...&state=...
 *   3. We verify state (HMAC + TTL), exchange code for tokens, store refresh token
 *      encrypted in a new write_target row, redirect to /settings/targets.
 *
 * Redirect URI to register in Google Cloud Console:
 *   {BETTER_AUTH_URL}/api/google-oauth   (GET)
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { headers } from 'next/headers';
import { db } from '@/lib/db';
import { writeTarget } from '@/lib/db/schema';
import { encrypt } from '@/lib/crypto';
import { verifyOAuthState } from '@/lib/crypto';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export async function GET(req: NextRequest) {
  const base = process.env.BETTER_AUTH_URL ?? 'http://localhost:3000';
  const fail = (msg: string) =>
    NextResponse.redirect(`${base}/settings/targets?error=${encodeURIComponent(msg)}`);

  const { searchParams } = req.nextUrl;
  const code  = searchParams.get('code');
  const state = searchParams.get('state');
  const oauthError = searchParams.get('error');

  if (oauthError) return fail(`Google OAuth error: ${oauthError}`);
  if (!code || !state)  return fail('Missing code or state from Google');

  // Verify CSRF state
  const stateData = verifyOAuthState(state);
  if (!stateData) return fail('Invalid or expired OAuth state — please try again');

  // Verify the session still belongs to the same user
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session || session.user.id !== stateData.userId) {
    return fail('Session mismatch — please log in and try again');
  }

  // Exchange code for tokens
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return fail('GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET not configured');

  // redirect_uri must exactly match the registered URI in Google Cloud Console — no query params.
  const redirectUri = `${base}/api/google-oauth`;

  let tokenResp: Response;
  try {
    tokenResp = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     clientId,
        client_secret: clientSecret,
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code',
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return fail('Could not reach Google token endpoint');
  }

  if (!tokenResp.ok) {
    const body = await tokenResp.text();
    return fail(`Google token exchange failed: ${body.slice(0, 200)}`);
  }

  const tokens = await tokenResp.json() as { refresh_token?: string; access_token?: string };
  if (!tokens.refresh_token) {
    return fail('No refresh_token returned — ensure access_type=offline and prompt=consent were set');
  }

  // label + calendarRef were embedded in the signed state by initiateGoogleOAuthAction
  const label       = stateData.label       ?? 'Google Calendar';
  const calendarRef = stateData.calendarRef ?? 'primary';

  const encryptedCredentials = encrypt(JSON.stringify({ refreshToken: tokens.refresh_token }));

  // Check for existing google target for this user (update rather than duplicate)
  const existing = db.select({ id: writeTarget.id })
    .from(writeTarget)
    .where(eq(writeTarget.userId, session.user.id))
    .all()
    .find(t => {
      const row = db.select().from(writeTarget).where(eq(writeTarget.id, t.id)).get();
      return row?.provider === 'google';
    });

  if (existing) {
    db.update(writeTarget)
      .set({ encryptedCredentials, calendarRef, label })
      .where(eq(writeTarget.id, existing.id))
      .run();
  } else {
    const allTargets = db.select({ id: writeTarget.id })
      .from(writeTarget)
      .where(eq(writeTarget.userId, session.user.id))
      .all();

    db.insert(writeTarget).values({
      id: randomUUID(),
      userId: session.user.id,
      label,
      provider: 'google',
      encryptedCredentials,
      calendarRef,
      isDefault: allTargets.length === 0,
      createdAt: new Date(),
    }).run();
  }

  return NextResponse.redirect(`${base}/settings/targets?success=Google+Calendar+connected`);
}
