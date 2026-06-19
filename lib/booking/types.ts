export type BookingStatus = 'pending_hold' | 'confirmed' | 'cancelled';
export type HoldError   = 'INVALID_SLOT' | 'SLOT_TAKEN' | 'PAGE_INACTIVE';
export type ConfirmError = 'NOT_FOUND' | 'EXPIRED' | 'WRONG_PAGE' | 'ALREADY_CONFIRMED';
export type CancelError  = 'NOT_FOUND';
