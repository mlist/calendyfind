import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { freebusyFeed } from '@/lib/db/schema';
import { gatherBusyForFeed } from '@/lib/freebusy/gather';
import { generateFreeBusyIcs } from '@/lib/freebusy/feed';
import { checkFreeBusyLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '0.0.0.0';

  const rl = checkFreeBusyLimit(ip);
  if (!rl.allowed) {
    return new NextResponse(null, {
      status: 429,
      headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) },
    });
  }

  const { token: rawToken } = await params;
  // Strip optional .ics extension so /fb/TOKEN.ics and /fb/TOKEN both work
  const token = rawToken.endsWith('.ics') ? rawToken.slice(0, -4) : rawToken;

  const feed = db.select().from(freebusyFeed)
    .where(eq(freebusyFeed.secretToken, token))
    .get();

  // Generic 404 for unknown OR inactive — never reveal whether a token exists
  if (!feed || !feed.active) {
    return new NextResponse(null, { status: 404 });
  }

  const now        = new Date();
  const pastDays   = Number(process.env.FREEBUSY_PAST_DAYS   ?? '7');
  const futureDays = Number(process.env.FREEBUSY_FUTURE_DAYS ?? '90');
  const range = {
    from: new Date(now.getTime() - pastDays   * 86_400_000),
    to:   new Date(now.getTime() + futureDays * 86_400_000),
  };

  const busy    = await gatherBusyForFeed(db, feed.userId, range, now);
  const icsText = generateFreeBusyIcs(busy, now);

  return new NextResponse(icsText, {
    headers: {
      'Content-Type':        'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="freebusy.ics"',
      'Cache-Control':       'public, max-age=900',
      'X-Published-TTL':     'PT15M',
    },
  });
}
