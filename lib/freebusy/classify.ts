import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';
import type { BusyInterval } from '@/lib/availability/types';
import { mergeIntervals } from '@/lib/availability/intervals';
import { gatherBusyForFeed } from './gather';

type DB = BetterSQLite3Database<typeof schema>;

export interface Candidate {
  start: Date;
  end: Date;
}

export type SlotStatus = 'free' | 'busy' | 'partial';

export interface ClassifyResult {
  candidate: Candidate;
  status: SlotStatus;
  overlapMs: number;
}

/**
 * Pure: classifies each candidate against a set of (already-merged) busy intervals.
 *
 * free    — no overlap at all
 * busy    — candidate is completely covered by busy intervals
 * partial — candidate overlaps but is not fully covered
 */
export function classifyIntervals(
  busyIntervals: BusyInterval[],
  candidates: Candidate[],
): ClassifyResult[] {
  const merged = mergeIntervals(busyIntervals);

  return candidates.map(c => {
    const cStart = c.start.getTime();
    const cEnd   = c.end.getTime();
    const duration = cEnd - cStart;

    let overlap = 0;
    for (const b of merged) {
      const start = Math.max(cStart, b.start.getTime());
      const end   = Math.min(cEnd, b.end.getTime());
      if (end > start) overlap += end - start;
    }

    let status: SlotStatus;
    if (overlap === 0)             status = 'free';
    else if (overlap >= duration)  status = 'busy';
    else                           status = 'partial';

    return { candidate: c, status, overlapMs: overlap };
  });
}

export interface MultiUserClassifyResult {
  results: ClassifyResult[];
  // Maps userId → whether their busy data was available (false = gather failed, fail-closed)
  userErrors: Map<string, string>;
}

/**
 * Impure: gathers busy for each userId, takes the union, then classifies candidates.
 * A candidate is 'busy' if busy for ANY user (free requires ALL users to be free).
 */
export async function classifyForUsers(
  db: DB,
  userIds: string[],
  candidates: Candidate[],
  range: { from: Date; to: Date },
  now: Date,
): Promise<MultiUserClassifyResult> {
  const allBusy: BusyInterval[] = [];
  const userErrors = new Map<string, string>();

  for (const uid of userIds) {
    try {
      const busy = await gatherBusyForFeed(db, uid, range, now);
      allBusy.push(...busy);
    } catch (e) {
      userErrors.set(uid, e instanceof Error ? e.message : String(e));
      // Fail-closed: treat this user as fully busy for the range
      allBusy.push({ start: range.from, end: range.to });
    }
  }

  const results = classifyIntervals(allBusy, candidates);
  return { results, userErrors };
}
