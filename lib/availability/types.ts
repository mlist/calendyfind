export interface BusyInterval {
  start: Date;
  end: Date;
}

export type FreeInterval = BusyInterval;
export type Slot = BusyInterval;

export type Day = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export interface TimeRange {
  start: string; // HH:MM
  end: string;   // HH:MM
}
export type WorkingHoursConfig = Partial<Record<Day, TimeRange[]>>;
