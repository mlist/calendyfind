import { DateTime } from 'luxon';

export type ParsedSlot =
  | { ok: true;  start: Date; end: Date; interpretedAs: string; raw: string }
  | { ok: false; raw: string; error: string };

/**
 * Parses a single slot line into a ParsedSlot.
 *
 * Supported format: YYYY-MM-DD HH:MM-HH:MM  (24h clock, same-day implied)
 * Tolerates: spaces around the dash, en-dash (–), em-dash (—).
 * If end time ≤ start time on the same date, assumes midnight wrap (+1 day).
 *
 * Always echoes back how the line was interpreted (interpretedAs field) so
 * misparses can be caught. Unparseable lines return ok:false with an error
 * message — they are NEVER silently skipped or guessed.
 */
export function parseSlotLine(line: string, tz: string): ParsedSlot {
  const raw = line;
  const trimmed = line.trim();

  if (!trimmed || trimmed.startsWith('#')) {
    return { ok: false, raw, error: 'empty or comment' };
  }

  // Match: YYYY-MM-DD HH:MM[-HH:MM]  (HH may be 1 or 2 digits; seconds optional)
  const match = trimmed.match(
    /^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})(?::\d{2})?\s*[-–—]\s*(\d{1,2}:\d{2})(?::\d{2})?$/,
  );

  if (!match) {
    return {
      ok: false,
      raw,
      error: `Cannot parse "${trimmed}" — expected format: YYYY-MM-DD HH:MM-HH:MM`,
    };
  }

  const [, datePart, startTimeStr, endTimeStr] = match;

  const parseAt = (date: string, time: string): DateTime => {
    const [year, month, day] = date.split('-').map(Number);
    const [hour, minute]     = time.split(':').map(Number);
    return DateTime.fromObject({ year, month, day, hour, minute, second: 0 }, { zone: tz });
  };

  const startDt = parseAt(datePart, startTimeStr);
  let   endDt   = parseAt(datePart, endTimeStr);

  if (!startDt.isValid) {
    return { ok: false, raw, error: `Invalid date/time: ${startDt.invalidReason}` };
  }
  if (!endDt.isValid) {
    return { ok: false, raw, error: `Invalid date/time: ${endDt.invalidReason}` };
  }

  // If end ≤ start, assume midnight wrap
  if (endDt <= startDt) {
    endDt = endDt.plus({ days: 1 });
  }

  const start = startDt.toJSDate();
  const end   = endDt.toJSDate();

  const fmt = (dt: DateTime) =>
    dt.toISO({ suppressMilliseconds: true }) ?? dt.toJSDate().toISOString();

  const interpretedAs =
    `${fmt(startDt)} → ${fmt(endDt)} (${tz})`;

  return { ok: true, start, end, interpretedAs, raw };
}

/**
 * Parses all non-empty lines from a textarea blob.
 * Blank lines are silently dropped; comment lines (starting with #) are flagged as ok:false.
 */
export function parseSlotLines(text: string, tz: string): ParsedSlot[] {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(line => parseSlotLine(line, tz));
}
