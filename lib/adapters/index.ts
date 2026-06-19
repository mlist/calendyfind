import type { CalendarWriteAdapter } from './interface';
import { googleAdapter } from './google';

export type { CalendarWriteAdapter, WriteTargetRow, NewEvent } from './interface';

export function getAdapter(provider: 'caldav' | 'msgraph' | 'google'): CalendarWriteAdapter {
  if (provider === 'google') return googleAdapter;
  throw new Error(`No adapter implemented for provider "${provider}" yet`);
}
