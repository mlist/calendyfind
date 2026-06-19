import type { writeTarget } from '@/lib/db/schema';

export type WriteTargetRow = typeof writeTarget.$inferSelect;

export interface NewEvent {
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
  createdAt: Date;
}

export interface CalendarWriteAdapter {
  createEvent(target: WriteTargetRow, event: NewEvent): Promise<{ externalRef: string }>;
  cancelEvent(target: WriteTargetRow, externalRef: string, uid: string, sequence: number): Promise<void>;
}
