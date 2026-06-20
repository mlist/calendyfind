'use server';

import { randomBytes } from 'node:crypto';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { freebusyFeed } from '@/lib/db/schema';
import { appendAudit } from '@/lib/audit';

function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

async function requireUser() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');
  return session.user;
}

export async function createFeedAction(_formData: FormData) {
  const user = await requireUser();

  const existing = db.select({ id: freebusyFeed.id })
    .from(freebusyFeed)
    .where(eq(freebusyFeed.userId, user.id))
    .get();

  if (existing) redirect('/settings/freebusy?error=A+feed+already+exists+for+your+account');

  const id = crypto.randomUUID();
  db.insert(freebusyFeed).values({ id, userId: user.id, secretToken: generateToken(), active: true }).run();

  appendAudit(db, { actor: user.id, action: 'freebusy_feed.create', targetType: 'freebusy_feed', targetId: id });
  revalidatePath('/settings/freebusy');
  redirect('/settings/freebusy?success=Feed+created');
}

export async function rotateFeedAction(formData: FormData) {
  const user = await requireUser();
  const id   = formData.get('id') as string;

  const feed = db.select({ id: freebusyFeed.id })
    .from(freebusyFeed)
    .where(and(eq(freebusyFeed.id, id), eq(freebusyFeed.userId, user.id)))
    .get();
  if (!feed) redirect('/settings/freebusy?error=Not+found');

  const now = new Date();
  db.update(freebusyFeed)
    .set({ secretToken: generateToken(), lastRotatedAt: now })
    .where(and(eq(freebusyFeed.id, id), eq(freebusyFeed.userId, user.id)))
    .run();

  appendAudit(db, { actor: user.id, action: 'freebusy_feed.rotate', targetType: 'freebusy_feed', targetId: id });
  revalidatePath('/settings/freebusy');
  redirect('/settings/freebusy?success=Token+rotated+%E2%80%94+old+URL+is+now+dead');
}

export async function revokeFeedAction(formData: FormData) {
  const user = await requireUser();
  const id   = formData.get('id') as string;

  db.update(freebusyFeed)
    .set({ active: false })
    .where(and(eq(freebusyFeed.id, id), eq(freebusyFeed.userId, user.id)))
    .run();

  appendAudit(db, { actor: user.id, action: 'freebusy_feed.revoke', targetType: 'freebusy_feed', targetId: id });
  revalidatePath('/settings/freebusy');
  redirect('/settings/freebusy?success=Feed+revoked');
}

export async function reactivateFeedAction(formData: FormData) {
  const user = await requireUser();
  const id   = formData.get('id') as string;

  // Rotate token on reactivation — the old URL must not silently come back alive.
  const now = new Date();
  db.update(freebusyFeed)
    .set({ active: true, secretToken: generateToken(), lastRotatedAt: now })
    .where(and(eq(freebusyFeed.id, id), eq(freebusyFeed.userId, user.id)))
    .run();

  appendAudit(db, { actor: user.id, action: 'freebusy_feed.rotate', targetType: 'freebusy_feed', targetId: id });
  revalidatePath('/settings/freebusy');
  redirect('/settings/freebusy?success=Feed+reactivated+with+new+URL');
}
