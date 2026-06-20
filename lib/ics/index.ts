// ICS generation: METHOD:PUBLISH (download), METHOD:REQUEST (iMIP invite), METHOD:CANCEL.

function icsDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

// RFC 5545 §3.1: fold lines longer than 75 octets (CRLF + SPACE continuation)
function foldLine(line: string): string {
  if (Buffer.byteLength(line, 'utf-8') <= 75) return line;
  const out: string[] = [];
  let i = 0;
  let budget = 75;
  while (i < line.length) {
    // Take up to `budget` bytes (careful with multi-byte chars)
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
    budget = 74; // continuation lines start with a space (1 byte overhead)
  }
  return out.join('\r\n ');
}

function prop(name: string, value: string): string {
  return foldLine(`${name}:${value}`);
}

function escapePropValue(v: string): string {
  return v
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

export interface PublishIcsOpts {
  uid: string;
  startUtc: Date;
  endUtc: Date;
  summary: string;
  location?: string;
  organizerName: string;
  organizerEmail: string;
  attendeeName: string;
  attendeeEmail: string;
  createdAt: Date;
  now: Date;
}

export function generatePublishIcs(opts: PublishIcsOpts): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    prop('VERSION', '2.0'),
    prop('PRODID', '-//CalendyFind//Booking//EN'),
    prop('METHOD', 'PUBLISH'),
    'BEGIN:VEVENT',
    prop('UID', escapePropValue(opts.uid)),
    prop('DTSTART', icsDate(opts.startUtc)),
    prop('DTEND', icsDate(opts.endUtc)),
    prop('SUMMARY', escapePropValue(opts.summary)),
  ];

  if (opts.location) {
    lines.push(foldLine(`LOCATION:${escapePropValue(opts.location)}`));
  }

  lines.push(
    foldLine(`ORGANIZER;CN="${escapePropValue(opts.organizerName)}":mailto:${opts.organizerEmail}`),
    foldLine(`ATTENDEE;CN="${escapePropValue(opts.attendeeName)}";ROLE=REQ-PARTICIPANT:mailto:${opts.attendeeEmail}`),
    prop('CREATED', icsDate(opts.createdAt)),
    prop('DTSTAMP', icsDate(opts.now)),
    prop('SEQUENCE', '0'),
    prop('STATUS', 'CONFIRMED'),
    prop('TRANSP', 'OPAQUE'),
    'END:VEVENT',
    'END:VCALENDAR',
  );

  return lines.join('\r\n') + '\r\n';
}

// ─── Shared iMIP base opts ────────────────────────────────────────────────────

export interface ImipBaseOpts {
  uid: string;
  sequence: number;
  startUtc: Date;
  endUtc: Date;
  summary: string;
  location?: string;
  organizerName: string;
  organizerEmail: string;
  attendeeName: string;
  attendeeEmail: string;
  /** Extra attendees (notification email, extra guests) included as ATTENDEE lines. */
  extraAttendees?: { name: string; email: string }[];
  createdAt: Date;
  now: Date;
}

// ─── METHOD:REQUEST ───────────────────────────────────────────────────────────
// Used in iMIP invite emails. ATTENDEE must have RSVP=TRUE and PARTSTAT=NEEDS-ACTION
// so mail clients render an Accept/Decline UI.

export function generateRequestIcs(opts: ImipBaseOpts): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    prop('VERSION', '2.0'),
    prop('PRODID', '-//CalendyFind//Booking//EN'),
    prop('METHOD', 'REQUEST'),
    'BEGIN:VEVENT',
    prop('UID', escapePropValue(opts.uid)),
    prop('DTSTART', icsDate(opts.startUtc)),
    prop('DTEND', icsDate(opts.endUtc)),
    prop('SUMMARY', escapePropValue(opts.summary)),
  ];

  if (opts.location) {
    lines.push(foldLine(`LOCATION:${escapePropValue(opts.location)}`));
  }

  lines.push(
    foldLine(`ORGANIZER;CN="${escapePropValue(opts.organizerName)}":mailto:${opts.organizerEmail}`),
    foldLine(
      `ATTENDEE;CN="${escapePropValue(opts.attendeeName)}";ROLE=REQ-PARTICIPANT;` +
      `RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:${opts.attendeeEmail}`,
    ),
  );

  for (const extra of opts.extraAttendees ?? []) {
    lines.push(foldLine(
      `ATTENDEE;CN="${escapePropValue(extra.name)}";ROLE=REQ-PARTICIPANT;` +
      `RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:${extra.email}`,
    ));
  }

  lines.push(
    prop('CREATED',  icsDate(opts.createdAt)),
    prop('DTSTAMP',  icsDate(opts.now)),
    prop('SEQUENCE', String(opts.sequence)),
    prop('STATUS',   'CONFIRMED'),
    prop('TRANSP',   'OPAQUE'),
    'END:VEVENT',
    'END:VCALENDAR',
  );

  return lines.join('\r\n') + '\r\n';
}

// ─── Multi-attendee METHOD:REQUEST ───────────────────────────────────────────
// Used for internal meetings with multiple attendees. One ICS is generated
// containing all ATTENDEE lines; it is then sent to each attendee individually.

export interface MultiImipAttendee {
  name: string;
  email: string;
}

export interface MultiImipOpts {
  uid: string;
  sequence: number;
  startUtc: Date;
  endUtc: Date;
  summary: string;
  location?: string;
  organizerName: string;
  organizerEmail: string;
  attendees: MultiImipAttendee[];
  createdAt: Date;
  now: Date;
}

export function generateMultiRequestIcs(opts: MultiImipOpts): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    prop('VERSION', '2.0'),
    prop('PRODID', '-//CalendyFind//Booking//EN'),
    prop('METHOD', 'REQUEST'),
    'BEGIN:VEVENT',
    prop('UID', escapePropValue(opts.uid)),
    prop('DTSTART', icsDate(opts.startUtc)),
    prop('DTEND', icsDate(opts.endUtc)),
    prop('SUMMARY', escapePropValue(opts.summary)),
  ];

  if (opts.location) {
    lines.push(foldLine(`LOCATION:${escapePropValue(opts.location)}`));
  }

  lines.push(
    foldLine(`ORGANIZER;CN="${escapePropValue(opts.organizerName)}":mailto:${opts.organizerEmail}`),
  );

  for (const attendee of opts.attendees) {
    lines.push(
      foldLine(
        `ATTENDEE;CN="${escapePropValue(attendee.name)}";ROLE=REQ-PARTICIPANT;` +
        `RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:${attendee.email}`,
      ),
    );
  }

  lines.push(
    prop('CREATED',  icsDate(opts.createdAt)),
    prop('DTSTAMP',  icsDate(opts.now)),
    prop('SEQUENCE', String(opts.sequence)),
    prop('STATUS',   'CONFIRMED'),
    prop('TRANSP',   'OPAQUE'),
    'END:VEVENT',
    'END:VCALENDAR',
  );

  return lines.join('\r\n') + '\r\n';
}

// ─── Multi-attendee METHOD:CANCEL ─────────────────────────────────────────────

export function generateMultiCancelIcs(opts: MultiImipOpts): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    prop('VERSION', '2.0'),
    prop('PRODID', '-//CalendyFind//Booking//EN'),
    prop('METHOD', 'CANCEL'),
    'BEGIN:VEVENT',
    prop('UID',     escapePropValue(opts.uid)),
    prop('DTSTART', icsDate(opts.startUtc)),
    prop('DTEND',   icsDate(opts.endUtc)),
    prop('SUMMARY', escapePropValue(opts.summary)),
    foldLine(`ORGANIZER;CN="${escapePropValue(opts.organizerName)}":mailto:${opts.organizerEmail}`),
  ];

  for (const attendee of opts.attendees) {
    lines.push(foldLine(`ATTENDEE;CN="${escapePropValue(attendee.name)}":mailto:${attendee.email}`));
  }

  lines.push(
    prop('DTSTAMP',  icsDate(opts.now)),
    prop('SEQUENCE', String(opts.sequence)),
    prop('STATUS',   'CANCELLED'),
    'END:VEVENT',
    'END:VCALENDAR',
  );

  return lines.join('\r\n') + '\r\n';
}

// ─── METHOD:CANCEL ────────────────────────────────────────────────────────────
// Must carry the same UID, a bumped SEQUENCE, and STATUS:CANCELLED.

export function generateCancelIcs(opts: ImipBaseOpts): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    prop('VERSION', '2.0'),
    prop('PRODID', '-//CalendyFind//Booking//EN'),
    prop('METHOD', 'CANCEL'),
    'BEGIN:VEVENT',
    prop('UID',      escapePropValue(opts.uid)),
    prop('DTSTART',  icsDate(opts.startUtc)),
    prop('DTEND',    icsDate(opts.endUtc)),
    prop('SUMMARY',  escapePropValue(opts.summary)),
    foldLine(`ORGANIZER;CN="${escapePropValue(opts.organizerName)}":mailto:${opts.organizerEmail}`),
    foldLine(`ATTENDEE;CN="${escapePropValue(opts.attendeeName)}":mailto:${opts.attendeeEmail}`),
  ];

  for (const extra of opts.extraAttendees ?? []) {
    lines.push(foldLine(`ATTENDEE;CN="${escapePropValue(extra.name)}":mailto:${extra.email}`));
  }

  lines.push(
    prop('DTSTAMP',  icsDate(opts.now)),
    prop('SEQUENCE', String(opts.sequence)),
    prop('STATUS',   'CANCELLED'),
    'END:VEVENT',
    'END:VCALENDAR',
  );

  return lines.join('\r\n') + '\r\n';
}
