'use server';

import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { user } from '@/lib/db/schema';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { DAYS, isValidIanaTimezone, isValidHHMM, type WorkingHours } from '@/lib/validation';

async function requireSession() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');
  return session;
}

export async function updateProfileAction(formData: FormData) {
  const session = await requireSession();

  const timezone = (formData.get('timezone') as string)?.trim();
  if (!timezone || !isValidIanaTimezone(timezone)) {
    redirect('/settings?error=Invalid+timezone');
  }

  const workingHours: WorkingHours = {};
  for (const day of DAYS) {
    const enabled = formData.get(`day_${day}_enabled`) === 'on';
    if (!enabled) continue;

    const start = ((formData.get(`day_${day}_start`) as string) || '').trim();
    const end   = ((formData.get(`day_${day}_end`)   as string) || '').trim();

    if (!start || !end) redirect(`/settings?error=Missing+times+for+${day}`);
    if (!isValidHHMM(start) || !isValidHHMM(end))
      redirect(`/settings?error=Invalid+time+format+for+${day}+(use+HH%3AMM)`);
    if (start >= end)
      redirect(`/settings?error=Start+must+be+before+end+for+${day}`);

    const lunchEnabled = formData.get(`day_${day}_lunch_enabled`) === 'on';

    if (lunchEnabled) {
      const lunchStart = ((formData.get(`day_${day}_lunch_start`) as string) || '').trim();
      const lunchEnd   = ((formData.get(`day_${day}_lunch_end`)   as string) || '').trim();

      if (!lunchStart || !lunchEnd)
        redirect(`/settings?error=Missing+lunch+times+for+${day}`);
      if (!isValidHHMM(lunchStart) || !isValidHHMM(lunchEnd))
        redirect(`/settings?error=Invalid+lunch+time+format+for+${day}+(use+HH%3AMM)`);
      if (lunchStart <= start || lunchEnd <= lunchStart || lunchEnd >= end)
        redirect(`/settings?error=Lunch+break+must+fall+inside+working+hours+for+${day}`);

      // Two ranges: morning block + afternoon block
      workingHours[day] = [{ start, end: lunchStart }, { start: lunchEnd, end }];
    } else {
      workingHours[day] = [{ start, end }];
    }
  }

  await db
    .update(user)
    .set({ timezone, workingHours: JSON.stringify(workingHours) })
    .where(eq(user.id, session.user.id));

  revalidatePath('/settings');
  redirect('/settings?success=Profile+saved');
}
