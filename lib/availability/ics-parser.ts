import ICAL from 'ical.js';
import { DateTime } from 'luxon';
import type { BusyInterval } from './types';
import { mergeIntervals } from './intervals';

function icalTimeToUTC(time: ICAL.Time, fallbackTz: string): Date {
  // Floating time has no timezone — interpret in the owner's timezone
  if ((time.zone as { tzid?: string } | null)?.tzid === 'floating') {
    return DateTime.fromObject(
      { year: time.year, month: time.month, day: time.day, hour: time.hour, minute: time.minute, second: time.second },
      { zone: fallbackTz },
    ).toUTC().toJSDate();
  }
  return time.toJSDate();
}

function alldayStartUTC(date: ICAL.Time, tz: string): Date {
  return DateTime.fromObject({ year: date.year, month: date.month, day: date.day }, { zone: tz })
    .toUTC().toJSDate();
}

function alldayEndUTC(date: ICAL.Time, tz: string): Date {
  // DTEND for all-day is exclusive next-day per RFC 5545
  return DateTime.fromObject({ year: date.year, month: date.month, day: date.day }, { zone: tz })
    .toUTC().toJSDate();
}

function isOpaque(comp: ICAL.Component): boolean {
  const v = comp.getFirstPropertyValue('transp') as string | null;
  return !v || v.toUpperCase() !== 'TRANSPARENT';
}

function isCancelled(comp: ICAL.Component): boolean {
  const v = comp.getFirstPropertyValue('status') as string | null;
  return !!v && v.toUpperCase() === 'CANCELLED';
}

export function parseIcsToBusyIntervals(
  icsText: string,
  range: { from: Date; to: Date },
  fallbackTz: string,
): BusyInterval[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let jcal: any;
  try {
    jcal = ICAL.parse(icsText);
  } catch {
    throw new Error('ICS parse error: invalid data');
  }

  const vcal = new ICAL.Component(jcal);

  // Register all VTIMEZONEs so ical.js converts local times correctly
  for (const vtz of vcal.getAllSubcomponents('vtimezone')) {
    ICAL.TimezoneService.register(vtz);
  }

  const vevents = vcal.getAllSubcomponents('vevent');
  const rangeFromMs = range.from.getTime();
  const rangeToMs   = range.to.getTime();

  // Separate masters from RECURRENCE-ID exceptions, grouped by UID
  const masters    = new Map<string, ICAL.Component>();
  const exceptions = new Map<string, ICAL.Component[]>();

  for (const ve of vevents) {
    const uid = (ve.getFirstPropertyValue('uid') as string | null) ?? '';
    if (ve.getFirstProperty('recurrence-id')) {
      const list = exceptions.get(uid) ?? [];
      list.push(ve);
      exceptions.set(uid, list);
    } else {
      masters.set(uid, ve);
    }
  }

  const busy: BusyInterval[] = [];

  function clip(startMs: number, endMs: number) {
    const s = Math.max(startMs, rangeFromMs);
    const e = Math.min(endMs,   rangeToMs);
    if (s < e) busy.push({ start: new Date(s), end: new Date(e) });
  }

  for (const [uid, masterVevent] of masters) {
    if (!isOpaque(masterVevent) || isCancelled(masterVevent)) continue;

    const masterEvent = new ICAL.Event(masterVevent);
    for (const excVevent of exceptions.get(uid) ?? []) {
      masterEvent.relateException(new ICAL.Event(excVevent));
    }

    if (masterEvent.isRecurring()) {
      const iter = masterEvent.iterator();
      let next: ICAL.Time | null;

      while ((next = iter.next())) {
        const det = masterEvent.getOccurrenceDetails(next);

        // Check TRANSP/STATUS on the specific occurrence component (may be exception)
        const occComp = det.item.component;
        if (!isOpaque(occComp) || isCancelled(occComp)) continue;

        const sd = det.startDate;
        const ed = det.endDate;

        let startMs: number, endMs: number;
        if (sd.isDate) {
          startMs = alldayStartUTC(sd, fallbackTz).getTime();
          endMs   = alldayEndUTC(ed, fallbackTz).getTime();
        } else {
          startMs = icalTimeToUTC(sd, fallbackTz).getTime();
          endMs   = icalTimeToUTC(ed, fallbackTz).getTime();
        }

        if (startMs >= rangeToMs) break;
        if (endMs   <= rangeFromMs) continue;
        clip(startMs, endMs);
      }
    } else {
      const sd = masterEvent.startDate;
      const ed = masterEvent.endDate;

      let startMs: number, endMs: number;
      if (sd.isDate) {
        startMs = alldayStartUTC(sd, fallbackTz).getTime();
        endMs   = alldayEndUTC(ed, fallbackTz).getTime();
      } else {
        startMs = icalTimeToUTC(sd, fallbackTz).getTime();
        endMs   = icalTimeToUTC(ed, fallbackTz).getTime();
      }

      if (endMs <= rangeFromMs || startMs >= rangeToMs) continue;
      clip(startMs, endMs);
    }
  }

  return mergeIntervals(busy);
}
