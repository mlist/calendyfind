'use server';

import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { availabilitySource } from '@/lib/db/schema';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { eq, and } from 'drizzle-orm';
import { isValidUrl } from '@/lib/validation';

async function requireSession() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');
  return session;
}

export async function addSourceAction(formData: FormData) {
  const session = await requireSession();

  const label = (formData.get('label') as string)?.trim();
  const icsUrl = (formData.get('icsUrl') as string)?.trim();

  if (!label) redirect('/settings/sources?error=Label+is+required');
  if (!icsUrl || !isValidUrl(icsUrl)) redirect('/settings/sources?error=Invalid+URL+(must+be+http%2C+https%2C+or+webcal)');

  await db.insert(availabilitySource).values({
    id: crypto.randomUUID(),
    userId: session.user.id,
    label,
    icsUrl,
  });

  revalidatePath('/settings/sources');
  redirect('/settings/sources?success=Source+added');
}

export async function deleteSourceAction(formData: FormData) {
  const session = await requireSession();
  const id = formData.get('id') as string;

  // Ownership enforced: only delete if the source belongs to the current user
  await db
    .delete(availabilitySource)
    .where(and(eq(availabilitySource.id, id), eq(availabilitySource.userId, session.user.id)));

  revalidatePath('/settings/sources');
  redirect('/settings/sources?success=Source+deleted');
}
