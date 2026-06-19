import { describe, it, expect } from 'vitest';
import { generateRequestIcs, generateCancelIcs } from '@/lib/ics';

const BASE: Parameters<typeof generateRequestIcs>[0] = {
  uid:            'test-uid-1234@calendyfind.local',
  sequence:       0,
  startUtc:       new Date('2024-06-15T10:00:00Z'),
  endUtc:         new Date('2024-06-15T10:30:00Z'),
  summary:        'Test Meeting',
  organizerName:  'Alice Organizer',
  organizerEmail: 'alice@example.com',
  attendeeName:   'Bob Attendee',
  attendeeEmail:  'bob@example.com',
  createdAt:      new Date('2024-06-01T09:00:00Z'),
  now:            new Date('2024-06-15T09:00:00Z'),
};

describe('generateRequestIcs (METHOD:REQUEST)', () => {
  it('contains METHOD:REQUEST', () => {
    const ics = generateRequestIcs(BASE);
    expect(ics).toContain('METHOD:REQUEST');
  });

  it('ATTENDEE line has RSVP=TRUE', () => {
    const ics = generateRequestIcs(BASE);
    expect(ics).toMatch(/ATTENDEE[^:\r\n]*RSVP=TRUE/);
  });

  it('ATTENDEE line has PARTSTAT=NEEDS-ACTION', () => {
    const ics = generateRequestIcs(BASE);
    // RFC 5545 requires folding long lines (CRLF + space continuation).
    // Unfold before asserting so the check works regardless of where the fold falls.
    const unfolded = ics.replace(/\r\n[ \t]/g, '');
    expect(unfolded).toContain('PARTSTAT=NEEDS-ACTION');
  });

  it('ATTENDEE mailto matches attendeeEmail', () => {
    const ics = generateRequestIcs(BASE);
    expect(ics).toContain('mailto:bob@example.com');
  });

  it('ORGANIZER mailto matches organizerEmail', () => {
    const ics = generateRequestIcs(BASE);
    expect(ics).toContain('mailto:alice@example.com');
  });

  it('contains the UID', () => {
    const ics = generateRequestIcs(BASE);
    expect(ics).toContain('UID:test-uid-1234@calendyfind.local');
  });

  it('SEQUENCE is correct', () => {
    const ics = generateRequestIcs({ ...BASE, sequence: 3 });
    expect(ics).toContain('SEQUENCE:3');
  });

  it('uses CRLF line endings', () => {
    const ics = generateRequestIcs(BASE);
    expect(ics).toContain('\r\n');
  });
});

describe('generateCancelIcs (METHOD:CANCEL)', () => {
  it('contains METHOD:CANCEL', () => {
    const ics = generateCancelIcs(BASE);
    expect(ics).toContain('METHOD:CANCEL');
  });

  it('STATUS is CANCELLED', () => {
    const ics = generateCancelIcs(BASE);
    expect(ics).toContain('STATUS:CANCELLED');
  });

  it('carries the same UID', () => {
    const ics = generateCancelIcs(BASE);
    expect(ics).toContain('UID:test-uid-1234@calendyfind.local');
  });

  it('SEQUENCE matches input (caller must bump before calling)', () => {
    const ics = generateCancelIcs({ ...BASE, sequence: 2 });
    expect(ics).toContain('SEQUENCE:2');
  });

  it('ORGANIZER line present', () => {
    const ics = generateCancelIcs(BASE);
    expect(ics).toContain('mailto:alice@example.com');
  });
});
