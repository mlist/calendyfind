import { type NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { headers } from 'next/headers';
import { getFreeSlots } from '@/lib/availability';

export async function GET(req: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    return new NextResponse('Not Found', { status: 404 });
  }

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return new NextResponse('Unauthorized', { status: 401 });

  const sp = req.nextUrl.searchParams;
  const fromStr = sp.get('from') ?? new Date().toISOString().slice(0, 10);
  const toStr   = sp.get('to')   ?? new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const durationMin  = Number(sp.get('durationMin')  ?? '60');
  const bufferMin    = Number(sp.get('bufferMin')    ?? '0');
  const minNoticeMin = Number(sp.get('minNoticeMin') ?? '0');

  const result = await getFreeSlots({
    userIds: [session.user.id],
    range: { from: new Date(fromStr), to: new Date(toStr) },
    durationMin,
    bufferMin,
    minNoticeMin,
    now: new Date(),
  });

  return NextResponse.json({
    ...result,
    slots: result.slots.map(s => ({ start: s.start.toISOString(), end: s.end.toISOString() })),
  });
}
