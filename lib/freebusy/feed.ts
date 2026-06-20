import type { BusyInterval } from '@/lib/availability/types';

// RFC 5545 §3.1: fold lines longer than 75 octets (CRLF + SPACE continuation).
function foldLine(line: string): string {
  if (Buffer.byteLength(line, 'utf-8') <= 75) return line;
  const out: string[] = [];
  let i = 0;
  let budget = 75;
  while (i < line.length) {
    let chunk = '';
    let bytes = 0;
    while (i < line.length) {
      const cp = line.codePointAt(i)!;
      const char = String.fromCodePoint(cp);
      const charBytes = Buffer.byteLength(char, 'utf-8');
      if (bytes + charBytes > budget) break;
      chunk += char;
      bytes += charBytes;
      i += char.length;
    }
    out.push(chunk);
    budget = 74;
  }
  return out.join('\r\n ');
}

function prop(name: string, value: string): string {
  return foldLine(`${name}:${value}`);
}

function icsDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

/**
 * Generates a VCALENDAR with one opaque VEVENT per busy interval.
 *
 * Privacy guarantee: each VEVENT contains ONLY:
 *   UID, DTSTART, DTEND, SUMMARY:Busy, CLASS:PRIVATE, TRANSP:OPAQUE, DTSTAMP
 *
 * No ORGANIZER, ATTENDEE, LOCATION, DESCRIPTION, CATEGORIES, or any other
 * property that could identify the owner or the nature of the event.
 */
export function generateFreeBusyIcs(busy: BusyInterval[], now: Date): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    prop('VERSION', '2.0'),
    prop('PRODID', '-//CalendyFind//FreeBusy//EN'),
    prop('METHOD', 'PUBLISH'),
    prop('CALSCALE', 'GREGORIAN'),
    prop('X-PUBLISHED-TTL', 'PT15M'),
  ];

  for (const interval of busy) {
    // Stable UID derived from start+end so the same interval gets the same UID on re-fetch.
    const uid = `fb-${interval.start.getTime()}-${interval.end.getTime()}@calendyfind.local`;
    lines.push(
      'BEGIN:VEVENT',
      prop('UID', uid),
      prop('DTSTART', icsDate(interval.start)),
      prop('DTEND', icsDate(interval.end)),
      prop('SUMMARY', 'Busy'),
      prop('CLASS', 'PRIVATE'),
      prop('TRANSP', 'OPAQUE'),
      prop('DTSTAMP', icsDate(now)),
      'END:VEVENT',
    );
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
