import type { BusyInterval } from './types';

export function mergeIntervals(intervals: BusyInterval[]): BusyInterval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: BusyInterval[] = [{ start: new Date(sorted[0].start), end: new Date(sorted[0].end) }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const cur = sorted[i];
    if (cur.start.getTime() <= last.end.getTime()) {
      if (cur.end.getTime() > last.end.getTime()) last.end = new Date(cur.end);
    } else {
      merged.push({ start: new Date(cur.start), end: new Date(cur.end) });
    }
  }
  return merged;
}

export function subtractIntervals(
  base: BusyInterval[],
  toRemove: BusyInterval[],
): BusyInterval[] {
  if (toRemove.length === 0) return base.map(b => ({ start: new Date(b.start), end: new Date(b.end) }));
  const remove = mergeIntervals(toRemove);
  const result: BusyInterval[] = [];

  for (const b of base) {
    let cur = b.start.getTime();
    const bEnd = b.end.getTime();

    for (const r of remove) {
      const rStart = r.start.getTime();
      const rEnd = r.end.getTime();
      if (rEnd <= cur) continue;
      if (rStart >= bEnd) break;
      if (rStart > cur) result.push({ start: new Date(cur), end: new Date(rStart) });
      cur = Math.max(cur, rEnd);
    }

    if (cur < bEnd) result.push({ start: new Date(cur), end: new Date(bEnd) });
  }

  return result;
}

export function intersectIntervals(a: BusyInterval[], b: BusyInterval[]): BusyInterval[] {
  const result: BusyInterval[] = [];
  let ai = 0, bi = 0;

  while (ai < a.length && bi < b.length) {
    const start = Math.max(a[ai].start.getTime(), b[bi].start.getTime());
    const end = Math.min(a[ai].end.getTime(), b[bi].end.getTime());
    if (start < end) result.push({ start: new Date(start), end: new Date(end) });
    if (a[ai].end.getTime() <= b[bi].end.getTime()) ai++;
    else bi++;
  }

  return result;
}

export function padIntervals(intervals: BusyInterval[], byMinutes: number): BusyInterval[] {
  if (byMinutes === 0) return intervals.map(i => ({ start: new Date(i.start), end: new Date(i.end) }));
  const ms = byMinutes * 60_000;
  return mergeIntervals(
    intervals.map(i => ({ start: new Date(i.start.getTime() - ms), end: new Date(i.end.getTime() + ms) })),
  );
}
