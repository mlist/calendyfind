import { describe, it, expect } from 'vitest';
import { mergeIntervals, subtractIntervals, intersectIntervals, padIntervals } from '../../lib/availability/intervals';
import type { BusyInterval } from '../../lib/availability/types';

function iv(startIso: string, endIso: string): BusyInterval {
  return { start: new Date(startIso), end: new Date(endIso) };
}

describe('mergeIntervals', () => {
  it('returns empty for empty input', () => {
    expect(mergeIntervals([])).toEqual([]);
  });

  it('merges two overlapping intervals', () => {
    const result = mergeIntervals([iv('2024-01-15T09:00Z', '2024-01-15T12:00Z'), iv('2024-01-15T11:00Z', '2024-01-15T14:00Z')]);
    expect(result).toHaveLength(1);
    expect(result[0].start.toISOString()).toBe('2024-01-15T09:00:00.000Z');
    expect(result[0].end.toISOString()).toBe('2024-01-15T14:00:00.000Z');
  });

  it('merges adjacent intervals (touching boundary)', () => {
    const result = mergeIntervals([iv('2024-01-15T09:00Z', '2024-01-15T12:00Z'), iv('2024-01-15T12:00Z', '2024-01-15T14:00Z')]);
    expect(result).toHaveLength(1);
  });

  it('keeps disjoint intervals separate', () => {
    const result = mergeIntervals([iv('2024-01-15T09:00Z', '2024-01-15T10:00Z'), iv('2024-01-15T11:00Z', '2024-01-15T12:00Z')]);
    expect(result).toHaveLength(2);
  });

  it('merges overlapping + adjacent chain into one', () => {
    const result = mergeIntervals([
      iv('2024-01-15T09:00Z', '2024-01-15T12:00Z'),
      iv('2024-01-15T11:00Z', '2024-01-15T14:00Z'),
      iv('2024-01-15T14:00Z', '2024-01-15T16:00Z'),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].start.toISOString()).toBe('2024-01-15T09:00:00.000Z');
    expect(result[0].end.toISOString()).toBe('2024-01-15T16:00:00.000Z');
  });
});

describe('subtractIntervals', () => {
  it('subtracts a busy block from the middle of free time', () => {
    const free = [iv('2024-01-15T08:00Z', '2024-01-15T18:00Z')];
    const busy = [iv('2024-01-15T10:00Z', '2024-01-15T11:00Z')];
    const result = subtractIntervals(free, busy);
    expect(result).toHaveLength(2);
    expect(result[0].start.toISOString()).toBe('2024-01-15T08:00:00.000Z');
    expect(result[0].end.toISOString()).toBe('2024-01-15T10:00:00.000Z');
    expect(result[1].start.toISOString()).toBe('2024-01-15T11:00:00.000Z');
    expect(result[1].end.toISOString()).toBe('2024-01-15T18:00:00.000Z');
  });

  it('returns unchanged when toRemove is empty', () => {
    const free = [iv('2024-01-15T08:00Z', '2024-01-15T18:00Z')];
    expect(subtractIntervals(free, [])).toHaveLength(1);
  });

  it('subtracts multiple busy blocks', () => {
    const free = [iv('2024-01-15T08:00Z', '2024-01-15T18:00Z')];
    const busy = [iv('2024-01-15T09:00Z', '2024-01-15T10:00Z'), iv('2024-01-15T12:00Z', '2024-01-15T13:00Z')];
    const result = subtractIntervals(free, busy);
    expect(result).toHaveLength(3);
  });
});

describe('intersectIntervals', () => {
  it('returns overlap of two overlapping intervals', () => {
    const a = [iv('2024-01-15T08:00Z', '2024-01-15T14:00Z')];
    const b = [iv('2024-01-15T10:00Z', '2024-01-15T18:00Z')];
    const result = intersectIntervals(a, b);
    expect(result).toHaveLength(1);
    expect(result[0].start.toISOString()).toBe('2024-01-15T10:00:00.000Z');
    expect(result[0].end.toISOString()).toBe('2024-01-15T14:00:00.000Z');
  });

  it('returns empty for disjoint intervals', () => {
    const a = [iv('2024-01-15T08:00Z', '2024-01-15T10:00Z')];
    const b = [iv('2024-01-15T11:00Z', '2024-01-15T12:00Z')];
    expect(intersectIntervals(a, b)).toHaveLength(0);
  });
});

describe('padIntervals', () => {
  it('expands each interval by bufferMin on both sides', () => {
    const result = padIntervals([iv('2024-01-15T10:00Z', '2024-01-15T11:00Z')], 15);
    expect(result[0].start.toISOString()).toBe('2024-01-15T09:45:00.000Z');
    expect(result[0].end.toISOString()).toBe('2024-01-15T11:15:00.000Z');
  });

  it('merges two intervals whose padded versions overlap', () => {
    const result = padIntervals([
      iv('2024-01-15T10:00Z', '2024-01-15T11:00Z'),
      iv('2024-01-15T11:10Z', '2024-01-15T12:00Z'),
    ], 15);
    expect(result).toHaveLength(1);
  });

  it('returns identical intervals when byMinutes is 0', () => {
    const orig = [iv('2024-01-15T10:00Z', '2024-01-15T11:00Z')];
    const result = padIntervals(orig, 0);
    expect(result[0].start.getTime()).toBe(orig[0].start.getTime());
  });
});
