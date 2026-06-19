import { db } from '@/lib/db';
import { availabilitySource } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import type { BusyInterval } from './types';
import { parseIcsToBusyIntervals } from './ics-parser';
import { fetchIcsText } from './fetcher';

const CACHE_TTL_MS = (Number(process.env.ICS_CACHE_TTL_MINUTES ?? '15')) * 60_000;

// Wide parse window so one fetch covers many near-future queries
const PARSE_WINDOW_DAYS = 60;

export interface GatherResult {
  busy: BusyInterval[];
  errors: { sourceId: string; label: string; error: string }[];
}

function serialiseBusy(busy: BusyInterval[]): string {
  return JSON.stringify(busy.map(b => ({ s: b.start.toISOString(), e: b.end.toISOString() })));
}

function deserialiseBusy(raw: string): BusyInterval[] {
  const arr = JSON.parse(raw) as { s: string; e: string }[];
  return arr.map(x => ({ start: new Date(x.s), end: new Date(x.e) }));
}

function filterToRange(busy: BusyInterval[], range: { from: Date; to: Date }): BusyInterval[] {
  return busy.filter(b => b.end.getTime() > range.from.getTime() && b.start.getTime() < range.to.getTime());
}

export async function gatherBusyForUser(
  userId: string,
  range: { from: Date; to: Date },
  now: Date,
  userTimezone: string,
): Promise<GatherResult> {
  const sources = await db.select().from(availabilitySource).where(eq(availabilitySource.userId, userId));

  const allBusy: BusyInterval[] = [];
  const errors: { sourceId: string; label: string; error: string }[] = [];

  // Wide range so the cache remains useful across queries
  const parseRange = {
    from: new Date(now.getTime() - 7 * 86_400_000),
    to:   new Date(now.getTime() + PARSE_WINDOW_DAYS * 86_400_000),
  };

  for (const src of sources) {
    const cacheAge   = now.getTime() - (src.lastFetchedAt?.getTime() ?? 0);
    const cacheValid = cacheAge < CACHE_TTL_MS && src.cachedBusy !== null && !src.fetchError;

    if (cacheValid && src.cachedBusy) {
      try {
        allBusy.push(...filterToRange(deserialiseBusy(src.cachedBusy), range));
        continue;
      } catch {
        // corrupt cache, fall through to re-fetch
      }
    }

    let fetchError: string | null = null;
    let freshBusy: BusyInterval[] | null = null;

    try {
      const icsText = await fetchIcsText(src.icsUrl);
      freshBusy = parseIcsToBusyIntervals(icsText, parseRange, userTimezone);
    } catch (e) {
      fetchError = e instanceof Error ? e.message : String(e);
    }

    if (freshBusy !== null) {
      // Update cache
      await db.update(availabilitySource).set({
        lastFetchedAt: now,
        cachedBusy:   serialiseBusy(freshBusy),
        fetchError:   null,
      }).where(eq(availabilitySource.id, src.id));

      allBusy.push(...filterToRange(freshBusy, range));
      continue;
    }

    // Fetch/parse failed — record error
    await db.update(availabilitySource).set({ fetchError, lastFetchedAt: now })
      .where(eq(availabilitySource.id, src.id));

    // Try stale cache first (better than blocking the full range)
    if (src.cachedBusy) {
      try {
        allBusy.push(...filterToRange(deserialiseBusy(src.cachedBusy), range));
        errors.push({ sourceId: src.id, label: src.label, error: `${fetchError} (using stale cache)` });
        continue;
      } catch {
        // stale cache also corrupt, fall through to fail-closed
      }
    }

    // No usable data at all — fail-closed: block the entire requested range
    allBusy.push({ start: range.from, end: range.to });
    errors.push({ sourceId: src.id, label: src.label, error: `${fetchError} (blocking full range — fail-closed)` });
  }

  return { busy: allBusy, errors };
}
