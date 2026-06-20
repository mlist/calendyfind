'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { user as userTable } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { getFreeSlots } from '@/lib/availability';
import { checkHoldLimit } from '@/lib/rate-limit';
import { createHold, getPageByToken } from '@/lib/booking/holds';
import { appendAudit } from '@/lib/audit';

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function holdAction(token: string, formData: FormData) {
  const hdrs = await headers();
  const ip = hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() ?? hdrs.get('x-real-ip') ?? 'unknown';

  const attendeeEmail = (formData.get('attendeeEmail') as string)?.trim() ?? '';

  const rlResult = checkHoldLimit(ip, token, attendeeEmail);
  if (!rlResult.allowed) {
    appendAudit(db, { actor: 'public', action: 'rate_limit.blocked', ip, metadata: { endpoint: 'hold', token } });
    redirect(`/b/${token}?error=Too+many+requests.+Try+again+in+a+minute.`);
  }

  const slotIso      = (formData.get('slot') as string)?.trim();
  const attendeeName  = (formData.get('attendeeName') as string)?.trim();
  const visitorTz    = (formData.get('tz') as string)?.trim() || '';

  if (!slotIso || !attendeeName || !attendeeEmail) {
    redirect(`/b/${token}?error=All+fields+are+required`);
  }
  if (!isValidEmail(attendeeEmail)) {
    redirect(`/b/${token}?error=Invalid+email+address`);
  }

  const page = getPageByToken(db, token);
  if (!page || !page.active) redirect(`/b/${token}?error=Page+not+available`);

  // Validate chosen duration against the page's allowed options.
  const { parseDurationOptions } = await import('@/lib/booking/holds');
  const allowedDurations = parseDurationOptions(page.durationOptions);
  const rawDuration = Number(formData.get('duration'));
  const durationMin = allowedDurations.includes(rawDuration) ? rawDuration : allowedDurations[0];

  const now      = new Date();
  const slotStart = new Date(slotIso);
  if (isNaN(slotStart.getTime())) redirect(`/b/${token}?error=Invalid+slot`);

  const rangeFrom = new Date(now.getTime() + page.minNoticeMin * 60_000);
  const rangeTo   = new Date(now.getTime() + page.maxAdvanceDays * 86_400_000);

  // Server-side recomputation — never trust the client's claim that a slot is free
  const { slots } = await getFreeSlots({
    userIds: [page.userId],
    range: { from: rangeFrom, to: rangeTo },
    durationMin,
    bufferMin: page.bufferMin,
    minNoticeMin: page.minNoticeMin,
    now,
  });

  const validSlotStartMs = new Set(slots.map(s => s.start.getTime()));

  const result = createHold(db, { page, durationMin, validSlotStartMs, slotStart, attendeeName, attendeeEmail, now });

  if (!result.ok) {
    const msg = result.reason === 'SLOT_TAKEN'
      ? 'That+slot+was+just+taken.+Please+choose+another.'
      : 'Invalid+slot+selection.';
    redirect(`/b/${token}?error=${msg}`);
  }

  const tzParam = visitorTz ? `?tz=${encodeURIComponent(visitorTz)}` : '';
  redirect(`/b/${token}/confirm/${result.holdId}${tzParam}`);
}
